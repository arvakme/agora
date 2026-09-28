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
   (``.agora/run/seedmux/agora-<sid>.json``), or the ``to_pane`` of a worker already in the tree
   (a worker dispatching its own workers); empty when the dispatcher ran in Agora's own tmux;
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

from server.canvas.adapters.base import NativeRef, ParentLink, valid_id
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


MAX_JSON = 256 * 1024  # meta.json / delivery.json larger than this are not read (a ticket's are a few KB)


def _json(p: Path) -> dict[str, Any] | None:
    """A small JSON object file; symlinks and oversized files are skipped (review P2-9)."""
    try:
        if p.is_symlink() or p.stat().st_size > MAX_JSON:
            return None
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
        if not (d / "reply.md").is_symlink():
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


class Scan:
    """One read of the tickets folder for one run-tree build (review P2-6): this project's tickets,
    the project's roots (``git worktree list`` once), and when each Seedmux pane last got a ticket
    from *any* project — panes are reused, so only a pane's latest ticket may take its current sid."""

    def __init__(self, root: str, base: Path | None = None) -> None:
        self.roots = worktrees(root)
        self.mine: list[dict[str, Any]] = []
        self.pane_latest: dict[str, float] = {}
        base = base or tasks_dir()
        if not base.is_dir():
            return
        for d in base.iterdir():
            if not d.name.startswith("T-") or d.is_symlink() or not d.is_dir():
                continue
            t = read_ticket(d)
            if t is None:
                continue
            m = t["meta"]
            pane = str(m.get("to_pane") or "").upper()
            created = float(m.get("created_at") or 0)
            if pane and created >= self.pane_latest.get(pane, 0):
                self.pane_latest[pane] = created
            if in_project(m.get("cwd"), self.roots):
                self.mine.append(t)
        self.mine.sort(key=lambda t: float(t["meta"].get("created_at") or 0))

    def latest_on_pane(self, rc: dict[str, Any]) -> bool:
        pane = (rc.get("toPane") or "").upper()
        return bool(pane) and rc.get("createdAt") is not None and abs(self.pane_latest.get(pane, -1) * 1000 - rc["createdAt"]) < 1


def tickets(root: str, *, base: Path | None = None) -> list[dict[str, Any]]:
    """This project's tickets (cwd in the root, a worktree, or a folder inside them), oldest first."""
    return Scan(root, base).mine


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
        "sid": next((x for x in (d.get("sid"), native.get("sid")) if valid_id(x)), None),
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


def _replied(rc: dict[str, Any]) -> bool:
    return bool(rc.get("repliedAt")) or str(rc.get("status") or "").startswith("replied:")


def worker_ref(t: dict[str, Any], rc: dict[str, Any], parent: ParentLink, scan: Scan) -> NativeRef:
    """The worker as a run: its native session when its sid is known and its log is in this project;
    else a receipts-only run ``smx:T-xx``.

    Where the sid comes from (review P1-1): ``delivery.json``; failing that, the pane's *current* sid
    from ``/panes`` — but only when this ticket is the latest one that pane received (from any
    project) and has not replied yet, since Seedmux reuses panes. A found log must say it ran in the
    project root or one of its worktrees; another project's transcript is never attached."""
    a = by_seedmux_name(rc["agent"])
    sid = rc.get("sid")
    how = "delivery.json"
    if not sid and not _replied(rc) and scan.latest_on_pane(rc):
        cand = (panes().get((rc.get("toPane") or "").upper()) or {}).get("sid")
        sid, how = (cand, "/panes") if valid_id(cand) else (None, "")
    label = f"{rc['taskId']} · {rc['agent'] or 'worker'}"
    meta = {"state": rc["state"], "dispatchedAt": rc["createdAt"], "doneAt": rc["repliedAt"] if rc["state"] in ("done", "failed", "blocked") else None, "receipt": rc, "role": "seedmux worker"}
    note = ""
    if a is not None and sid and hasattr(a, "locate"):
        look = a.locate(sid, rc.get("cwd"), None)
        if look.path is not None:
            cwd = a.log_cwd(look.path)
            if in_project(cwd, scan.roots):
                ev = parent.evidence + f"；worker 会话 {sid[:8]} 来自 {how}"
                return NativeRef(a.kind, sid, look.path, cwd, ParentLink(parent.via, parent.parent_run, parent.tool_call_id, parent.task_id, ev), label=label, meta=meta)
            note = f"；{how} 给的会话 {sid[:8]} 不在这个项目里（{cwd or '日志没写 cwd'}），没有接上"
    finder = getattr(a, "worker_for_ticket", None) if a is not None else None
    if finder is not None:
        got = finder(rc)
        if got is not None:
            nid, path, how2 = got
            return NativeRef(a.kind, nid, path, rc.get("cwd"), ParentLink(parent.via if how2 == "seedmux" else "inferred", parent.parent_run, parent.tool_call_id, parent.task_id, parent.evidence + f"；worker 会话按 cwd 与时间窗找到（{how2}）"), label=label, meta=meta)
    link = ParentLink(parent.via, parent.parent_run, parent.tool_call_id, parent.task_id, parent.evidence + note)
    return NativeRef(a.kind if a is not None else (rc["agent"] or "seedmux"), rc["taskId"], None, rc.get("cwd"), link, label=label, meta={**meta, "receiptsOnly": True})


def _interval(run: dict[str, Any], rc: dict[str, Any], now_ms: int) -> tuple[int, int]:
    """When a worker held its pane for this ticket: from dispatch to its reply, else to its last
    activity (+ pad), else — still going — until now."""
    lo = rc.get("createdAt") or run.get("startedAt") or 0
    if rc.get("repliedAt"):
        return lo, rc["repliedAt"]
    if run.get("lastAt"):
        return lo, max(run["lastAt"], lo) + WINDOW_PAD_MS
    if rc["state"] in ("done", "failed", "blocked", "exited", "unknown", "session_changed"):
        return lo, lo + WINDOW_PAD_MS
    return lo, now_ms


def attach(runs: dict[str, dict[str, Any]], *, root: str | None, store: Any, depth: int | None, folded: dict[str, int], links: list | None = None, home: Path | None = None, placed: set[str] | None = None, with_items: bool = False, scan: Scan | None = None) -> list[tuple[NativeRef, dict[str, Any]]]:
    """Add this project's Seedmux workers to the run tree ``runs`` (mutated), linked to their parents.
    Returns the worker runs it added that have a native session (their own sub-agents are the
    caller's to expand). ``placed``: tickets already in the tree (kept across calls); ``scan``: the
    build's one read of the tickets folder."""
    from server.canvas.adapters.runs import _moments, run_of

    added: list[tuple[NativeRef, dict[str, Any]]] = []
    placed = placed if placed is not None else set()
    if not root:
        return added
    scan = scan or Scan(root)
    all_t = scan.mine
    if not all_t:
        return added
    top = next(iter(runs.values()))
    now_ms = int(time.time() * 1000)

    def dispatches() -> dict[str, tuple[str, str]]:
        """1. dispatches in the runs' own logs (``smx-team spawn/assign`` output: task=T-xx pane=…)"""
        found: dict[str, tuple[str, str]] = {}
        for r in list(runs.values()):
            for it in r.get("_items") or []:
                sp = (it.get("tool") or {}).get("spawn") or {}
                if sp.get("taskId"):
                    found.setdefault(sp["taskId"], (r["id"], it["id"]))
        return found

    agora_panes = _agora_panes(store) if store is not None else {}
    session_of_top = top.get("sessionId")
    top_lo = top.get("startedAt")
    top_hi = ((top.get("lastAt") or top_lo or 0) + WINDOW_PAD_MS) if top_lo else None
    others = None
    # pane → every interval a worker in the tree held it: (from, to, run id). A reused pane has many.
    worker_panes: dict[str, list[tuple[int, int, str]]] = {}
    for rid, r in runs.items():
        for rc0 in r.get("receipts") or ([r["receipt"]] if r.get("receipt") else []):
            if rc0.get("toPane"):
                worker_panes.setdefault(rc0["toPane"].upper(), []).append((*_interval(r, rc0, now_ms), rid))

    def pane_holder(pane: str, at: int | None) -> str | None:
        if at is None:
            return None
        hits = [(lo, rid) for lo, hi, rid in worker_panes.get(pane.upper(), []) if lo <= at <= hi]
        return max(hits)[1] if hits else None

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
            holder = pane_holder(rc["fromPane"], rc.get("createdAt")) if rc.get("fromPane") else None
            if tid in by_task:
                parent_id, tool_id = by_task[tid]
                via, ev = "seedmux", f"父会话日志里 smx-team 打印的 task={tid} pane={rc.get('toPane') or '?'}"
            elif rc.get("fromPane") and session_of_top and agora_panes.get(rc["fromPane"].upper()) == session_of_top and top_lo and rc.get("createdAt") and top_lo <= rc["createdAt"] <= top_hi:
                parent_id, via, ev = top["id"], "seedmux", f"工单 meta.from_pane = 持有这个会话的 Seedmux pane（{rc['fromPane'][:8]}），且在会话活跃期间创建"
            elif holder is not None:
                parent_id, via = holder, "seedmux"
                ev = f"工单 meta.from_pane = worker {(runs[holder].get('receipt') or {}).get('taskId', '')} 的 to_pane（{rc['fromPane'][:8]}），且创建时那个 worker 还占着这个 pane"
            elif not rc.get("fromPane") and top_lo and rc.get("createdAt"):
                if top_lo <= rc["createdAt"] <= top_hi:
                    if others is None:
                        others = _windows(store, root, session_of_top) if store is not None else []
                    if not any(a <= rc["createdAt"] <= b for _, a, b in others):
                        parent_id, via, ev = top["id"], "inferred", "同一项目目录、会话活跃期间创建，且当时没有别的 Agora 会话活跃"
            if parent_id is None:
                continue
            placed.add(tid)
            prun = runs[parent_id]
            link = ParentLink(via, parent_id, tool_id, tid, ev)
            ref = worker_ref(t, rc, link, scan)
            kd = prun["depth"] + 1
            if depth is not None and kd > depth:
                folded[prun["id"]] = folded.get(prun["id"], 0) + 1
                prun["hiddenDescendants"] += 1
                continue
            rid = f"smx:{tid}" if ref.meta.get("receiptsOnly") else ref.run_id
            if rid in runs:
                # The same worker session served another ticket (resume_session): one run, every receipt (review P2-8).
                krun = runs[rid]
                krun.setdefault("receipts", [krun["receipt"]] if krun.get("receipt") else []).append(rc)
                if (rc.get("createdAt") or 0) >= ((krun.get("receipt") or {}).get("createdAt") or 0):
                    krun["receipt"] = rc
                    if krun["state"] not in ("running", "waiting"):
                        krun["state"] = rc["state"]
            else:
                krun = run_of(ref, root, depth=kd, links=links, with_items=with_items)
                if ref.meta.get("receiptsOnly"):
                    krun["id"] = rid
                    krun["tier"] = "T3"
                    krun.pop("nativeId", None)
                if ref.meta.get("receiptsOnly") or krun["state"] not in ("running", "waiting"):
                    # Seedmux's own verdict, unless the worker's log shows it working or waiting right now.
                    krun["state"] = rc["state"]
                krun["receipt"] = rc
                krun["receipts"] = [rc]
                runs[rid] = krun
                if ref.path is not None:
                    added.append((ref, krun))
            if rc.get("repliedAt"):
                krun["timeline"]["moments"].append({"kind": "receipt", "at": rc["repliedAt"], "taskId": tid, "state": rc["state"]})
            before = len(prun["timeline"]["moments"])
            _moments(prun, krun, ref, prun.get("_items") or [])
            for m in prun["timeline"]["moments"][before:]:
                m["taskId"] = tid
            if rc.get("toPane"):
                worker_panes.setdefault(rc["toPane"].upper(), []).append((*_interval(krun, rc, now_ms), rid))
            changed = True
    return added
