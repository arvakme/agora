"""``agora canvas apply`` with a layout op, ``lint`` and ``layout`` through the hub: what the page is asked to do,
what the agent is told back."""

import asyncio
import json

import pytest

from server.canvas.project import ProjectStore
from server.canvas.sessions import AgentHub

SCENE = {
    "nodes": [{"id": "api", "type": "rectangle", "label": "API", "x": 400, "y": 0, "width": 160, "height": 64}],
    "arrows": [],
    "frames": [],
}


def box(id_, x, y):
    return [
        {"id": id_, "type": "rectangle", "x": x, "y": y, "width": 160, "height": 64, "version": 1, "isDeleted": False, "groupIds": [], "boundElements": [{"id": f"{id_}-t", "type": "text"}]},
        {"id": f"{id_}-t", "type": "text", "x": x + 10, "y": y + 20, "width": 100, "height": 20, "version": 1, "isDeleted": False, "text": id_, "originalText": id_, "containerId": id_},
    ]


@pytest.fixture()
def hub(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("canvas", "c1", {"elements": [*box("api", 700, 0), *box("a1", 0, 0), *box("a2", 300, 0), *box("b1", 0, 300), *box("b2", 300, 300)]}, base=None)
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构"}], "root": {}, "focused": "c1"}, base=None)
    return AgentHub(s)


class Page:
    """An open page: answers the bridge like the real one, and keeps what it was asked to apply."""

    def __init__(self, hub, scene):
        self.hub, self.scene, self.applied = hub, scene, []
        self.sub = hub.subscribe(2)
        hub.page_state(self.sub.id, visible=True, focused_at=1)
        self.task = asyncio.create_task(self.serve())

    async def serve(self):
        while True:
            ev = await self.sub.q.get()
            if ev.get("t") != "bridge":
                continue
            assert self.hub.claim_bridge(ev["rid"], self.sub.id)
            if ev["kind"] == "read":
                self.hub.bridge_result(ev["rid"], {"canvasId": "c1", "name": "架构", "scene": self.scene, "versions": {}})
            else:
                self.applied.append(ev["plan"])
                self.hub.bridge_result(ev["rid"], {"status": "applied", "summary": ["ok"]})

    def stop(self):
        self.task.cancel()


async def test_a_layout_op_reaches_the_page_as_plain_ops_and_the_answer_carries_the_measure(hub):
    page = Page(hub, SCENE)
    try:
        base = (await hub.canvas_read("c1", None))["base"]
        ops = [
            {"op": "add_shape", "ref": "svc", "shape": "rectangle", "text": "Svc", "x": 0, "y": 0},
            {"op": "add_arrow", "from": "api", "to": "svc"},
            {"op": "layout"},
        ]
        got = await hub.canvas_apply("c1", None, base, ops, "加 Svc")
        sent = page.applied[0]["ops"]
        assert [o["op"] for o in sent] == ["add_shape", "add_arrow"]
        assert sent[0]["y"] > 0  # below its source, not at the 0,0 the agent left in
        assert got["status"] == "applied" and got["layout"]["placed"] == ["svc"]
        assert "summary" in got["lint"] and "counts" in got["lint"]
    finally:
        page.stop()


async def test_ops_without_layout_go_through_as_they_are_and_still_get_measured(hub):
    page = Page(hub, SCENE)
    try:
        base = (await hub.canvas_read("c1", None))["base"]
        ops = [{"op": "update_text", "id": "api", "text": "API 网关"}]
        got = await hub.canvas_apply("c1", None, base, ops, None)
        assert page.applied[0]["ops"] == ops and "layout" not in got and got["lint"]["ok"] is True
    finally:
        page.stop()


async def test_a_refused_batch_is_not_measured(hub):
    async def refuse(kind, payload, fallback=None):
        return {"status": "invalid", "errors": ["nope"]}

    hub.edit = refuse
    base = (await hub.canvas_read("c1", None))["base"]
    got = await hub.canvas_apply("c1", None, base, [{"op": "delete", "id": "zzz"}], None)
    assert got["status"] == "invalid" and "lint" not in got


async def test_lint_reads_the_canvas_and_says_it_in_a_sentence(hub):
    from server.canvas import graph_hub

    got = await graph_hub.canvas_lint(hub, "c1", None)
    assert got["canvas"]["id"] == "c1" and "个节点" in got["summary"] and got["counts"]["nodes"] == 5


async def test_layout_without_saying_which_nodes_is_refused_and_says_how_to_lay_out_new_ones(hub):
    from server.canvas import graph_hub

    with pytest.raises(ValueError, match="--nodes"):
        await graph_hub.canvas_layout(hub, "c1", None, nodes=None, everything=False, apply=False, note=None)


async def test_layout_of_named_nodes_says_what_moves_and_changes_nothing_until_asked(hub):
    from server.canvas import graph_hub

    before = json.dumps(hub.store.read("canvas", "c1")[0], sort_keys=True)
    got = await graph_hub.canvas_layout(hub, "c1", None, nodes=["a1", "a2", "b1", "b2"], everything=False, apply=False, note=None)
    assert got["status"] == "preview" and got["willMove"] and {"id", "label", "from", "to"} <= set(got["willMove"][0])
    assert "before" in got and "after" in got
    assert json.dumps(hub.store.read("canvas", "c1")[0], sort_keys=True) == before


async def test_the_server_as_last_executor_measures_too(hub):
    """No page anywhere: the server edits the file itself (fallback.py) and the answer still says how the diagram measures."""
    base = (await hub.canvas_read("c1", None))["base"]
    got = await hub.canvas_apply("c1", None, base, [{"op": "update_text", "id": "api", "text": "API 网关"}], None)
    assert got["status"] == "applied" and got["source"] == "server-fallback"
    assert got["lint"]["counts"]["nodes"] == 5 and got["lint"]["ok"] is True


async def test_a_layout_batch_without_any_page_is_refused_whole_by_the_server_as_before(hub):
    """The fallback does not draw (BR2): a batch that adds shapes still needs a page, layout or not."""
    base = (await hub.canvas_read("c1", None))["base"]
    ops = [{"op": "add_shape", "ref": "svc", "shape": "rectangle", "text": "Svc", "x": 0, "y": 0}, {"op": "layout"}]
    got = await hub.canvas_apply("c1", None, base, ops, None)
    assert got["status"] == "needs-page" and "lint" not in got
