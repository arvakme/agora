"""The ``layout`` op: turns "draw these, and arrange them" into plain ops.

An agent sends its new shapes and arrows and ends the batch with ``{"op": "layout"}``; this module
lays them out (``graph_layout``: upstream on top, few crossings, the existing nodes untouched) and
hands back the same batch with the coordinates and drawn paths filled in. Whoever executes the ops
(the open page, or the server's fallback executor) never sees a ``layout`` op, so neither needs to know
how a diagram is arranged.

``{"op": "layout", "bus": true}`` draws fans of four or more lines as a trunk to a junction dot.
``{"op": "layout", "reflow": ["id", …]}`` also re-arranges those *existing* nodes: the only way to
move what is already on the canvas, and ``plan_reflow`` (``agora canvas layout``) says first what moves.
"""

from __future__ import annotations

from typing import Any

from .graph_geom import fit_size
from .graph_layout import apply_layout, layout
from .graph_lint import lint

LAYOUT = "layout"
DEFAULT_SIZE = (160, 64)  # what the page gives an add_shape without a size
LAYOUT_OP_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"op": {"const": LAYOUT}, "bus": {"type": "boolean"}, "reflow": {"type": "array", "items": {"type": "string"}}},
    "required": ["op"],
}


def with_layout_op(schema: dict[str, Any]) -> dict[str, Any]:
    """The plan schema an agent sees (``agora canvas schema ops``) with the ``layout`` op, which the server handles itself."""
    items = schema["properties"]["ops"]["items"]
    return {**schema, "properties": {**schema["properties"], "ops": {**schema["properties"]["ops"], "items": {**items, "anyOf": [*items["anyOf"], LAYOUT_OP_SCHEMA]}}}}


def _label(n: dict[str, Any]) -> str:
    return str(n.get("label") or n["id"])


def _simulate(scene: dict[str, Any], ops: list[dict[str, Any]]) -> tuple[dict[str, Any], list[str], dict[int, str]]:
    """The scene as the batch will leave it (new shapes at their given spot, new lines with a stand-in id),
    the refs of the new shapes, and the stand-in id of each add_arrow op."""
    nodes = {n["id"]: dict(n) for n in scene["nodes"]}
    arrows = {a["id"]: dict(a) for a in scene["arrows"]}
    new: list[str] = []
    lines: dict[int, str] = {}
    for i, o in enumerate(ops):
        kind = o.get("op")
        if kind == "add_shape":
            fit = fit_size(o.get("text", ""), o.get("shape", "rectangle"), DEFAULT_SIZE)  # a shape the agent did not size is sized to its label
            nodes[o["ref"]] = {"id": o["ref"], "type": o.get("shape", "rectangle"), "label": o.get("text", ""), "x": o.get("x", 0), "y": o.get("y", 0), "width": o.get("width", fit[0]), "height": o.get("height", fit[1])}
            new.append(o["ref"])
        elif kind == "add_arrow":
            lines[i] = f"new:{i}"
            arrows[lines[i]] = {"id": lines[i], "type": "arrow", "start": {"id": o["from"]}, "end": {"id": o["to"]}, **({"label": o["text"]} if o.get("text") else {})}
        elif kind == "delete":
            nodes.pop(o["id"], None)
            arrows.pop(o["id"], None)
        elif kind == "move" and o["id"] in nodes:
            nodes[o["id"]].update(x=o["x"], y=o["y"])
        elif kind == "resize" and o["id"] in nodes:
            nodes[o["id"]].update(width=o["width"], height=o["height"])
    sim = {**scene, "nodes": list(nodes.values()), "arrows": [a for a in arrows.values() if all(e in nodes or e in {j["id"] for j in scene.get("junctions", [])} for e in ((a.get("start") or {}).get("id"), (a.get("end") or {}).get("id")))]}
    return sim, new, lines


def expand_layout(scene: dict[str, Any], ops: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """``ops`` with the ``layout`` op replaced by what it decides, and what it did (None: there was no layout op)."""
    out, info, _ = _expand(scene, ops)
    return out, info


def _expand(scene: dict[str, Any], ops: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any] | None, dict[str, Any] | None]:
    marks = [i for i, o in enumerate(ops) if isinstance(o, dict) and o.get("op") == LAYOUT]
    if not marks:
        return ops, None, None
    if marks != [len(ops) - 1]:
        raise ValueError("layout 要放在这一批 ops 的最后一条，而且只能有一条：它排的是前面这些 ops 画出来的东西。")
    spec = ops[-1]
    body = ops[:-1]
    sim, new, lines = _simulate(scene, body)
    reflow = list(spec.get("reflow") or [])
    have = {n["id"] for n in sim["nodes"]}
    for i in reflow:
        if i not in have:
            raise ValueError(f"layout.reflow 里的 {i} 不在画布上：先 `agora canvas read` 看现有的 id。")
    nodes_by_ref = {n["id"]: n for n in sim["nodes"]}
    movable = set(new) | set(reflow)
    ends = lambda a: {(a.get("start") or {}).get("id"), (a.get("end") or {}).get("id")}  # noqa: E731
    routed = list(dict.fromkeys([*lines.values(), *(a["id"] for a in sim["arrows"] if ends(a) & movable)]))  # every new line, and the old ones on a node that moves
    res = layout(sim, movable, arrows=routed, bus=bool(spec.get("bus")) and not reflow)
    out: list[dict[str, Any]] = []
    junction_ops = [{"op": "add_junction", "ref": j["id"], "x": j["x"], "y": j["y"]} for j in res["junctions"]]
    for i, o in enumerate(body):
        if o.get("op") == "add_shape" and o["ref"] in res["nodes"]:
            sized = {k: nodes_by_ref[o["ref"]][k] for k in ("width", "height") if k not in o and nodes_by_ref[o["ref"]][k] != DEFAULT_SIZE[k == "height"]}
            o = {**o, **res["nodes"][o["ref"]], **sized}
        elif o.get("op") == "add_arrow" and i in lines:
            change = res["arrows"].get(lines[i], {})
            o = {**o, **({"from": change["start"]} if "start" in change else {}), **({"to": change["end"]} if "end" in change else {}), **({"path": change["path"]} if change.get("path") else {}), **({"plain": True} if change.get("plain") else {})}
            if junction_ops:
                out += junction_ops
                junction_ops = []
        out.append(o)
    out += junction_ops
    for aid, change in res["arrows"].items():
        if change.get("new"):
            out.append({"op": "add_arrow", "ref": aid, "from": change["start"], "to": change["end"], **({"path": change["path"]} if "path" in change else {}), **({"plain": True} if change.get("plain") else {})})
    old = {n["id"]: n for n in scene["nodes"]}
    moved = [i for i in reflow if (res["nodes"][i]["x"], res["nodes"][i]["y"]) != (old[i]["x"], old[i]["y"])]
    out += [{"op": "move", "id": i, "x": res["nodes"][i]["x"], "y": res["nodes"][i]["y"]} for i in moved]
    existing = {a["id"] for a in scene["arrows"]}
    rerouted = [aid for aid, c in res["arrows"].items() if aid in existing and "path" in c]
    out += [{"op": "route", "id": aid, "path": res["arrows"][aid]["path"]} for aid in rerouted]  # path None: the plain straight arrow
    return out, {"placed": new, "moved": moved, "junctions": [j["id"] for j in res["junctions"]], "rerouted": rerouted}, res


def plan_reflow(scene: dict[str, Any], ids: list[str] | None) -> dict[str, Any]:
    """What re-arranging existing nodes would do, without doing it: the ops, which nodes move and
    where, and the diagram measured before and after. ``ids`` None = every node on the canvas."""
    every = [n["id"] for n in scene["nodes"]]
    chosen = every if ids is None else list(ids)
    for i in chosen:
        if i not in every:
            raise ValueError(f"{i} 不在这张画布上。")
    ops, info, res = _expand(scene, [{"op": LAYOUT, "reflow": chosen}])
    old = {n["id"]: n for n in scene["nodes"]}
    moves = [{"id": i, "label": _label(old[i]), "from": [old[i]["x"], old[i]["y"]], "to": [res["nodes"][i]["x"], res["nodes"][i]["y"]]} for i in (info or {}).get("moved", [])]
    return {"ops": ops, "moves": moves, "before": lint(scene), "after": lint(apply_layout(scene, res))}
