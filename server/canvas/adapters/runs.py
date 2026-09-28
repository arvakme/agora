"""Agent runs: a session, the sub-agents it started natively, and the workers it dispatched through
Seedmux — one tree, each run with its own timeline (web/docs/cli-adapters.md §5, API §7).

``GET /api/agent/runs?session=<sid>`` (or ``?kind=<cli>&native=<id>`` for a session Agora does
not own) returns::

    {root, runs: [AgentRun…], folded: {runId: n}, depth, generatedAt}

``AgentRun``::

    {id, kind, nativeId?, tier, sessionId?, label, role?, model?, depth,
     parent?: {runId, via: native|seedmux|inferred, toolCallId?, taskId?, evidence},
     cwd?, worktree?, state, startedAt?, endedAt?, lastAt?, logPath?,
     hiddenDescendants, receipt?: {...Seedmux ticket...},
     timeline: {segments: [{kind, start, end, path?, node?, itemId, label, turn}],
                turns: [{n, start, end}],
                moments: [{kind: dispatch|handoff|receipt, at, childRunId?, toolCallId?, taskId?, state?}],
                timesInferred?: true}}

Parent/child evidence, strongest first: ``native`` (the CLI wrote the link), ``seedmux`` (a
dispatch record: the parent's own ``task=T-xx pane=…`` output, then ``meta.from_pane``), then
``inferred`` (cwd and a time window). Only the first level below the root is expanded by default
(user decision); deeper runs are counted in their ancestor's ``hiddenDescendants``.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

from server.canvas.adapters.base import NativeRef, Subagents
from server.canvas.adapters.common import State, read_jsonl
from server.canvas.adapters.registry import ADAPTERS, implemented_tier

RUNNING_S = 120  # a log written to this recently counts as running
MIN_TOOL_MS = 300
SEG_KIND = {"read": "read", "search": "read", "webFetch": "read", "webSearch": "read", "write": "write", "edit": "write", "commands": "exec", "tools": "exec", "subagents": "exec", "plan": "think", "questions": "wait"}

# Unified lifecycle (§5.3). Seedmux receipt states map onto it in receipts.py.
STATES = ("dispatched", "acknowledged", "running", "waiting", "idle_no_reply", "done", "failed", "blocked", "exited", "session_changed", "unknown", "idle")


# ——— canvas nodes (port of web/src/pointer/codeLinks.ts) ———
def glob_re(glob: str) -> re.Pattern[str]:
    g = glob.strip().replace("\\", "/")
    g = g[2:] if g.startswith("./") else g
    g = g[1:] if g.startswith("/") else g
    if g.endswith("/"):
        g += "**"
    elif not re.search(r"[*?\[{]", g) and not re.search(r"\.[^/]*$", g.split("/")[-1] if g else ""):
        g += "/**"
    out = ""
    i = 0
    esc = lambda c: re.sub(r"([.+^$()|\[\]\\])", r"\\\1", c)  # noqa: E731
    while i < len(g):
        c = g[i]
        if c == "*":
            if i + 1 < len(g) and g[i + 1] == "*":
                if i + 2 < len(g) and g[i + 2] == "/":
                    out += "(?:.*/)?"
                    i += 3
                    continue
                out += ".*"
                i += 2
                continue
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        elif c == "{":
            end = g.find("}", i)
            if end < 0:
                out += "\\{"
            else:
                out += "(?:" + "|".join(esc(s).replace("*", "[^/]*") for s in g[i + 1 : end].split(",")) + ")"
                i = end
        else:
            out += esc(c)
        i += 1
    if out.endswith("/.*"):
        out = out[:-3] + "(?:/.*)?"
    return re.compile(f"^{out}$")


def specificity(glob: str) -> int:
    g = glob.strip()
    m = re.search(r"[*?\[{]", g)
    return ((len(g) + 1000) if m is None else m.start()) * 1000 + len(g)


def canvas_links(store: Any, canvas_id: str) -> list[tuple[str, list[str]]]:
    """(element id, code path globs) of a canvas's elements (``customData.codePaths``)."""
    import json

    try:
        data = json.loads((store.dir / "canvases" / f"{canvas_id}.excalidraw").read_text())
    except (OSError, ValueError):
        return []
    out = []
    for el in data.get("elements") or []:
        cp = ((el or {}).get("customData") or {}).get("codePaths")
        if isinstance(cp, list) and cp and not el.get("isDeleted"):
            out.append((str(el.get("id")), [str(x) for x in cp]))
    return out


def node_for(path: str, links: list[tuple[str, list[str]]]) -> str | None:
    p = path.replace("\\", "/")
    p = p[2:] if p.startswith("./") else p
    if not p or p.startswith("/"):
        return None
    best: tuple[int, str] | None = None
    for el, globs in links:
        for g in globs:
            if glob_re(g).match(p):
                s = specificity(g)
                if best is None or s > best[0]:
                    best = (s, el)
    return best[1] if best else None


# ——— one run's timeline ———
_cache: dict[tuple[str, str, bool], tuple[tuple[int, float], dict[str, Any]]] = {}


def timeline(kind: str, path: Path | None, root: str | None, *, child: bool = False) -> dict[str, Any]:
    """Project a run's log into lane segments and turn spans (cached until the file changes)."""
    empty = {"segments": [], "turns": [], "busy": False, "startedAt": None, "endedAt": None, "lastAt": None, "items": []}
    a = ADAPTERS.get(kind)
    if a is None or path is None or not hasattr(a, "project"):
        return empty
    try:
        st_ = path.stat() if path.is_file() else None
        sig = (st_.st_size, st_.st_mtime) if st_ else (0, time.time())
    except OSError:
        return empty
    key = (str(path), str(root), child)
    hit = _cache.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    project = getattr(a, "project_child", None) if child else None
    project = project or a.project
    st = State(root=root)
    items: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    turns: list[dict[str, Any]] = []
    n = 0
    open_turn: dict[str, Any] | None = None
    reader = getattr(a, "read_records", None)
    for rec in (reader(path) if reader else read_jsonl(path)):
        try:
            its, tcs = project(rec, st)
        except Exception:
            continue
        for it in its:
            prev = items.get(it["id"])
            if prev is None:
                order.append(it["id"])
                items[it["id"]] = it
            else:
                items[it["id"]] = {**prev, **{k: v for k, v in it.items() if k != "tool"}, "tool": {**(prev.get("tool") or {}), **(it.get("tool") or {})}, "at": prev["at"]} if it["kind"] == "tool" else {**prev, **it}
        for tc in tcs:
            if tc["turn"] == "start":
                n += 1
                open_turn = {"n": n, "start": None, "end": None}
                turns.append(open_turn)
            elif tc["turn"] == "end" and open_turn is not None:
                open_turn["closed"] = True
    all_items = [items[i] for i in order]
    # Turn spans from the items (a turn = from its user message to its end item / last activity).
    spans: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for it in all_items:
        if it["kind"] == "user":
            cur = {"n": len(spans) + 1, "start": it["at"], "end": it["at"]}
            spans.append(cur)
        elif cur is not None:
            cur["end"] = max(cur["end"], it.get("endAt") or it["at"])
    segs = []
    turn_of = lambda at: next((s["n"] for s in reversed(spans) if s["start"] <= at), 0)  # noqa: E731
    for it in all_items:
        if it["kind"] != "tool":
            continue
        tool = it.get("tool") or {}
        kind_ = "wait" if tool.get("waitsUser") else SEG_KIND.get(str(tool.get("activity") or "tools"), "exec")
        files = tool.get("files") or []
        reads = tool.get("reads") or []
        p = (files[0]["path"] if files else None) if kind_ == "write" else (reads[0] if kind_ == "read" and reads else (files[0]["path"] if files else None))
        end = it.get("endAt") or it["at"]
        seg = {"kind": kind_, "start": it["at"], "end": max(end, it["at"] + MIN_TOOL_MS), "itemId": it["id"], "turn": turn_of(it["at"]), "label": f"{tool.get('name') or '工具'} {str(tool.get('input') or '')[:80]}".strip()}
        if p:
            seg["path"] = p
        if tool.get("spawn"):
            seg["spawn"] = tool["spawn"]
        segs.append(seg)
    ats = [i["at"] for i in all_items if i.get("at")]
    out = {
        "segments": segs,
        "turns": spans,
        "busy": st.busy,
        "startedAt": min(ats) if ats else None,
        "endedAt": None if st.busy else (max(ats) if ats else None),
        "lastAt": max([*ats, *(i.get("endAt") or 0 for i in all_items)]) if ats else None,
        "items": all_items,
        **({"timesInferred": True} if getattr(a, "times_inferred", False) else {}),
    }
    _cache[key] = (sig, out)
    if len(_cache) > 500:
        for k in list(_cache)[:100]:
            _cache.pop(k, None)
    return out


def _state(ref_state: str | None, tl: dict[str, Any], path: Path | None) -> str:
    fresh = False
    try:
        fresh = path is not None and time.time() - path.stat().st_mtime < RUNNING_S
    except OSError:
        pass
    if ref_state in ("done", "failed", "blocked", "exited"):
        return ref_state
    if tl.get("segments") and tl["segments"][-1]["kind"] == "wait" and tl.get("busy"):
        return "waiting"
    if fresh or (ref_state == "running" and tl.get("busy")):
        return "running"
    if ref_state == "dispatched":
        return "dispatched" if not tl.get("segments") else "unknown"
    if ref_state == "running":
        return "unknown"  # an edge still open but nothing written lately: not drawn as running
    return "idle" if not tl.get("busy") else "unknown"


def _moments(parent: dict[str, Any], child: dict[str, Any], ref: NativeRef, items: list[dict[str, Any]]) -> None:
    m = ref.meta
    tcid = ref.parent.tool_call_id if ref.parent else None
    at = m.get("dispatchedAt")
    if at is None and tcid:
        at = next((i["at"] for i in items if i["id"] == tcid), None)
    if at is not None:
        parent["timeline"]["moments"].append({"kind": "dispatch", "at": at, "childRunId": child["id"], **({"toolCallId": tcid} if tcid else {})})
    if m.get("doneAt"):
        parent["timeline"]["moments"].append({"kind": "handoff", "at": m["doneAt"], "childRunId": child["id"], "state": child["state"], **({"toolCallId": tcid} if tcid else {})})


def run_of(ref: NativeRef, root: str | None, *, depth: int, links: list | None = None, child: bool = True, session_id: str | None = None, with_items: bool = False) -> dict[str, Any]:
    tl = timeline(ref.kind, ref.path, root, child=child and ref.kind == "claude")
    if links:
        for s in tl["segments"]:
            if s.get("path"):
                n = node_for(s["path"], links)
                if n:
                    s["node"] = n
    a = ADAPTERS.get(ref.kind)
    state = _state(ref.meta.get("state"), tl, ref.path)
    run = {
        "id": ref.run_id,
        "kind": ref.kind,
        "nativeId": ref.native_id,
        # What Agora can do with this run: an Agora session is T1; anything else it only observes.
        "tier": "T1" if session_id and a is not None and implemented_tier(a) == "T1" else (implemented_tier(a) if a is not None and implemented_tier(a) != "T1" else "T2"),
        "label": ref.label or ref.native_id,
        "depth": depth,
        "state": state,
        "startedAt": ref.meta.get("dispatchedAt") or tl["startedAt"],
        "endedAt": ref.meta.get("doneAt") or (tl["endedAt"] if state in ("done", "failed", "idle") else None),
        "lastAt": tl["lastAt"],
        "hiddenDescendants": 0,
        "timeline": {"segments": tl["segments"], "turns": tl["turns"], "moments": [], **({"timesInferred": True} if tl.get("timesInferred") else {})},
    }
    for k in ("role", "model"):
        if ref.meta.get(k):
            run[k] = ref.meta[k]
    if session_id:
        run["sessionId"] = session_id
    if ref.path is not None:
        run["logPath"] = str(ref.path)
    if ref.cwd:
        run["cwd"] = ref.cwd
        if root and os.path.realpath(ref.cwd) != os.path.realpath(root):
            run["worktree"] = ref.cwd
    if ref.parent is not None:
        run["parent"] = {"runId": ref.parent.parent_run, "via": ref.parent.via, "evidence": ref.parent.evidence, **({"toolCallId": ref.parent.tool_call_id} if ref.parent.tool_call_id else {}), **({"taskId": ref.parent.task_id} if ref.parent.task_id else {})}
    if with_items:
        run["items"] = tl["items"]
    run["_items"] = tl["items"]
    return run


def build(ref: NativeRef, *, root: str | None, session_id: str | None = None, depth: int | None = 1, store: Any = None, canvas: str | None = None, with_items: bool = False, receipts: bool = True, home: Path | None = None) -> dict[str, Any]:
    """The run tree under ``ref``. ``depth`` levels are expanded (None = all); deeper runs are only
    counted (``folded`` and the ancestor's ``hiddenDescendants``)."""
    links = canvas_links(store, canvas) if store is not None and canvas else None
    top = run_of(ref, root, depth=0, links=links, child=False, session_id=session_id, with_items=with_items)
    runs: dict[str, dict[str, Any]] = {top["id"]: top}
    folded: dict[str, int] = {}
    # (ref, its run — or the expanded ancestor it is folded into —, whether it is folded)
    queue: list[tuple[NativeRef, dict[str, Any], bool]] = [(ref, top, False)]
    seen = {top["id"]}
    hidden_parent: dict[str, dict[str, Any]] = {}  # folded run id → the expanded ancestor counting it
    while queue:
        pref, prun, is_folded = queue.pop(0)
        a = ADAPTERS.get(pref.kind)
        if a is None or not isinstance(a, Subagents):
            continue
        try:
            kids = a.children(pref, home)
        except Exception:
            kids = []
        for kref in kids:
            if kref.run_id in seen:
                continue
            seen.add(kref.run_id)
            # Claude lists every level in one folder; a nested agent names its parent agent.
            pid = kref.parent.parent_run if kref.parent else None
            parent_run = runs.get(pid or "") or hidden_parent.get(pid or "") or prun
            folded_into = hidden_parent.get(pid or "") or (prun if is_folded else None)
            kd = (parent_run["depth"] + 1) if folded_into is None else depth + 1  # type: ignore[operator]
            if folded_into is not None or (depth is not None and kd > depth):
                anc = folded_into or parent_run
                folded[anc["id"]] = folded.get(anc["id"], 0) + 1
                anc["hiddenDescendants"] += 1
                hidden_parent[kref.run_id] = anc
                queue.append((kref, anc, True))
                continue
            krun = run_of(kref, root, depth=kd, links=links, with_items=with_items)
            runs[krun["id"]] = krun
            _moments(parent_run, krun, kref, parent_run["_items"])
            queue.append((kref, krun, False))
    if receipts and store is not None:
        try:
            from server.canvas.adapters import receipts as rc
        except ImportError:
            rc = None
        if rc is not None:
            rc.attach(runs, root=root, store=store, depth=depth, folded=folded, links=links, home=home)
    for r in runs.values():
        r.pop("_items", None)
        r["timeline"]["moments"].sort(key=lambda m: m["at"])
        r["childCount"] = sum(1 for x in runs.values() if (x.get("parent") or {}).get("runId") == r["id"])
    ordered = sorted(runs.values(), key=lambda r: (r["depth"], r.get("startedAt") or 0))
    return {"root": top["id"], "runs": ordered, "folded": folded, "depth": depth, "generatedAt": int(time.time() * 1000)}
