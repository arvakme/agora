"""The diagram-quality half of ``agora canvas`` on the server: ``lint``, ``layout``, and what ``apply`` does around them.

Kept out of ``AgentHub`` (sessions.py) on purpose: the hub only asks (1) *before* an edit, ``expand`` — a batch ending in a
``layout`` op becomes plain ops (graph_ops.py); (2) *after* it, ``annotate`` — the answer carries how the diagram measures now
(graph_lint.py). Both read the scene the way ``agora canvas read`` does: from the open page, else from the file, so they work the
same when the server is the only executor. Nothing here draws: layout and lint are pure functions of a scene.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from server.canvas import graph_lint, graph_ops
if TYPE_CHECKING:
    from server.canvas.sessions import AgentHub


async def scene_of(hub: AgentHub, cid: str, session: str | None) -> dict[str, Any]:
    return (await hub.canvas_read(cid, session))["scene"]


async def expand(hub: AgentHub, cid: str, session: str | None, ops: list[Any]) -> tuple[list[Any], dict[str, Any] | None]:
    """``ops`` with a trailing ``layout`` op turned into plain ops, and what it decided (None: no layout op)."""
    if not any(isinstance(o, dict) and o.get("op") == graph_ops.LAYOUT for o in ops):
        return ops, None
    scene = await scene_of(hub, cid, session)
    return await asyncio.to_thread(graph_ops.expand_layout, scene, ops)  # a few seconds of arithmetic: not on the event loop


async def annotate(hub: AgentHub, cid: str, session: str | None, result: dict[str, Any], layout: dict[str, Any] | None) -> dict[str, Any]:
    """An applied answer with the diagram's measure (and what layout did) added; any other answer as it is."""
    if result.get("status") != "applied":
        return result
    out = {**result, **({"layout": layout} if layout else {})}
    try:
        out["lint"] = graph_lint.brief(graph_lint.lint(await scene_of(hub, cid, session)))
    except Exception as e:  # the edit is done; say that the measure is missing rather than pretend it is clean
        out["lint"] = {"error": f"改图已完成，但没能量出结果：{e}"}
    return out


async def canvas_lint(hub: AgentHub, canvas: str | None, session: str | None) -> dict[str, Any]:
    from server.canvas.sessions import canvas_names, resolve_canvas  # (sessions imports this module)

    cid = resolve_canvas(hub.store, canvas, session)
    return {"canvas": {"id": cid, "name": canvas_names(hub.store).get(cid, cid)}, **graph_lint.lint(await scene_of(hub, cid, session))}


async def canvas_layout(hub: AgentHub, canvas: str | None, session: str | None, nodes: list[str] | None, everything: bool, apply: bool, note: str | None) -> dict[str, Any]:
    """Re-arrange nodes that are already on the canvas. Says first what would move and how the diagram measures
    before and after; only ``apply`` touches the canvas. (New nodes are laid out by the ``layout`` op of ``apply``.)"""
    if not nodes and not everything:
        raise ValueError("要说清楚排哪些：`--nodes a,b,c`（写 id）或 `--all`（整张图）。只排你刚画的新节点，不用这条：在 apply 的 ops 末尾加 {\"op\": \"layout\"}。")
    from server.canvas.sessions import resolve_canvas

    cid = resolve_canvas(hub.store, canvas, session)
    read = await hub.canvas_read(cid, session)
    plan = await asyncio.to_thread(graph_ops.plan_reflow, read["scene"], None if everything else nodes)
    head = {"canvas": {"id": cid, "name": read["canvas"].get("name")}, "willMove": plan["moves"], "before": graph_lint.brief(plan["before"]), "after": graph_lint.brief(plan["after"])}
    if not plan["ops"]:
        return {"status": "nothing", **head, "note": "现在的摆法已经是排出来的结果，没有要动的。"}
    if not apply:
        return {"status": "preview", **head, "next": "确认要动这些节点，再加 --apply 执行（一次可撤销）。"}
    got = await hub.canvas_apply(cid, session, read["base"], plan["ops"], note)
    return {**got, **head}
