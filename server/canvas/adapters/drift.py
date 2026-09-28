"""Keeping up with CLI updates (web/docs/cli-adapters.md §6): is the installed version one the
adapter was tested with, and do its logs contain records the adapter does not know?

Two sources, both read-only and local (nothing is uploaded, nothing is run but ``--version``):

- ``probe``: ``<cli> --version`` against the adapter's ``tested`` range, the log's own format
  version, and a sample of recent native logs scanned for record types outside the adapter's
  ``known_types`` (drift) or in its ``gap_types`` (known, not handled yet).
- ``observe``: while Agora follows a session it counts the same thing per CLI (runtime drift).

Degradation is **notify-only** for now (user decision 2026-09-28): the result says which tier the
CLI *would* drop to and why; nothing changes behaviour. ``.agora/agents.toml`` can set
``[<kind>] trust_untested = true`` to accept an untested version (still reported, marked trusted).
"""

from __future__ import annotations

import glob
import json
import os
import sqlite3
import time
import tomllib
from collections import Counter
from pathlib import Path
from typing import Any

from server.canvas.adapters.base import Adapter, Projector, Tier, lower_tier
from server.canvas.adapters.registry import ADAPTERS, cached_version, implemented_tier, info

UNKNOWN_RATIO = 0.05  # unknown records above this share of a log → would degrade
SAMPLE_LOGS = 12  # newest logs per CLI scanned by the probe
SAMPLE_BYTES = 8 * 1024 * 1024  # bytes read per sampled log

# ——— runtime counts (per CLI, since the server started) ———
_runtime: dict[str, dict[str, Any]] = {}


def observe(kind: str, rec: dict[str, Any]) -> None:
    """Count one record Agora followed (sessions.py) against its adapter's vocabulary."""
    a = ADAPTERS.get(kind)
    if a is None or not isinstance(a, Projector):
        return
    t = a.record_type(rec)
    r = _runtime.setdefault(kind, {"records": 0, "unknown": Counter(), "gaps": Counter()})
    r["records"] += 1
    if t is None:
        return
    if t in getattr(a, "gap_types", ()):
        r["gaps"][t] += 1
    elif t not in a.known_types:
        r["unknown"][t] += 1


def runtime(kind: str) -> dict[str, Any] | None:
    r = _runtime.get(kind)
    return {"records": r["records"], "unknown": dict(r["unknown"]), "gaps": dict(r["gaps"])} if r else None


def reset_runtime() -> None:
    _runtime.clear()


# ——— scanning logs ———
def scan(a: Adapter, path: Path, limit: int = SAMPLE_BYTES) -> dict[str, Any]:
    """Record types in one log: how many records, which are unknown to the adapter, which are known gaps."""
    records, unknown, gaps = 0, Counter(), Counter()
    try:
        with open(path, "rb") as fh:
            raw = fh.read(limit)
    except OSError:
        return {"records": 0, "unknown": {}, "gaps": {}}
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        records += 1
        t = a.record_type(rec)
        if t is None:
            continue
        if t in getattr(a, "gap_types", ()):
            gaps[t] += 1
        elif t not in a.known_types:
            unknown[t] += 1
    return {"records": records, "unknown": dict(unknown), "gaps": dict(gaps)}


def sample_logs(a: Adapter, home: Path, n: int = SAMPLE_LOGS) -> list[tuple[Path, str | None]]:
    """(log, CLI version that wrote it if known): the newest ``n`` logs, and for Codex also the newest
    rollout of every CLI version its index knows (old sessions stay readable, or say why not)."""
    pattern = {
        "claude": str(home / ".claude" / "projects" / "*" / "*.jsonl"),
        "pi": str(Path(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or home / ".pi" / "agent" / "sessions") / "*" / "*.jsonl"),
        "codex": str(Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions" / "*" / "*" / "*" / "rollout-*.jsonl"),
    }.get(a.kind)
    own = getattr(a, "sample_pattern", None)
    if own is not None:
        pattern = own(home)
    if not pattern:
        return []
    files = sorted(glob.glob(pattern), key=lambda p: os.path.getmtime(p) if os.path.exists(p) else 0, reverse=True)[:n]
    out: list[tuple[Path, str | None]] = [(Path(p), log_version(a, Path(p))) for p in files]
    if a.kind == "codex":
        db = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "state_5.sqlite"
        if db.exists():
            try:
                con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
                try:
                    rows = con.execute("select cli_version, rollout_path from threads t where created_at = (select max(created_at) from threads u where u.cli_version = t.cli_version) and cli_version is not null").fetchall()
                finally:
                    con.close()
            except sqlite3.Error:
                rows = []
            have = {str(p) for p, _ in out}
            out += [(Path(p), v) for v, p in rows if p and Path(p).exists() and p not in have]
    return out


def log_version(a: Adapter, path: Path) -> str | None:
    """The CLI version a log says it was written by (Claude: each line; Codex: session_meta)."""
    try:
        with open(path, "rb") as fh:
            for i, line in enumerate(fh):
                if i > 40:
                    break
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                if a.kind == "claude" and isinstance(rec.get("version"), str):
                    return rec["version"]
                if a.kind == "codex" and rec.get("type") == "session_meta":
                    return (rec.get("payload") or {}).get("cli_version")
                own = getattr(a, "version_in_record", None)
                if own is not None and own(rec):
                    return own(rec)
    except OSError:
        return None
    return None


# ——— trust ———
def trust(root: Path | str | None) -> dict[str, bool]:
    """``.agora/agents.toml``: ``[<kind>] trust_untested = true`` per CLI."""
    if root is None:
        return {}
    try:
        cfg = tomllib.loads((Path(root) / ".agora" / "agents.toml").read_text())
    except (OSError, tomllib.TOMLDecodeError):
        return {}
    return {k: bool(v.get("trust_untested")) for k, v in cfg.items() if isinstance(v, dict)}


# ——— the probe ———
def probe(a: Adapter, *, home: Path | None = None, root: Path | str | None = None, version: str | None = None, sample: int = SAMPLE_LOGS, with_version: bool = True) -> dict[str, Any]:
    """Everything ``agora doctor --agents`` says about one CLI."""
    home = home or Path.home()
    installed = a.installed() is not None
    if with_version and version is None and installed:
        from server.canvas.agents import child_env

        version = cached_version(a, child_env())
    ok = a.tested.contains(version) if version else None
    logs = sample_logs(a, home, sample) if isinstance(a, Projector) else []
    total, unknown, gaps, by_version, formats = 0, Counter(), Counter(), {}, Counter()
    for p, v in logs:
        s = scan(a, p)
        total += s["records"]
        unknown.update(s["unknown"])
        gaps.update(s["gaps"])
        if v:
            bv = by_version.setdefault(v, {"logs": 0, "records": 0, "unknown": Counter(), "gaps": Counter()})
            bv["logs"] += 1
            bv["records"] += s["records"]
            bv["unknown"].update(s["unknown"])
            bv["gaps"].update(s["gaps"])
        f = a.log_format(p)
        if f:
            formats[f] += 1
    rt = runtime(a.kind)
    unknown_n = sum(unknown.values())
    ratio = unknown_n / total if total else 0.0
    tier = implemented_tier(a)
    reasons = []
    if installed and version and ok is False:
        reasons.append(f"本机 {a.name} {version} 不在测过的范围 {a.tested.label()} 内")
    if installed and not version:
        reasons.append(f"读不出 {a.name} 的版本（{a.binaries[0]} --version）")
    if ratio > UNKNOWN_RATIO:
        reasons.append(f"最近的日志里 {ratio:.0%} 的记录类型 Agora 不认识")
    if rt and rt["records"] and sum(rt["unknown"].values()) / rt["records"] > UNKNOWN_RATIO:
        reasons.append("跟随中的会话出现了较多不认识的记录")
    trusted = trust(root).get(a.kind, False)
    degraded = {"from": tier, "to": lower_tier(tier), "reason": "；".join(reasons), "trusted": trusted, "enforced": False} if reasons and installed else None
    notes = []
    if unknown:
        notes.append("不认识的记录类型：" + "、".join(f"{t} ×{n}" for t, n in unknown.most_common(8)) + "（轨迹里被跳过）")
    if gaps:
        notes.append("认识但还没处理的记录：" + "、".join(f"{t} ×{n}" for t, n in gaps.most_common(6)))
    return {
        "kind": a.kind,
        "name": a.name,
        "installed": installed,
        "version": version,
        "tested": a.tested.label(),
        "versionOk": ok,
        "tier": tier,
        "maxTier": a.max_tier,
        "logFormats": dict(formats),
        "sampled": {"logs": len(logs), "records": total},
        "unknown": dict(unknown.most_common()),
        "unknownRatio": round(ratio, 4),
        "gaps": dict(gaps.most_common()),
        "byVersion": {v: {"logs": d["logs"], "records": d["records"], "unknown": dict(d["unknown"]), "gaps": dict(d["gaps"])} for v, d in sorted(by_version.items(), key=lambda kv: _vkey(kv[0]))},
        "runtime": rt,
        "degraded": degraded,
        "notes": notes,
        "fix": _fix(a, degraded, unknown, gaps),
    }


def _vkey(v: str) -> tuple:
    from server.canvas.adapters.base import parse_version

    return parse_version(v) or ()


def _fix(a: Adapter, degraded: dict | None, unknown: Counter, gaps: Counter) -> str:
    if degraded and "不在测过的范围" in degraded["reason"]:
        return f"在 /tmp 里录一份新样本并跑契约测试：`agora doctor --agents --record {a.kind}`；确认没问题后放宽 {a.kind} 适配器的 tested，或在 .agora/agents.toml 写 [{a.kind}] trust_untested = true"
    if unknown:
        return f"看一眼这些新记录是什么（样本：tests/fixtures/agents/{a.kind}/），在适配器里处理或列进 ignored_types"
    if gaps:
        return "旧版本日志的这些记录还没投影：老会话的轨迹不全"
    return ""


def probe_all(*, home: Path | None = None, root: Path | str | None = None, with_version: bool = True, sample: int = SAMPLE_LOGS) -> list[dict[str, Any]]:
    return [probe(a, home=home, root=root, with_version=with_version, sample=sample) for a in ADAPTERS.values()]


_probe_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def adapter_infos(root: Path | str | None = None, *, with_versions: bool = True, with_catalog: bool = False, ttl_s: float = 600) -> list[dict[str, Any]]:
    """``AgentInfo`` plus what drift says (``degraded`` notify-only, ``drift`` counts), cached."""
    from server.canvas.adapters import registry

    out = registry.adapter_infos(root, with_versions=with_versions, with_catalog=with_catalog)
    tr = trust(root)
    for d in out:
        a = ADAPTERS[d["kind"]]
        key = f"{a.kind}:{with_versions}"
        hit = _probe_cache.get(key)
        if hit is None or time.time() - hit[0] > ttl_s:
            hit = (time.time(), probe(a, root=root, version=d.get("version"), with_version=with_versions, sample=4))
            _probe_cache[key] = hit
        p = hit[1]
        deg = p["degraded"]
        if deg is not None:
            deg = {**deg, "trusted": tr.get(a.kind, False)}
        d["degraded"] = deg
        d["drift"] = {"unknown": p["unknown"], "records": p["sampled"]["records"], "versionOk": p["versionOk"], "runtime": runtime(a.kind)}
    return out


def table(rows: list[dict[str, Any]]) -> str:
    """The ``agora doctor --agents`` table (plain text)."""
    head = ["CLI", "安装", "版本", "测过的范围", "档位", "日志格式", "抽样", "不认识的记录", "提示"]
    lines = []
    for r in rows:
        tier = r["tier"] if not r["degraded"] else f"{r['tier']}（会降为 {r['degraded']['to']}，只提示{'，已信任' if r['degraded']['trusted'] else ''}）"
        unk = "、".join(f"{t}×{n}" for t, n in list(r["unknown"].items())[:4]) or "—"
        lines.append([
            r["name"],
            "是" if r["installed"] else "否",
            r["version"] or "—",
            r["tested"],
            tier,
            ",".join(f"v{f}" for f in r["logFormats"]) or "—",
            f"{r['sampled']['logs']} 份 / {r['sampled']['records']} 条",
            unk,
            (r["degraded"] or {}).get("reason") or "",
        ])
    widths = [max(_w(x) for x in col) for col in zip(head, *lines)]
    fmt = lambda row: "  ".join(c + " " * (w - _w(c)) for c, w in zip(row, widths)).rstrip()  # noqa: E731
    out = [fmt(head), fmt(["-" * w for w in widths])] + [fmt(row) for row in lines]
    for r in rows:
        for n in r["notes"]:
            below = r["unknown"] and not r["degraded"]
            out.append(f"· {r['name']}：{n}" + ("（低于 5% 阈值：只提示，不影响退出码）" if below and n.startswith("不认识") else ""))
        if r["fix"]:
            out.append(f"  怎么办：{r['fix']}")
        old = {v: d for v, d in r["byVersion"].items() if d["gaps"] or d["unknown"]}
        if old:
            out.append(f"  按版本：" + "；".join(f"{v} " + "、".join(f"{t}×{n}" for t, n in {**d["unknown"], **d["gaps"]}.items()) for v, d in list(old.items())[:8]))
    return "\n".join(out)


def _w(s: str) -> int:
    import unicodedata

    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)
