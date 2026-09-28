"""Seedmux tickets as receipts (tier T3): workers a session dispatched through Seedmux, what state
their delivery is in, and — when the worker's CLI has an adapter and its session id is known — the
worker's own trajectory (web/docs/cli-adapters.md §5.2–5.3).

**Read-only, by decision (2026-09-28).** Agora reads ``~/.seedmux/team/tasks/T-*/meta.json`` (core
keys only), ``delivery.json`` (core keys), ``reply.md`` (a preview), and makes one ``GET /panes``
on Seedmux's team bridge per scan. It never sends, captures, spawns or wakes anything. Only tickets
whose ``cwd`` is the project root, one of its git worktrees, or a folder inside them are read.

Seedmux's own rules are kept: ``unknown`` is never drawn as running, and ``replied:done`` is not
acceptance (``verify.accept`` is reported separately).

Parent links, strongest first:

1. ``seedmux``: the parent's own log has the dispatch — ``smx-team spawn/assign`` prints
   ``task=T-xx pane=<UUID>``, which the tool facts carry as ``spawn.taskId`` (tools.py);
2. ``seedmux``: ``meta.from_pane`` is the Seedmux pane Agora recorded as holding that session
   (``.agora/run/seedmux/agora-<sid>.json``); empty when the dispatcher ran in Agora's own tmux;
3. ``inferred``: same cwd, created while the session was active, and no other Agora session of
   this project was active then.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from server.canvas.adapters.base import NativeRef, ParentLink
from server.canvas.adapters.registry import by_seedmux_name

META_KEYS = ("task", "from_pane", "to_pane", "agent", "model", "effort", "cwd", "created_at", "status", "verify", "replied_at", "resume_session")
DELIVERY_KEYS = ("state", "sid", "native", "ack_at", "sent_at", "created_at", "deadline", "exit_event_at", "observed_at", "reply")
ACK_GRACE_S = 60
PANES_TTL_S = 15
WINDOW_PAD_MS = 5 * 60 * 1000  # "active" = from its first record to 5 minutes after its last


def tasks_dir() -> Path:
    return Path(os.environ.get("AGORA_SEEDMUX_TASKS") or Path.home() / ".seedmux" / "team" / "tasks")


# ——— unified state (§5.3) ———
def unified_state(meta: dict[str, Any], delivery: dict[str, Any] | None, now: float | None = None) -> str:
    """Seedmux ``meta.status`` / ``delivery.state`` (``seedmux-delivery.py verdict``) → the unified run state."""
    now = now or time.time()
    status = str(meta.get("status") or "")
    if status.startswith("replied:"):
        return {"replied:done": "done", "replied:failed": "failed", "replied:blocked": "blocked"}.get(status, "unknown")
    d = delivery or {}
    st = str(d.get("state") or "")
    if st.startswith("replied:"):
        return {"replied:done": "done", "replied:failed": "failed", "replied:blocked": "blocked"}.get(st, "unknown")
    mapped = {
        "awaiting_ack": "dispatched",
        "ack_overdue": "dispatched",
        "running_observed": "running",
        "waiting": "waiting",
        "idle_without_reply": "idle_no_reply",
        "exited_without_reply": "exited",
        "session_changed": "session_changed",
        "reply_unconfirmed": "unknown",
        "unknown": "unknown",
    }.get(st)
    if mapped:
        return mapped
    if d.get("ack_at"):
        return "acknowledged"
    created = float(meta.get("created_at") or d.get("created_at") or 0)
    if status == "dispatched" and created and now - created < ACK_GRACE_S:
        return "dispatched"
    return "unknown"  # never guessed as running


# ——— reading tickets ———
_ticket_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def _json(p: Path) -> dict[str, Any] | None:
    try:
        v = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    return v if isinstance(v, dict) else None


def read_ticket(d: Path) -> dict[str, Any] | None:
    """Core keys of one ticket (cached until the folder or its files change)."""
    try:
        sig = max((d / n).stat().st_mtime for n in ("meta.json", "delivery.json", "reply.md") if (d / n).exists())
    except (OSError, ValueError):
        return None
    hit = _ticket_cache.get(str(d))
    if hit and hit[0] == sig:
        return hit[1]
    meta = _json(d / "meta.json")
    if meta is None:
        _ticket_cache[str(d)] = (sig, None)
        return None
    delivery = _json(d / "delivery.json")
    reply = None
    try:
        with open(d / "reply.md", "rb") as fh:
            reply = fh.read(1200).decode("utf-8", "replace")
    except OSError:
        pass
    t = {
        "meta": {k: meta.get(k) for k in META_KEYS if k in meta},
        "delivery": {k: delivery.get(k) for k in DELIVERY_KEYS if k in delivery} if delivery else None,
        "reply": reply,
        "dir": str(d),
    }
    _ticket_cache[str(d)] = (sig, t)
    return t


def worktrees(root: str) -> list[str]:
    """The project root and its git worktrees (``git worktree list --porcelain``, read-only)."""
    out = [os.path.realpath(root)]
    try:
        r = subprocess.run(["git", "-C", root, "worktree", "list", "--porcelain"], capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if line.startswith("worktree "):
                p = os.path.realpath(line[len("worktree ") :].strip())
                if p not in out:
                    out.append(p)
    except (OSError, subprocess.SubprocessError):
        pass
    return out


def in_project(cwd: str | None, roots: list[str]) -> bool:
    if not cwd:
        return False
    c = os.path.realpath(cwd)
    return any(c == r or c.startswith(r.rstrip("/") + "/") for r in roots)


def tickets(root: str, *, since: float | None = None, base: Path | None = None) -> list[dict[str, Any]]:
    """This project's tickets (cwd in the root or a worktree), oldest first; ``since`` in seconds."""
    base = base or tasks_dir()
    if not base.is_dir():
        return []
    roots = worktrees(root)
    out = []
    for d in base.iterdir():
        if not d.name.startswith("T-") or not d.is_dir():
            continue
        try:
            if since and d.stat().st_mtime < since:
                continue
        except OSError:
            continue
        t = read_ticket(d)
        if t is None or not in_project(t["meta"].get("cwd"), roots):
            continue
        out.append(t)
    return sorted(out, key=lambda t: float(t["meta"].get("created_at") or 0))


_panes: tuple[float, dict[str, dict[str, Any]]] | None = None


def panes() -> dict[str, dict[str, Any]]:
    """One ``GET /panes`` on Seedmux's team bridge (cached ``PANES_TTL_S``): paneId → {agent, state, sid, cwd}.
    Only this read-only call is made; {} when Seedmux is not running."""
    global _panes
    if _panes and time.time() - _panes[0] < PANES_TTL_S:
        return _panes[1]
    got: dict[str, dict[str, Any]] = {}
    if os.environ.get("AGORA_SEEDMUX_PANES") != "0":
        try:
            from server.canvas.seedmux import Seedmux, SeedmuxError

            try:
                r = Seedmux.default()._req("/panes", timeout=3)
                for p in r.get("panes") or []:
                    if isinstance(p, dict) and p.get("paneId"):
                        got[str(p["paneId"]).upper()] = {k: p.get(k) for k in ("agent", "state", "sid", "cwd")}
            except SeedmuxError:
                pass
        except ImportError:
            pass
    _panes = (time.time(), got)
    return got


def receipt(t: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    """The ``receipt`` a run carries (web/src/session/agents.ts ``Receipt``)."""
    m, d = t["meta"], t["delivery"] or {}
    verify = m.get("verify") if isinstance(m.get("verify"), dict) else {}
    native = d.get("native") if isinstance(d.get("native"), dict) else {}
    reply = t.get("reply") or ""
    return {
        "taskId": m.get("task") or Path(t["dir"]).name,
        "agent": m.get("agent") or native.get("agent") or "",
        "cwd": m.get("cwd"),
        "createdAt": int(float(m["created_at"]) * 1000) if m.get("created_at") else None,
        "repliedAt": int(float(m["replied_at"]) * 1000) if m.get("replied_at") else None,
        "status": m.get("status"),
        "seedmuxState": d.get("state"),
        "state": unified_state(m, t["delivery"], now),
        "toPane": m.get("to_pane") or None,
        "fromPane": m.get("from_pane") or None,
        "sid": d.get("sid") or native.get("sid") or None,
        "changed": list(verify.get("changed") or []),
        "accept": verify.get("accept"),
        "replyPreview": reply.strip().splitlines()[0][:300] if reply.strip() else None,
        "replyPath": str(Path(t["dir"]) / "reply.md") if reply else None,
    }


# ——— attaching receipts to a run tree ———
def _agora_panes(store: Any) -> dict[str, str]:
    """Seedmux pane → Agora session, from ``.agora/run/seedmux/agora-<sid>.json`` (terminal.py)."""
    from server.canvas.terminal import Terminals

    out = {}
    d = store.run_dir / "seedmux"
    for sid in (store.bindings() or {}):
        f = d / f"{Terminals.name(sid)}.json"
        rec = _json(f)
        if rec and rec.get("paneId"):
            out[str(rec["paneId"]).upper()] = sid
    return out


def _windows(store: Any, root: str, skip: str | None) -> list[tuple[str, int, int]]:
    """(session, first, last+pad) of the other Agora sessions of this project (from their logs)."""
    from server.canvas import agents
    from server.canvas.adapters.runs import timeline

    out = []
    for sid, b in (store.bindings() or {}).items():
        if sid == skip or not b.get("nativeId"):
            continue
        look = agents.locate_log(b["agent"], b["nativeId"], root, hint=(b.get("log") or {}).get("path"))
        if look.path is None:
            continue
        tl = timeline(b["agent"], look.path, root)
        if tl["startedAt"]:
            out.append((sid, tl["startedAt"], (tl["lastAt"] or tl["startedAt"]) + WINDOW_PAD_MS))
    return out


def worker_ref(t: dict[str, Any], rc: dict[str, Any], parent: ParentLink) -> NativeRef:
    """The worker as a run: its native session when Seedmux knows the sid (delivery / panes) and its
    CLI has an adapter that finds the log; else a receipts-only run ``smx:T-xx``."""
    a = by_seedmux_name(rc["agent"])
    sid = rc.get("sid") or (panes().get((rc.get("toPane") or "").upper()) or {}).get("sid")
    label = f"{rc['taskId']} · {rc['agent'] or 'worker'}"
    meta = {"state": rc["state"], "dispatchedAt": rc["createdAt"], "doneAt": rc["repliedAt"] if rc["state"] in ("done", "failed", "blocked") else None, "receipt": rc, "role": "seedmux worker"}
    if a is not None and sid and hasattr(a, "locate"):
        look = a.locate(sid, rc.get("cwd"), None)
        if look.path is not None:
            return NativeRef(a.kind, sid, look.path, rc.get("cwd"), parent, label=label, meta=meta)
    finder = getattr(a, "worker_for_ticket", None) if a is not None else None
    if finder is not None:
        got = finder(rc)
        if got is not None:
            nid, path, how = got
            return NativeRef(a.kind, nid, path, rc.get("cwd"), ParentLink(parent.via if how == "seedmux" else "inferred", parent.parent_run, parent.tool_call_id, parent.task_id, parent.evidence + f"；worker 会话按 cwd 与时间窗找到（{how}）"), label=label, meta=meta)
    return NativeRef(a.kind if a is not None else (rc["agent"] or "seedmux"), rc["taskId"], None, rc.get("cwd"), parent, label=label, meta={**meta, "receiptsOnly": True})


def attach(runs: dict[str, dict[str, Any]], *, root: str | None, store: Any, depth: int | None, folded: dict[str, int], links: list | None = None, home: Path | None = None) -> None:
    """Add this project's Seedmux workers to the run tree ``runs`` (mutated), linked to their parents."""
    from server.canvas.adapters.runs import _moments, run_of

    if not root:
        return
    all_t = tickets(root)
    if not all_t:
        return
    top = next(iter(runs.values()))
    # 1. dispatches in the runs' own logs (task=T-xx pane=… in a tool's output)
    def dispatches() -> dict[str, tuple[str, str]]:
        found: dict[str, tuple[str, str]] = {}
        for r in list(runs.values()):
            for it in r.get("_items") or []:
                sp = (it.get("tool") or {}).get("spawn") or {}
                if sp.get("taskId"):
                    found.setdefault(sp["taskId"], (r["id"], it["id"]))
        return found

    agora_panes = _agora_panes(store) if store is not None else {}
    session_of_top = top.get("sessionId")
    others = None
    placed: set[str] = set()
    changed = True
    while changed:  # a worker's own log can dispatch further workers
        changed = False
        by_task = dispatches()
        for t in all_t:
            rc = receipt(t)
            tid = rc["taskId"]
            if tid in placed:
                continue
            parent_id, tool_id, via, ev = None, None, None, ""
            if tid in by_task:
                parent_id, tool_id = by_task[tid]
                via, ev = "seedmux", f"父会话日志里 smx-team 打印的 task={tid} pane={rc.get('toPane') or '?'}"
            elif rc.get("fromPane") and agora_panes.get(rc["fromPane"].upper()) == session_of_top and session_of_top:
                parent_id, via, ev = top["id"], "seedmux", f"工单 meta.from_pane = 持有这个会话的 Seedmux pane（{rc['fromPane'][:8]}）"
            elif not rc.get("fromPane") and top.get("startedAt") and rc.get("createdAt"):
                lo, hi = top["startedAt"], (top.get("lastAt") or top["startedAt"]) + WINDOW_PAD_MS
                if lo <= rc["createdAt"] <= hi:
                    if others is None:
                        others = _windows(store, root, session_of_top) if store is not None else []
                    if not any(a <= rc["createdAt"] <= b for _, a, b in others):
                        parent_id, via, ev = top["id"], "inferred", "同一项目目录、会话活跃期间创建，且当时没有别的 Agora 会话活跃"
            if parent_id is None:
                continue
            placed.add(tid)
            prun = runs[parent_id]
            link = ParentLink(via, parent_id, tool_id, tid, ev)
            ref = worker_ref(t, rc, link)
            kd = prun["depth"] + 1
            if depth is not None and kd > depth:
                folded[prun["id"]] = folded.get(prun["id"], 0) + 1
                prun["hiddenDescendants"] += 1
                continue
            if ref.run_id in runs:
                continue
            krun = run_of(ref, root, depth=kd, links=links)
            if ref.meta.get("receiptsOnly"):
                krun["id"] = f"smx:{tid}"
                krun["tier"] = "T3"
                krun.pop("nativeId", None)
            if ref.meta.get("receiptsOnly") or krun["state"] in ("unknown", "idle"):
                # Seedmux's own verdict when there is no fresher evidence (a log being written, a CLI turn end).
                krun["state"] = rc["state"] if rc["state"] != "unknown" or ref.meta.get("receiptsOnly") else krun["state"]
            krun["receipt"] = rc
            if rc.get("repliedAt"):
                krun["timeline"]["moments"].append({"kind": "receipt", "at": rc["repliedAt"], "taskId": tid, "state": rc["state"]})
            runs[krun["id"]] = krun
            _moments(prun, krun, ref, prun.get("_items") or [])
            for m in prun["timeline"]["moments"]:
                if m.get("childRunId") == krun["id"]:
                    m["taskId"] = tid
            changed = True
