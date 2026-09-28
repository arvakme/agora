"""Nested canvases from the project files (web/docs/nested-canvas.md).

A diagram node opens a child canvas when its ``customData.childCanvas`` holds that canvas's id.
Nothing else records the relation: parents, breadcrumbs and a share's reachable canvases are
derived from the ``.excalidraw`` files. Python twin of ``web/src/nested/graph.ts`` (the parts the
server needs: ``agora canvas read`` / ``child list`` and the share gateway's whitelist).
"""

from __future__ import annotations

from typing import Any

from server.canvas.model_view import label_of
from server.canvas.project import ID_RE, ProjectStore

NODE_TYPES = ("rectangle", "ellipse", "diamond", "frame")


def child_of(e: dict[str, Any] | None) -> str | None:
    v = ((e or {}).get("customData") or {}).get("childCanvas")
    return v if isinstance(v, str) and ID_RE.match(v) else None


def scenes(store: ProjectStore) -> dict[str, list[dict[str, Any]]]:
    """Every canvas's live elements, by id (in file-name order, which fixes "first parent wins")."""
    out: dict[str, list[dict[str, Any]]] = {}
    for p in sorted((store.dir / "canvases").glob("*.excalidraw")):
        cid = p.name.removesuffix(".excalidraw")
        if not ID_RE.match(cid):
            continue
        got = store.read("canvas", cid)
        out[cid] = [e for e in ((got or ({}, ""))[0].get("elements") or []) if not e.get("isDeleted")]
    return out


def child_links(elements: list[dict[str, Any]], exists) -> list[tuple[str, str]]:
    """(node id, child canvas id) for live nodes whose child canvas exists."""
    return [(e["id"], c) for e in elements if e.get("type") in NODE_TYPES and not e.get("isDeleted") and (c := child_of(e)) and exists(c)]


def parent_index(sc: dict[str, list[dict[str, Any]]]) -> dict[str, tuple[str, str]]:
    """child canvas → (parent canvas, node). First link wins; self links are ignored."""
    out: dict[str, tuple[str, str]] = {}
    for cid, els in sc.items():
        for node, child in child_links(els, sc.__contains__):
            if child != cid and child not in out:
                out[child] = (cid, node)
    return out


def ancestry(cid: str, index: dict[str, tuple[str, str]]) -> list[str]:
    chain = [cid]
    seen = {cid}
    p = index.get(cid)
    while p and p[0] not in seen:
        chain.insert(0, p[0])
        seen.add(p[0])
        p = index.get(p[0])
    return chain


def descendants(cid: str, sc: dict[str, list[dict[str, Any]]]) -> set[str]:
    out: set[str] = set()
    todo = [cid]
    while todo:
        cur = todo.pop()
        for _, child in child_links(sc.get(cur, []), sc.__contains__):
            if child != cid and child not in out:
                out.add(child)
                todo.append(child)
    return out


def reachable(store: ProjectStore, root: str) -> set[str]:
    """A canvas and every canvas below it: what a share of ``root`` lets a guest open."""
    return {root} | descendants(root, scenes(store))


def annotate(store: ProjectStore, cid: str, view: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
    """Add nesting to a model view: each node's ``child``, the canvas's ``parent`` and ``path``."""
    sc = scenes(store)
    for group in ("nodes", "frames"):
        for n in view.get(group) or []:
            child = (n.get("child") or {}).get("canvasId")
            if child and (child in sc or child in names):
                n["child"] = {"canvasId": child, "name": names.get(child, child)}
            else:
                n.pop("child", None)
    index = parent_index(sc)
    chain = ancestry(cid, index)
    if len(chain) > 1:  # only nested canvases carry a breadcrumb
        view["path"] = [{"canvasId": c, "name": names.get(c, c)} for c in chain]
    if cid in index:
        pc, node = index[cid]
        pmap = {e["id"]: e for e in sc.get(pc, []) if "id" in e}
        view["parent"] = {"canvasId": pc, "name": names.get(pc, pc), "nodeId": node, "nodeLabel": label_of(pmap[node], pmap) if node in pmap else node}
    return view


def list_children(store: ProjectStore, cid: str, names: dict[str, str]) -> list[dict[str, Any]]:
    sc = scenes(store)
    by_id = {e["id"]: e for e in sc.get(cid, []) if "id" in e}
    return [
        {"nodeId": node, "nodeLabel": label_of(by_id[node], by_id), "canvasId": child, "name": names.get(child, child), "children": len(child_links(sc.get(child, []), sc.__contains__))}
        for node, child in child_links(sc.get(cid, []), sc.__contains__)
    ]
