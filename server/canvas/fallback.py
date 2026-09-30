"""The server as the executor of last resort (BR2): ``agora canvas apply`` when no page could take the edit.

Deliberately small. It checks what the page checks — the plan's structure (schemas.py), its references (plan_rules.py, the same rule file
the page's validatePlan reads) and freshness against the agent's read — and then writes the ``.agora/canvases/<id>.excalidraw`` file with
the same undo record a page writes (a turn, one batch). It does NOT carry a second copy of the page's drawing engine (``applyPlan``,
web/src/ops/apply.ts: layout, arrow routing, library components): it only does what needs none of that — today, changing the text of a
node or a frame — and says ``这条要打开页面才能做`` for everything else, before touching anything. A page that connects later just loads
the file (a hand edit it made meanwhile is a conflict it reports, never an overwrite: project.py's versioned writes).

``EXTRA_OPS`` is where a layout / lint module can register more ops it is able to do without a page.
"""

from __future__ import annotations

import copy
import json
import secrets
import time
from collections.abc import Callable
from typing import Any

from server.canvas import plan_rules, schemas
from server.canvas.model_view import bound_text, label_of, library_meta
from server.canvas.project import Conflict, ProjectStore

NEEDS_PAGE = "这条要打开页面才能做"
SUPPORTED = {"update_text"}
# op name → (can_do(op, scene) -> str | None (the reason it cannot), do(op, scene, put) -> summary line): more ops, when they need no page.
EXTRA_OPS: dict[str, tuple[Callable[..., Any], Callable[..., Any]]] = {}


def _ms() -> int:
    return int(time.time() * 1000)


def _bump(e: dict[str, Any], **fields: Any) -> dict[str, Any]:
    return {**e, **fields, "version": int(e.get("version") or 0) + 1, "versionNonce": secrets.randbits(31), "updated": _ms()}


def _cannot(op: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> str | None:
    """Why the server cannot do this op (None = it can)."""
    name = op["op"]
    if name in EXTRA_OPS:
        return EXTRA_OPS[name][0](op, by_id)
    if name not in SUPPORTED:
        return f"{name} 要摆放、连线或改几何，服务端直接改文件只能改节点文字"
    e = by_id[op["id"]]
    if e.get("type") == "frame":
        return None
    if e.get("type") == "arrow" or library_meta(e):
        return "箭头和素材库组件的文字要重新排版"
    if bound_text(e, by_id) is None:
        return "这个节点还没有文字元素，要新建一个"
    return None


def apply(store: ProjectStore, canvas_id: str, session_id: str | None, plan: dict[str, Any], versions: dict[str, str]) -> dict[str, Any]:
    note = plan.get("note")
    got = store.read("canvas", canvas_id)
    if got is None:
        return {"status": "error", "errors": [f"canvas {canvas_id} has no file"]}
    data, file_version = got
    elements: list[dict[str, Any]] = list(data.get("elements") or [])
    ops = plan.get("ops")
    if isinstance(ops, list) and not ops:
        return {"status": "empty", "note": note}
    errors = schemas.validate(schemas.load("plan.schema.json"), plan) or plan_rules.validate_plan(plan, kind=plan_rules.scene_kinds(elements), library_item=lambda _id: True)  # the library is not the server's: library ops are refused below
    if errors:
        return {"status": "invalid", "errors": errors}
    by_id = {e["id"]: e for e in elements if "id" in e}
    for i, op in enumerate(plan["ops"]):
        why = _cannot(op, by_id)
        if why:
            return {"status": "needs-page", "errors": [f"ops[{i}]（{op['op']}）：{NEEDS_PAGE}：{why}。一条计划里只要有一条做不了，整条都不会被执行。"]}
    watched = list(dict.fromkeys(plan_rules.referenced_ids(plan)))
    stale = plan_rules.stale_ids(versions, watched, elements)
    if stale:
        return {"status": "stale", "stale": stale, "errors": [f"changed since your read: {', '.join(stale)} — run `agora canvas read` again"]}

    work = dict(by_id)
    before: dict[str, dict[str, Any] | None] = {}
    touched: list[str] = []
    summary: list[str] = []

    def put(e: dict[str, Any]) -> None:
        before.setdefault(e["id"], copy.deepcopy(work.get(e["id"])))
        work[e["id"]] = e
        if e["id"] not in touched:
            touched.append(e["id"])

    for op in plan["ops"]:
        if op["op"] in EXTRA_OPS:
            summary.append(EXTRA_OPS[op["op"]][1](op, work, put))
            continue
        e = work[op["id"]]
        prev = label_of(e, work)
        if e.get("type") == "frame":
            put(_bump(e, name=op["text"]))
        else:
            t = bound_text(e, work)
            put(_bump(e))
            put(_bump(t, text=op["text"], originalText=op["text"]))
        summary.append(f"改文字 {f'「{prev}」' if prev else e['id']} → 「{op['text']}」")
    out = [work.get(e["id"], e) if e.get("id") in work else e for e in elements]
    try:
        store.write("canvas", canvas_id, {**data, "elements": out}, base=file_version)
    except Conflict:
        return {"status": "stale", "stale": watched, "errors": ["画布刚刚被改动了：`agora canvas read` 再读一次"]}
    batch_id = f"b-{secrets.token_hex(4)}"
    turn_id = _record(store, session_id, canvas_id, note, summary, batch_id, before, {i: work[i]["version"] for i in touched}, len(watched))
    return {"status": "applied", "source": "server-fallback", "summary": summary, "turnId": turn_id, "batchId": batch_id, "note": note}


def _record(store: ProjectStore, session_id: str | None, canvas_id: str, note: str | None, summary: list[str], batch_id: str, before: dict[str, Any], after: dict[str, int], watched: int) -> str | None:
    """The session's record of the change, in the shape a page writes (web/src/project/format.ts): the undo step of the batch."""
    got = store.read_session(session_id) if session_id else None
    if got is None:
        return None
    state, version = got
    session = state.get("session")
    if not session:
        return None
    now = _ms()
    turn_id = f"t-{secrets.token_hex(4)}"
    step = lambda kind, title, detail: {"id": f"st-{secrets.token_hex(3)}", "kind": kind, "title": title, "detail": detail, "startedAt": now, "endedAt": now, "status": "done"}  # noqa: E731
    turn = {
        "id": turn_id,
        "n": len(session.get("turnIds") or []) + 1,
        "sessionId": session_id,
        "canvasId": canvas_id,
        "origin": {"kind": "agent"},
        "request": note or f"改图 · {len(summary)} 个操作",
        "refs": [],
        "startedAt": now,
        "endedAt": now,
        "status": "applied",
        "steps": [
            step("check", "校验 + 新鲜度", f"schema ✓ · 引用 ✓ · {watched} 个元素版本未变 ✓"),
            step("apply", "服务端直接改文件（没有页面能执行；1 次可撤销修改）", f"{len(summary)} 处修改 · {len(after)} 个元素"),
        ],
        "reply": {"text": f"已修改 {len(summary)} 处{f'：{note}' if note else ''}（由服务端直接改文件）", "changes": summary, "batchId": batch_id},
    }
    records = [
        {"t": "session", "session": {**session, "turnIds": [*(session.get("turnIds") or []), turn_id]}},
        {"t": "turn", "turn": turn},
        {"t": "batch", "id": batch_id, "batch": {"before": [[i, e] for i, e in before.items()], "after": [[i, v] for i, v in after.items()]}},
    ]
    store.append_session(session_id, records, base=version)
    return turn_id


def dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)
