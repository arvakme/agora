"""When an edit cannot be drawn on a page, Agora finds somewhere to draw it itself (BR2): the pages that are open, then a page it opens, then the
server editing the canvas file. Every step says what it did; only when all fail is it an error, in words."""

import asyncio
import json
import time

import pytest

from server.canvas.project import ProjectStore
from server.canvas.sessions import AgentHub, NoPage

NID = "0d5f6a1e-0000-4000-8000-000000000001"


def shape(id_, label, x=0, y=0):
    box = {"id": id_, "type": "rectangle", "x": x, "y": y, "width": 160, "height": 60, "version": 3, "isDeleted": False, "groupIds": [], "boundElements": [{"id": f"{id_}-t", "type": "text"}]}
    text = {"id": f"{id_}-t", "type": "text", "x": x + 10, "y": y + 20, "width": 100, "height": 20, "version": 2, "isDeleted": False, "text": label, "originalText": label, "containerId": id_}
    return [box, text]


@pytest.fixture()
def hub(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("canvas", "c1", {"elements": [*shape("api", "API", 0, 0), *shape("db", "DB", 0, 200)]}, base=None)
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构"}], "root": {}, "focused": "c1"}, base=None)
    s.bind("s-1", agent="claude", native_id=NID, started=True)
    s.append_session("s-1", [{"t": "session", "session": {"id": "s-1", "canvasId": "c1", "createdAt": 1, "turnIds": []}}], base=None)
    h = AgentHub(s)
    h.open_wait_s = 0.6  # (15 s in real life)
    h.page_reply_s = 0.2
    h.bridge_timeout_s = 1.5
    (s.run_dir / "server.json").write_text(json.dumps({"url": "http://127.0.0.1:55599/"}))
    return h


async def read_base(hub):
    return (await hub.canvas_read("c1", "s-1"))["base"]


def canvas_texts(hub):
    els = hub.store.read("canvas", "c1")[0]["elements"]
    return {e["id"]: e["text"] for e in els if e["type"] == "text"}


def take(sub):
    while not sub.q.empty():
        ev = sub.q.get_nowait()
        if ev.get("t") == "bridge":
            return ev
    return None


UPDATE = [{"op": "update_text", "id": "api", "text": "API 网关"}]


# ——— step 2: a page it opens ———
async def test_with_no_page_it_opens_one_and_the_edit_goes_to_the_page_that_connects(hub):
    opened = []
    connected = []

    def opener(url):
        opened.append(url)

        async def connect():
            await asyncio.sleep(0.1)
            sub = hub.subscribe(2)  # the new page arrives as a claiming executor
            hub.page_state(sub.id, visible=True, focused_at=1)
            connected.append(sub)

        asyncio.get_running_loop().create_task(connect())

    hub.opener = opener
    base = await read_base(hub)
    task = asyncio.create_task(hub.canvas_apply("c1", "s-1", base, UPDATE, None))
    for _ in range(100):
        if connected and (req := take(connected[0])):
            break
        await asyncio.sleep(0.03)
    else:
        raise AssertionError("the new page was never offered the edit")
    assert opened == ["http://127.0.0.1:55599/"]
    assert hub.claim_bridge(req["rid"], connected[0].id)
    hub.bridge_result(req["rid"], {"status": "applied", "summary": ["改文字"]})
    got = await task
    assert got["status"] == "applied"
    assert any("打开" in n for n in got["notes"])  # said, not silent
    assert canvas_texts(hub)["api-t"] == "API"  # the file was not touched: the page did it (once)


async def test_it_opens_a_page_at_most_once_in_two_minutes(hub):
    opened = []
    clock = [1000.0]
    hub.opener = lambda url: opened.append(url)
    hub.clock = lambda: clock[0]
    base = await read_base(hub)
    for _ in range(3):
        await hub.canvas_apply("c1", "s-1", base, UPDATE, None)  # the page never connects: the server edits the file
        base = await read_base(hub)
    assert len(opened) == 1  # not a tab per request
    clock[0] += 121
    await hub.canvas_apply("c1", "s-1", base, [{"op": "update_text", "id": "db", "text": "PostgreSQL"}], None)
    assert len(opened) == 2  # two minutes later it may try again


async def test_the_preference_can_switch_the_opening_off(hub):
    opened = []
    hub.opener = lambda url: opened.append(url)
    assert hub.auto_open_enabled() is True  # on by default
    hub.set_auto_open(False)
    assert hub.auto_open_enabled() is False
    got = await hub.canvas_apply("c1", "s-1", await read_base(hub), UPDATE, None)
    assert opened == [] and got["status"] == "applied"
    assert any("关掉" in n for n in got["notes"])
    hub2 = AgentHub(hub.store)  # it is kept in the project, not in the process
    assert hub2.auto_open_enabled() is False


async def test_without_an_address_or_an_opener_it_goes_straight_to_the_file(hub):
    (hub.store.run_dir / "server.json").unlink()
    hub.opener = lambda url: (_ for _ in ()).throw(AssertionError("no address: nothing to open"))
    got = await hub.canvas_apply("c1", "s-1", await read_base(hub), UPDATE, None)
    assert got["status"] == "applied"


async def test_an_existing_page_is_still_tried_first_and_a_page_that_took_it_is_never_replaced(hub):
    base = await read_base(hub)  # (before the page connects: with a page open, a read goes to it too)
    page = hub.subscribe(2)
    hub.page_state(page.id, visible=True, focused_at=1)
    hub.opener = lambda url: (_ for _ in ()).throw(AssertionError("a page took it"))
    task = asyncio.create_task(hub.canvas_apply("c1", "s-1", base, UPDATE, None))
    for _ in range(100):
        if (req := take(page)):
            break
        await asyncio.sleep(0.02)
    assert hub.claim_bridge(req["rid"], page.id)  # it took it ... and never answers
    with pytest.raises(NoPage, match="已接手"):
        await asyncio.wait_for(task, 30)
    assert canvas_texts(hub)["api-t"] == "API"  # no second copy from the server


# ——— step 3: the server edits the file ———
async def test_the_server_applies_the_edit_to_the_file_with_the_undo_record_of_a_page_edit(hub):
    got = await hub.canvas_apply("c1", "s-1", await read_base(hub), UPDATE, "改名")
    assert got["status"] == "applied" and got["source"] == "server-fallback" and got["summary"] == ["改文字 「API」 → 「API 网关」"]
    assert canvas_texts(hub)["api-t"] == "API 网关"
    state, _ = hub.store.read_session("s-1")
    (turn,) = state["turns"].values()
    assert turn["origin"] == {"kind": "agent"} and turn["status"] == "applied" and turn["reply"]["batchId"] == got["batchId"]
    assert [s["kind"] for s in turn["steps"]] == ["check", "apply"]
    batch = state["batches"][got["batchId"]]
    before = {i: e for i, e in batch["before"]}
    assert before["api-t"]["text"] == "API" and before["api"]["version"] == 3  # what an undo puts back
    after = dict(batch["after"])
    els = {e["id"]: e for e in hub.store.read("canvas", "c1")[0]["elements"]}
    assert after["api"] == els["api"]["version"] == 4 and after["api-t"] == els["api-t"]["version"] == 3  # the versions an undo checks against


async def test_the_edit_is_validated_exactly_like_the_page_does(hub):
    base = await read_base(hub)
    got = await hub.canvas_apply("c1", "s-1", base, [{"op": "update_text", "id": "nope", "text": "x"}], None)
    assert got["status"] == "invalid" and got["errors"] == ["ops[0].id 指向不存在的元素 nope"]
    assert (await hub.canvas_apply("c1", "s-1", base, [], None))["status"] == "empty"
    too_many = await hub.canvas_apply("c1", "s-1", base, [{"op": "update_text", "id": "api", "text": f"n{i}"} for i in range(21)], None)
    assert too_many["status"] == "invalid" and any("ops" in e for e in too_many["errors"])  # the structure (plan.schema.json), as the page's validation checks it
    assert canvas_texts(hub)["api-t"] == "API"


async def test_a_change_since_the_read_is_stale_not_applied(hub):
    base = await read_base(hub)
    els = hub.store.read("canvas", "c1")
    els[0]["elements"][0]["version"] = 9  # someone edited it after the agent's read
    hub.store.write("canvas", "c1", els[0], base=els[1])
    got = await hub.canvas_apply("c1", "s-1", base, UPDATE, None)
    assert got["status"] == "stale" and got["stale"] == ["api"]
    assert canvas_texts(hub)["api-t"] == "API"


async def test_what_a_server_cannot_do_says_it_needs_a_page_and_changes_nothing(hub):
    base = await read_base(hub)
    for ops in (
        [{"op": "move", "id": "api", "x": 5, "y": 5}],
        [{"op": "add_shape", "ref": "cache", "shape": "ellipse", "text": "缓存", "x": 300, "y": 0}],
        [{"op": "update_text", "id": "api", "text": "ok"}, {"op": "delete", "id": "db"}],  # one op it cannot do: none is applied
    ):
        got = await hub.canvas_apply("c1", "s-1", base, ops, None)
        assert got["status"] == "needs-page" and "这条要打开页面才能做" in got["errors"][0]
    assert canvas_texts(hub) == {"api-t": "API", "db-t": "DB"}


async def test_a_page_that_connects_later_takes_in_the_edit_and_keeps_the_hand_edits_of_the_person(hub):
    """The page loads the file the server changed; a hand edit it made meanwhile is a conflict it reports, not an overwrite."""
    await hub.canvas_apply("c1", "s-1", await read_base(hub), UPDATE, None)
    from server.canvas.project import Conflict

    page_had = hub.store.read("canvas", "c1")  # what the page loaded
    hub.store.write("canvas", "c1", {"elements": [*page_had[0]["elements"], *shape("cache", "缓存", 300, 0)]}, base=page_had[1])  # the page saved a hand edit on top of it
    els = {e["id"]: e for e in hub.store.read("canvas", "c1")[0]["elements"]}
    assert els["api-t"]["text"] == "API 网关" and "cache" in els  # both survive
    with pytest.raises(Conflict):  # a page still holding the version from before the server's edit cannot overwrite it
        hub.store.write("canvas", "c1", {"elements": []}, base=hub.store.read("canvas", "c1")[1][::-1])


# ——— step 4: all three fail ———
async def test_when_every_step_fails_the_error_tells_what_each_one_tried(hub):
    base = await read_base(hub)
    page = hub.subscribe(2)  # a page that never answers
    hub.page_state(page.id, visible=True, focused_at=1)
    hub.opener = lambda url: None  # opens, nothing connects
    with pytest.raises(NoPage) as e:
        await hub.canvas_child("create", "c1", "s-1", "api", None, None)  # opening a sub-canvas is a page's job (it owns the workspace)
    msg = str(e.value)
    assert "开着的页面" in msg and "自己打开" in msg and "服务端" in msg and "打开页面才能做" in msg
    for word in ("Traceback", "NoPage", "Error"):
        assert word not in msg
    assert base  # (the read above works without a page: it answers from the file)


def test_the_preference_has_a_route_and_the_running_app_gets_the_real_open_command(tmp_path):
    from fastapi.testclient import TestClient

    from server.canvas.page_help import default_opener
    from server.canvas.project_router import create_project_app

    app = create_project_app(tmp_path / "p", canvas_router=__import__("fastapi").APIRouter(), gateway=False)
    c = TestClient(app, base_url="http://testserver")
    assert c.get("/api/agent/auto-open").json() == {"enabled": True}
    assert c.put("/api/agent/auto-open", json={"enabled": False}).json() == {"enabled": False}
    assert c.get("/api/agent/auto-open").json() == {"enabled": False}
    assert app.state.hub.opener is None  # a test app never opens a browser; only `agora up` (gateway) does
    assert callable(default_opener)
