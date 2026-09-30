"""The model-facing view of a canvas, computed from its ``.excalidraw`` file.

Python twin of ``web/src/canvas/modelView.ts`` (``toModelView``) and ``versionOf`` in
``web/src/canvas/scene.ts``: when no page is open, ``agora canvas read`` still answers
from the project's files. With a page open the live scene is read through the page
instead (it may hold edits the debounced autosave has not written yet).
"""

from __future__ import annotations

import math
from typing import Any

from server.canvas.graph_geom import default_path

SHAPES = ("rectangle", "ellipse", "diamond")
PLAIN_SLACK = 8  # a straight arrow whose ends are this close to where the page would put them is "plain"


def _r(v: Any) -> int:
    return int(math.floor(float(v or 0) + 0.5))  # JS Math.round


def _live(e: dict[str, Any] | None) -> bool:
    return bool(e) and not e.get("isDeleted")


def library_meta(e: dict[str, Any] | None) -> dict[str, Any] | None:
    m = ((e or {}).get("customData") or {}).get("agora")
    return m if isinstance(m, dict) and m.get("library") else None


def code_paths(e: dict[str, Any] | None) -> list[str]:
    """Code paths (globs) the element stands for — ``customData.codePaths`` (progress pointer)."""
    v = ((e or {}).get("customData") or {}).get("codePaths")
    return [str(x) for x in v if isinstance(x, str) and x] if isinstance(v, list) else []


def is_junction(e: dict[str, Any] | None) -> bool:
    """A small dot where several lines meet (``customData.junction``): geometry lines end on, not a node."""
    return bool(((e or {}).get("customData") or {}).get("junction"))


def child_canvas(e: dict[str, Any] | None) -> str | None:
    """The canvas this node opens into — ``customData.childCanvas`` (nested canvases)."""
    v = ((e or {}).get("customData") or {}).get("childCanvas")
    return v if isinstance(v, str) and v else None


def bound_text(e: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    for b in e.get("boundElements") or []:
        if b.get("type") == "text":
            t = by_id.get(b.get("id"))
            if t and not t.get("isDeleted") and t.get("type") == "text":
                return t
    return None


def label_of(e: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> str:
    if e.get("type") == "text":
        return str(e.get("text") or "")
    lib = library_meta(e)
    if lib:
        t = by_id.get(lib.get("label") or "")
        return str(t["text"]) if t and not t.get("isDeleted") and t.get("type") == "text" else str(lib.get("name") or "")
    if e.get("type") == "frame":
        return str(e.get("name") or "")
    t = bound_text(e, by_id)
    return str(t.get("text") or "") if t else ""


def version_of(e: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> str:
    t = bound_text(e, by_id)
    return f"{e.get('version')}.{t.get('version')}" if t else f"{e.get('version')}"


def model_view(elements: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {e["id"]: e for e in elements if "id" in e}
    lib_groups = {library_meta(e)["group"] for e in elements if not e.get("isDeleted") and library_meta(e)}

    def inside(e: dict[str, Any]) -> bool:
        return not library_meta(e) and any(g in lib_groups for g in e.get("groupIds") or [])

    live = [e for e in elements if not e.get("isDeleted") and not inside(e)]
    nodes = []
    for e in live:
        if e.get("type") not in SHAPES or is_junction(e):
            continue
        lib = library_meta(e)
        n: dict[str, Any] = {"id": e["id"], "type": "library" if lib else e["type"]}
        if lib:
            n["component"] = lib.get("name")
        n.update(label=label_of(e, by_id), x=_r(e.get("x")), y=_r(e.get("y")), width=_r(e.get("width")), height=_r(e.get("height")))
        if e.get("frameId"):
            n["frameId"] = e["frameId"]
        if code_paths(e):
            n["codePaths"] = code_paths(e)
        if child_canvas(e):
            n["child"] = {"canvasId": child_canvas(e)}
        nodes.append(n)
    arrows = []
    for e in live:
        if e.get("type") != "arrow":
            continue
        a: dict[str, Any] = {
            "id": e["id"],
            "type": "arrow",
            "start": {"id": e["startBinding"]["elementId"]} if e.get("startBinding") else None,
            "end": {"id": e["endBinding"]["elementId"]} if e.get("endBinding") else None,
        }
        label = label_of(e, by_id)
        if label:
            a["label"] = label
        if e.get("startArrowhead"):
            a["bothEnds"] = True
        path = _drawn_path(e, live)
        if path:
            a["path"] = path
        arrows.append(a)
    frames = [
        {
            "id": e["id"],
            "type": "frame",
            "name": label_of(e, by_id),
            "x": _r(e.get("x")),
            "y": _r(e.get("y")),
            "width": _r(e.get("width")),
            "height": _r(e.get("height")),
            "children": [c["id"] for c in live if c.get("frameId") == e["id"] and c.get("type") in SHAPES],
            **({"codePaths": code_paths(e)} if code_paths(e) else {}),
            **({"child": {"canvasId": child_canvas(e)}} if child_canvas(e) else {}),
        }
        for e in live
        if e.get("type") == "frame"
    ]
    junctions = [{"id": e["id"], "x": _r(e.get("x")), "y": _r(e.get("y")), "width": _r(e.get("width")), "height": _r(e.get("height"))} for e in live if e.get("type") in SHAPES and is_junction(e)]
    return {"nodes": nodes, "arrows": arrows, "frames": frames, **({"junctions": junctions} if junctions else {})}


def _drawn_path(e: dict[str, Any], live: list[dict[str, Any]]) -> list[list[int]] | None:
    """The line's absolute points, when it is not the plain straight arrow the page draws between its two nodes."""
    pts = [[float(e["x"]) + float(p[0]), float(e["y"]) + float(p[1])] for p in e.get("points") or []]
    if len(pts) < 2:
        return None
    ends = [(e.get("startBinding") or {}).get("elementId"), (e.get("endBinding") or {}).get("elementId")]
    shapes = {s["id"]: s for s in live if s.get("type") in SHAPES}
    if len(pts) == 2 and all(i in shapes for i in ends):
        plain = default_path(shapes[ends[0]], shapes[ends[1]])
        if all(abs(p[0] - q[0]) <= PLAIN_SLACK and abs(p[1] - q[1]) <= PLAIN_SLACK for p, q in zip(pts, plain)):
            return None
    return [[_r(x), _r(y)] for x, y in pts]


def versions(elements: list[dict[str, Any]]) -> dict[str, str]:
    """Freshness tokens for every live element (same strings the page computes)."""
    by_id = {e["id"]: e for e in elements if "id" in e}
    return {e["id"]: version_of(e, by_id) for e in elements if _live(e)}
