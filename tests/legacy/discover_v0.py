"""会话历史: every session of a project, wherever it is now, and native sessions found on this
machine that belong to it but are no longer in it.

A row per session: listed in workspace.json (open or closed), in the trash, known only to the
machine registry, or found in the CLIs' own logs. Found logs are matched back, strongest first:

1. the registry's ``bind`` records (exact native id);
2. the hidden footer Agora appends to every message it sends, ``[[agora]] … (canvas=… session=…
   project=…)`` — the session and project ids name it exactly, the canvas id alone still says
   which canvas it was about;
3. only the working directory: a session started in a terminal in this project that never went
   through Agora (listed last, collapsed by default on the page).

Where each CLI's logs for a project are: Claude ``~/.claude/projects/<escaped root>/``, Pi
``~/.pi/agent/sessions/--<escaped root>--/`` (for the current root and every earlier one), Codex
its own index ``~/.codex/state_5.sqlite`` (``threads where cwd in roots``, read-only), else the
first line of recent rollouts. Nothing here writes: importing is a binding made by the page.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

from tests.legacy import agents_v0 as agents
from tests.legacy.transcript_v0 import MARKER, State, project, split_agora

SCAN_MAX = 50 * 1024 * 1024  # bytes read per log (full-text search and stats)
CODEX_FALLBACK = 400  # newest rollouts looked at when Codex has no index
FOOTER = re.compile(r"\(((?:canvas|session|project)=[^()\n\"\\]{1,200})\)")


def footer_ids(text: str) -> dict[str, str]:
    """``canvas`` / ``session`` / ``project`` from the first Agora footer in ``text`` that has them."""
    i = text.find(MARKER)
    while i >= 0:
        m = FOOTER.search(text, i, i + 600)
        if m:
            return dict(kv.split("=", 1) for kv in m.group(1).split() if "=" in kv)
        i = text.find(MARKER, i + len(MARKER))
    return {}


_stats: dict[tuple[str, str], tuple[tuple[int, float], dict[str, Any]]] = {}


def log_stats(kind: str, path: Path) -> dict[str, Any]:
    """``scan_log`` without a search, cached per file until its size or mtime changes: 会话历史
    reopens without reading every log again (only the ones that grew)."""
    try:
        st = path.stat()
    except OSError:
        return scan_log(kind, path)
    key, sig = (kind, str(path)), (st.st_size, st.st_mtime)
    hit = _stats.get(key)
    if hit is None or hit[0] != sig:
        hit = (sig, scan_log(kind, path))
        _stats[key] = hit
        if len(_stats) > 2000:  # a bounded cache: forget the oldest entries
            for k in list(_stats)[:500]:
                _stats.pop(k, None)
    return hit[1]


def scan_log(kind: str, path: Path, *, want: str | None = None) -> dict[str, Any]:
    """What a native log says, read through the same projection the transcript uses: first and last
    activity, number of turns, the first message (without Agora's footer), the model, the first
    footer's ids, and — with ``want`` — a snippet around the first user / assistant text that
    contains it (case-insensitive)."""
    out: dict[str, Any] = {"turns": 0, "createdAt": None, "lastActiveAt": None, "firstMessage": "", "model": None, "footer": {}, "agora": False}
    try:
        size = path.stat().st_size
        with open(path, "rb") as fh:
            raw = fh.read(SCAN_MAX)
        out["lastActiveAt"] = int(path.stat().st_mtime * 1000)
    except OSError:
        return out
    out["size"] = size
    text = raw.decode("utf-8", "replace")
    if MARKER in text:
        out["agora"] = True
        out["footer"] = footer_ids(text)
    st = State()
    needle = want.casefold() if want else None
    for line in text.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        if kind == "pi" and rec.get("type") == "session" and out["createdAt"] is None:
            out["cwd"] = rec.get("cwd")
        try:
            items, _ = project(kind, rec, st)
        except Exception:
            continue
        for it in items:
            at = it.get("at") or None
            if at and (out["createdAt"] is None or at < out["createdAt"]):
                out["createdAt"] = at
            if it["kind"] == "user" and (it.get("text") or "").strip():
                out["turns"] += 1
                if not out["firstMessage"]:
                    out["firstMessage"] = split_agora(it["text"])[0].strip()[:300]
            elif it["kind"] == "usage" and (it.get("usage") or {}).get("model"):
                out["model"] = it["usage"]["model"]
            elif it["kind"] == "context" and it.get("model"):
                out["model"] = it["model"]
            if needle and "match" not in out and it["kind"] in ("user", "assistant"):
                body = it.get("text") or ""
                k = body.casefold().find(needle)
                if k >= 0:
                    out["match"] = ("…" if k > 30 else "") + body[max(0, k - 30) : k + len(want or "") + 50].replace("\n", " ")
    return out


def _codex_rows(roots: list[str], home: Path) -> list[dict[str, Any]]:
    db = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "state_5.sqlite"
    if db.exists():
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
            con.row_factory = sqlite3.Row
            try:
                q = f"select * from threads where cwd in ({','.join('?' * len(roots))})"
                rows = [dict(r) for r in con.execute(q, roots).fetchall()]
            finally:
                con.close()
            return [{"nativeId": r["id"], "path": Path(r["rollout_path"]), "cwd": r["cwd"]} for r in rows if r.get("rollout_path")]
        except sqlite3.Error:
            pass
    out = []
    files = sorted(glob.glob(str(Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions" / "*" / "*" / "*" / "rollout-*.jsonl")))[-CODEX_FALLBACK:]
    for p in files:
        try:
            with open(p, "rb") as fh:
                meta = json.loads(fh.readline() or b"{}")
        except (OSError, ValueError):
            continue
        pl = meta.get("payload") or {}
        if meta.get("type") == "session_meta" and pl.get("id") and str(pl.get("cwd")) in roots:
            out.append({"nativeId": str(pl["id"]), "path": Path(p), "cwd": pl.get("cwd")})
    return out


def native_sessions(roots: list[str], home: Path | None = None) -> list[dict[str, Any]]:
    """Every native session of the three CLIs whose working directory is one of ``roots``."""
    home = home or Path.home()
    found: list[dict[str, Any]] = []
    for root in roots:
        for p in glob.glob(str(home / ".claude" / "projects" / agents.claude_dir_name(root) / "*.jsonl")):
            found.append({"agent": "claude", "nativeId": Path(p).stem, "path": Path(p), "cwd": root})
        pi_dir = Path(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or home / ".pi" / "agent" / "sessions") / agents.pi_dir_name(root)
        for p in glob.glob(str(pi_dir / "*.jsonl")):
            found.append({"agent": "pi", "nativeId": Path(p).stem.rsplit("_", 1)[-1], "path": Path(p), "cwd": root})
    found += [{"agent": "codex", **r} for r in _codex_rows(roots, home)]
    return found


def session_history(store, local, trash, *, home: Path | None = None) -> dict[str, Any]:
    """Rows for 会话历史 (web/docs/agent-sessions.md §8). ``state``: ``listed`` (in workspace.json;
    the page knows open / closed), ``trash``, ``registry`` (only this machine's registry knows it),
    ``found`` (a native log that names this project, or ran in its directory). Each row says where
    its native log is and what it holds (turns, first message, first / last activity)."""
    from server.canvas.local import session_origins

    pid = local.project_id()
    short = pid.replace("-", "")[:8]
    roots = list(dict.fromkeys([*local.historical_roots(), str(store.root)]))
    ws = store.read_workspace_quiet() or {}
    bindings = store.bindings()
    origins = session_origins(store, local)
    rows: dict[str, dict[str, Any]] = {}

    def row(sid: str, **kw: Any) -> dict[str, Any]:
        r = rows.setdefault(sid, {"sessionId": sid})
        r.update({k: v for k, v in kw.items() if v is not None and v != ""})
        return r

    for d in ws.get("docs") or []:
        if isinstance(d, dict) and d.get("kind") == "session" and isinstance(d.get("sessionId"), str):
            row(d["sessionId"], state="listed", docId=d.get("id"), title=d.get("title"), topic=d.get("topic"), canvasId=d.get("canvasId"), agent=d.get("agent"), model=d.get("model"), nativeId=d.get("nativeId"), createdAt=d.get("createdAt"))
    for sid, o in origins.items():
        if sid in rows:
            rows[sid]["origin"] = o["state"]
    for m in trash.list():
        if m["kind"] != "session":
            continue
        e = m.get("entry") or {}
        n = m.get("native") or {}
        row(m["id"], state="trash", trashId=m["trashId"], deletedAt=m["at"], daysLeft=m["daysLeft"], title=m.get("title") or e.get("title"), topic=e.get("topic"), canvasId=e.get("canvasId"), agent=n.get("agent") or e.get("agent"), nativeId=n.get("nativeId") or e.get("nativeId"), logPath=n.get("logPath"))
    for sid, b in bindings.items():
        head = (store.read_session(sid) or ({}, ""))[0].get("session") or {}
        row(sid, agent=b.get("agent"), model=b.get("model"), effort=b.get("effort"), nativeId=b.get("nativeId"), started=b.get("started"), canvasId=head.get("canvasId"), createdAt=b.get("createdAt") or head.get("createdAt"))
        rows[sid].setdefault("state", "listed")
    registry = local.registry.binds(pid, local.instance_id() or None)  # this copy's records; other copies list their own
    for sid, e in registry.items():
        if sid not in rows:
            row(sid, state="registry", agent=e.get("agent"), model=e.get("model"), effort=e.get("effort"), nativeId=e.get("nativeId"), canvasId=e.get("canvasId"), topic=e.get("topic"), root=e.get("root"), logPath=e.get("logPath"))

    by_native = {r["nativeId"]: r for r in rows.values() if r.get("nativeId")}
    for sid, b in bindings.items():  # earlier native ids of a session (forks, fresh starts) are still its own
        for n in b.get("natives") or []:
            by_native.setdefault(n.get("id"), rows[sid])
    found: list[dict[str, Any]] = []
    for nat in native_sessions(roots, home):
        stats = log_stats(nat["agent"], nat["path"])
        info = {"logPath": str(nat["path"]), "turns": stats["turns"], "firstMessage": stats["firstMessage"], "lastActiveAt": stats["lastActiveAt"], "model": stats["model"], "logCreatedAt": stats["createdAt"]}
        owner = by_native.get(nat["nativeId"])
        if owner is not None:
            for k, v in info.items():
                if v and (k not in owner or k in ("turns", "lastActiveAt", "firstMessage")):
                    owner[k] = v
            continue
        f = stats["footer"]
        mine = f.get("project") == short or (f.get("session") in rows and f.get("project") in (None, short))
        found.append({
            "state": "found",
            "sessionId": f.get("session") if mine and f.get("session") not in bindings else None,
            "agent": nat["agent"],
            "nativeId": nat["nativeId"],
            "canvasId": f.get("canvas") if mine else None,
            "source": "footer" if mine else ("agora" if stats["agora"] else "cwd"),
            "root": nat.get("cwd"),
            "createdAt": stats["createdAt"],
            **info,
        })
    listed = sorted(rows.values(), key=lambda r: -(r.get("lastActiveAt") or r.get("deletedAt") or r.get("createdAt") or 0))
    return {"rows": listed, "found": sorted(found, key=lambda r: ({"footer": 0, "agora": 1}.get(r["source"], 2), -(r.get("lastActiveAt") or 0))), "roots": roots}


FULL_TEXT_BUDGET_S = 15.0


def full_text(store, paths: dict[str, tuple[str, str]], q: str) -> list[dict[str, Any]]:
    """Search what was said (user and assistant text) in each log / snapshot, case-insensitive.
    ``paths``: key → (agent, path), newest-first by the caller. A trajectory snapshot is searched
    as-is (it holds items). A file whose raw bytes do not contain the words is skipped without
    parsing; the whole search stops after FULL_TEXT_BUDGET_S (the result says so)."""
    import time

    out = []
    needle = q.casefold()
    started = time.monotonic()
    for key, (kind, path) in paths.items():
        if time.monotonic() - started > FULL_TEXT_BUDGET_S:
            out.append({"key": None, "partial": True})
            break
        try:
            with open(path, "rb") as fh:
                raw = fh.read(SCAN_MAX).decode("utf-8", "replace").casefold()
        except OSError:
            continue
        if needle not in raw and json.dumps(q, ensure_ascii=True)[1:-1].casefold() not in raw:
            continue  # not even in the raw bytes (as text or as JSON \\u escapes)
        p = Path(path)
        if p.name.endswith(".jsonl") and p.parent.name == "snapshots":
            hit = None
            try:
                for line in p.read_text(errors="replace").splitlines():
                    it = json.loads(line)
                    body = it.get("text") or ""
                    k = body.casefold().find(needle)
                    if it.get("kind") in ("user", "assistant") and k >= 0:
                        hit = body[max(0, k - 30) : k + len(q) + 50].replace("\n", " ")
                        break
            except (OSError, ValueError):
                hit = None
            if hit is not None:
                out.append({"key": key, "snippet": hit})
            continue
        got = scan_log(kind, p, want=q)
        if "match" in got:
            out.append({"key": key, "snippet": got["match"]})
    return out
