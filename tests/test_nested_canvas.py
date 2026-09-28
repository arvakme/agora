"""Nested canvases (web/docs/nested-canvas.md): parent nodes carry the child's id, reads show the
nesting, and a share lets guests step into the shared canvas's children — and nothing else."""

from __future__ import annotations

import json

import pytest

from server.canvas import nested
from server.canvas.model_view import model_view
from server.canvas.project import ProjectStore
from server.canvas.sessions import file_read

from tests.test_share import joined, make_share  # noqa: F401  (fixtures and helpers)
from tests.test_share import env  # noqa: F401


def box(id, child=None, paths=None, label_id=None):
    cd = {}
    if child:
        cd["childCanvas"] = child
    if paths:
        cd["codePaths"] = paths
    e = {"id": id, "type": "rectangle", "x": 0, "y": 0, "width": 100, "height": 60, "isDeleted": False, "customData": cd}
    if label_id:
        e["boundElements"] = [{"type": "text", "id": label_id}]
    return e


def text(id, container, t):
    return {"id": id, "type": "text", "x": 0, "y": 0, "width": 10, "height": 10, "isDeleted": False, "containerId": container, "text": t}


def seed(store: ProjectStore) -> None:
    """总架构 (c1) › 后端 (be) › 订单模块 (orders); 'secret' is another top-level canvas."""
    store.write("canvas", "c1", {"elements": [box("api", child="be", paths=["server/**"], label_id="api-t"), text("api-t", "api", "后端"), box("db")]}, base=None, force=True)
    store.write("canvas", "be", {"elements": [box("orders", child="orders", label_id="o-t"), text("o-t", "orders", "订单模块")]}, base=None, force=True)
    store.write("canvas", "orders", {"elements": [box("repo", paths=["server/orders/repo.py"])]}, base=None, force=True)
    store.write("canvas", "secret", {"elements": [box("x")]}, base=None, force=True)
    docs = [{"id": i, "kind": "canvas", "title": t} for i, t in (("c1", "架构图"), ("be", "后端"), ("orders", "订单模块"), ("secret", "私密"))]
    ws = store.read("workspace")
    store.write("workspace", None, {"v": 2, "docs": docs, "root": {}, "focused": "c1"}, base=None, force=True)


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "p")
    s.root.mkdir()
    s.init()
    seed(s)
    return s


def test_parents_breadcrumbs_and_reach_come_from_the_parent_nodes(store):
    sc = nested.scenes(store)
    idx = nested.parent_index(sc)
    assert idx == {"be": ("c1", "api"), "orders": ("be", "orders")}
    assert nested.ancestry("orders", idx) == ["c1", "be", "orders"]
    assert nested.reachable(store, "c1") == {"c1", "be", "orders"}
    assert nested.reachable(store, "be") == {"be", "orders"}
    assert nested.reachable(store, "secret") == {"secret"}


def test_a_loop_drawn_by_hand_does_not_hang(store):
    store.write("canvas", "orders", {"elements": [box("repo", child="c1")]}, base=store.read("canvas", "orders")[1])
    sc = nested.scenes(store)
    assert nested.descendants("c1", sc) == {"be", "orders"}
    chain = nested.ancestry("orders", nested.parent_index(sc))
    assert len(chain) == len(set(chain))


def test_read_shows_the_child_of_each_node_and_where_the_canvas_sits(store):
    assert model_view(store.read("canvas", "c1")[0]["elements"])["nodes"][0]["child"] == {"canvasId": "be"}
    top = file_read(store, "c1")["scene"]
    assert top["nodes"][0]["child"] == {"canvasId": "be", "name": "后端"}
    assert "child" not in top["nodes"][1]
    assert "parent" not in top and "path" not in top
    deep = file_read(store, "orders")["scene"]
    assert deep["parent"] == {"canvasId": "be", "name": "后端", "nodeId": "orders", "nodeLabel": "订单模块"}
    assert [p["name"] for p in deep["path"]] == ["架构图", "后端", "订单模块"]
    kids = nested.list_children(store, "c1", {"be": "后端"})
    assert kids == [{"nodeId": "api", "nodeLabel": "后端", "canvasId": "be", "name": "后端", "children": 1}]


def test_cli_child_list_and_read_without_server(store, capsys):
    from agora_cli.main import main

    code = main(["canvas", "--project", str(store.root), "child", "list", "--parent", "c1"])
    out = json.loads(capsys.readouterr().out)
    assert code == 0 and out["children"][0]["canvasId"] == "be"
    code = main(["canvas", "--project", str(store.root), "read", "--canvas", "orders"])
    out = json.loads(capsys.readouterr().out)
    assert code == 0 and out["canvas"]["parent"]["canvasId"] == "be" and "path" not in out["scene"]
    # Writes need the page: exit 3 without a server, 2 without --node.
    assert main(["canvas", "--project", str(store.root), "child", "create", "--parent", "c1", "--node", "db"]) == 3
    capsys.readouterr()


async def test_guests_step_into_children_of_the_shared_canvas_only(env):  # noqa: F811
    store, shares, dns, tunnels, clock, app = env
    seed(store)
    _, _, host, token = await make_share(app)
    g = await joined(app, host, token)
    st = (await g.get("/api/guest/state")).json()
    api = next(e for e in st["canvas"]["elements"] if e["id"] == "api")
    # Only the link survives: code paths and everything else in customData stay home.
    assert api["customData"] == {"childCanvas": "be"}
    assert "codePaths" not in json.dumps(st)
    assert set(st["canvases"]) == {"c1", "be", "orders"} and st["path"] == [{"id": "c1", "title": "架构图"}]
    deep = (await g.get("/api/guest/state", params={"canvas": "orders"})).json()
    assert [p["id"] for p in deep["path"]] == ["c1", "be", "orders"] and deep["canvas"]["title"] == "订单模块"
    # Another canvas of the project, or a made-up id: 403.
    assert (await g.get("/api/guest/state", params={"canvas": "secret"})).status_code == 403
    assert (await g.get("/api/guest/state", params={"canvas": "../x"})).status_code == 403
    # Comments on a child canvas land in that canvas's threads; anywhere else is refused.
    r = await g.post("/api/guest/comments", json={"op": "create", "canvasId": "orders", "threadId": "g1", "id": "gm1", "name": "访客", "text": "这里要加锁吗？",
                                                  "anchor": {"ids": ["repo"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 50, "y": 30}}})
    assert r.status_code == 200, r.text
    assert store.read("threads", "orders")[0]["threads"][0]["messages"][0]["text"] == "这里要加锁吗？"
    r = await g.post("/api/guest/comments", json={"op": "create", "canvasId": "secret", "threadId": "g2", "id": "gm2", "name": "访客", "text": "x",
                                                  "anchor": {"ids": ["x"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 0, "y": 0}}})
    assert r.status_code == 403
    assert store.read("threads", "secret") is None
    # The owner unlinks the child: it stays a canvas, but the share no longer reaches it.
    store.write("canvas", "c1", {"elements": [box("api", paths=["server/**"]), box("db")]}, base=store.read("canvas", "c1")[1])
    assert (await g.get("/api/guest/state", params={"canvas": "be"})).status_code == 403
    assert store.read("canvas", "be") is not None


def library_api(child=None):
    """The demo's 「API 服务」: a library icon — a transparent root with the icon's data, its parts in
    nested groups, a free label in the icon's group (web/src/canvas/nodes.ts)."""
    g = "lib-api-c7kyx76q"
    cd = {"agora": {"group": g, "label": "api-label", "library": "official/dwelle/network-topology-icons#5", "name": "Server"}, "codePaths": ["server/**"]}
    if child:
        cd["childCanvas"] = child
    part = lambda i, t, groups: {"id": i, "type": t, "x": 360, "y": 210, "width": 80, "height": 60, "isDeleted": False, "groupIds": groups + [g]}  # noqa: E731
    return [
        {"id": "api", "type": "rectangle", "x": 360, "y": 210, "width": 80, "height": 101, "isDeleted": False, "groupIds": [g], "customData": cd},
        part("api-h1f9llad", "rectangle", ["g-ve71qy8l"]),
        part("api-0ckl4bra", "line", ["g-7q0ezcue", "g-umhrcw2c", "g-ve71qy8l"]),
        part("api-rnifsm7u", "line", ["g-oz17ic9o", "g-umhrcw2c", "g-ve71qy8l"]),
        {"id": "api-label", "type": "text", "x": 373, "y": 317, "width": 54, "height": 16, "isDeleted": False, "groupIds": [g], "text": "API 服务"},
    ]


def test_a_library_icon_is_one_node_and_carries_its_child_on_the_root(store):
    store.write("canvas", "c1", {"elements": library_api(child="be")}, base=store.read("canvas", "c1")[1])
    view = model_view(store.read("canvas", "c1")[0]["elements"])
    # One node for the whole icon (its parts are hidden), with the code paths and the child link.
    assert [n["id"] for n in view["nodes"]] == ["api"]
    assert view["nodes"][0] == {"id": "api", "type": "library", "component": "Server", "label": "API 服务", "x": 360, "y": 210, "width": 80, "height": 101,
                                "codePaths": ["server/**"], "child": {"canvasId": "be"}}
    top = file_read(store, "c1")["scene"]
    assert top["nodes"][0]["child"] == {"canvasId": "be", "name": "后端"}
    # The child knows its parent by the icon's node id and label; `child list` names it the same way.
    deep = file_read(store, "be")["scene"]
    assert deep["parent"] == {"canvasId": "c1", "name": "架构图", "nodeId": "api", "nodeLabel": "API 服务"}
    assert [p["name"] for p in deep["path"]] == ["架构图", "后端"]
    assert nested.list_children(store, "c1", {"be": "后端"}) == [{"nodeId": "api", "nodeLabel": "API 服务", "canvasId": "be", "name": "后端", "children": 1}]
    assert nested.reachable(store, "c1") == {"c1", "be", "orders"}


def test_a_link_left_on_an_icon_part_is_not_a_node(store):
    """Only the root is the icon's node: a part carrying a link (hand-edited) is hidden like the rest."""
    els = library_api()
    els[1]["customData"] = {"childCanvas": "be"}
    store.write("canvas", "c1", {"elements": els}, base=store.read("canvas", "c1")[1])
    view = model_view(store.read("canvas", "c1")[0]["elements"])
    assert [n["id"] for n in view["nodes"]] == ["api"] and "child" not in view["nodes"][0]
