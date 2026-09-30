"""Sharing the whole project (web/docs/sharing.md §11): what a project link lets a guest reach is worked out by the
server from the project's files on every request — later canvases are in, deleted ones are out, nothing else leaks."""

from __future__ import annotations

import json
from pathlib import Path

from server.canvas.share import ShareManager, export_bundle
from server.canvas.share_gateway import GuestFeed
from tests.test_share import EL, Clock, FakeDNS, FakeTunnels, guest, joined, owner  # noqa: F401
from tests.test_share import env  # noqa: F401

CHILD = [{"id": "n1", "type": "rectangle", "x": 0, "y": 0, "width": 10, "height": 10, "isDeleted": False, "customData": {"codePaths": ["src/**"]}}]


def seed(store) -> None:
    """c1 (with child c2) and c3 at the top level."""
    store.write("canvas", "c1", {"elements": [dict(EL[0], customData={"codePaths": ["server/**"], "childCanvas": "c2"}), EL[1]]}, base=store.read("canvas", "c1")[1])
    store.write("canvas", "c2", {"elements": CHILD}, base=None)
    store.write("canvas", "c3", {"elements": CHILD}, base=None)
    docs = [{"id": "c1", "kind": "canvas", "title": "架构图"}, {"id": "c2", "kind": "canvas", "title": "用户模块"}, {"id": "c3", "kind": "canvas", "title": "数据流"}]
    store.write("workspace", None, {"v": 2, "docs": docs, "root": {}, "focused": "c1"}, base=store.read("workspace")[1])


async def project_share(app) -> tuple[dict, str, str]:
    async with owner(app) as c:
        r = await c.post("/api/share", json={"scope": "project", "ttl": 600})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    return r.json()["share"], url.split("/")[2], url.rsplit("/", 1)[1]


async def test_project_link_reaches_every_canvas_tabs_fold_children_and_nothing_leaks(env):
    store, shares, *_, app = env
    seed(store)
    share, host, token = await project_share(app)
    assert share["scope"] == "project" and share["canvasId"] == ""
    g = await joined(app, host, token)
    st = (await g.get("/api/guest/state")).json()
    assert st["share"]["tabs"] == [{"id": "c1", "children": [{"id": "c2", "depth": 1}]}, {"id": "c3", "children": []}]  # top level in the owner's tab order; c2 folds under its parent c1
    assert st["canvas"]["id"] == "c1" and set(st["canvases"]) == {"c1", "c2", "c3"}
    c2 = (await g.get("/api/guest/state?canvas=c2")).json()
    assert [p["id"] for p in c2["path"]] == ["c1", "c2"]
    assert (await g.get("/api/guest/state?canvas=c3")).status_code == 200
    dump = json.dumps([st, c2])
    for secret in ("codePaths", "server/**", "src/**", str(store.root)):
        assert secret not in dump, secret


async def test_new_canvas_appears_and_deleted_one_disappears_for_the_guest(env):
    store, shares, *_, app = env
    seed(store)
    _, host, token = await project_share(app)
    g = await joined(app, host, token)
    assert (await g.get("/api/guest/state?canvas=c9")).status_code == 403
    store.write("canvas", "c9", {"elements": CHILD}, base=None)
    st = (await g.get("/api/guest/state?canvas=c9")).json()
    assert "c9" in st["canvases"] and "c9" in [t["id"] for t in (await g.get("/api/guest/state")).json()["share"]["tabs"]]
    async with owner(app) as c:
        r = await c.post("/api/project/trash/canvas/c3", json={"title": "数据流"})
        assert r.status_code == 200, r.text
        assert (await c.get("/api/share")).json()["shares"][0]["status"] == "active"  # the link itself stays
    assert (await g.get("/api/guest/state?canvas=c3")).status_code == 403
    assert "c3" not in [t["id"] for t in (await g.get("/api/guest/state")).json()["share"]["tabs"]]
    assert (await g.post("/api/guest/comments", json={"op": "create", "threadId": "t", "id": "m", "canvasId": "c3", "name": "x", "text": "y"})).status_code == 403


async def test_comments_stay_on_their_canvas_and_the_replay_is_per_canvas(env):
    store, shares, *_, app = env
    seed(store)
    async with owner(app) as c:
        r = await c.post("/api/share", json={"scope": "project", "ttl": 600, "buildReplay": True})
    url = r.json()["url"]
    g = await joined(app, url.split("/")[2], url.rsplit("/", 1)[1])
    for cid in ("c1", "c3"):
        r = await g.post("/api/guest/comments", json={"op": "create", "threadId": f"t-{cid}", "id": f"m-{cid}", "canvasId": cid, "name": "访客", "text": f"关于 {cid}"})
        assert r.status_code == 200, r.text
    assert [t["id"] for t in (await g.get("/api/guest/state?canvas=c3")).json()["threads"]["threads"]] == ["t-c3"]
    assert [t["id"] for t in (await g.get("/api/guest/state?canvas=c1")).json()["threads"]["threads"]] == ["t1", "t-c1"]  # t1: the owner's, from the fixture
    tl = (await g.get("/api/guest/build?canvas=c3")).json()
    assert set(tl["canvases"]) == {"c3"}  # c3 alone; c1's replay would carry c2 along
    assert set((await g.get("/api/guest/build?canvas=c1")).json()["canvases"]) == {"c1", "c2"}
    assert (await g.get("/api/guest/build?canvas=nope")).status_code == 403


async def test_revoking_ends_a_project_link_and_a_canvas_link_keeps_its_old_reach(env):
    store, shares, *_, app = env
    seed(store)
    share, host, token = await project_share(app)
    async with owner(app) as c:
        single = (await c.post("/api/share", json={"canvasId": "c1", "ttl": 600})).json()
    s_host, s_token = single["url"].split("/")[2], single["url"].rsplit("/", 1)[1]
    gs = await joined(app, s_host, s_token)
    assert set((await gs.get("/api/guest/state")).json()["canvases"]) == {"c1", "c2"}  # a canvas link: its canvas and what is nested below it
    assert (await gs.get("/api/guest/state?canvas=c3")).status_code == 403
    assert "tabs" not in (await gs.get("/api/guest/state")).json()["share"]
    g = await joined(app, host, token)
    async with owner(app) as c:
        assert (await c.delete(f"/api/share/{share['id']}")).status_code == 200
    assert (await g.get("/api/guest/state")).status_code == 403
    assert (await gs.get("/api/guest/state")).status_code == 200


async def test_canvas_share_saved_before_scope_existed_loads_as_a_canvas_share(env):
    store, shares, dns, tunnels, clock, app = env
    seed(store)
    async with owner(app) as c:
        await c.post("/api/share", json={"canvasId": "c1", "ttl": 600})
    path = store.dir / "shares" / "shares.json"
    data = json.loads(path.read_text())
    for rec in data["shares"]:
        rec.pop("scope")
    path.write_text(json.dumps(data))
    again = ShareManager(store, providers=lambda: (dns, tunnels), clock=clock)
    assert [(s.scope, s.canvasId) for s in again.shares] == [("canvas", "c1")]


async def test_project_bundle_carries_every_canvas(env):
    store, *_ = env
    seed(store)
    b = export_bundle(store, "c1", whole_project=True, build=False)
    assert set(b["canvases"]) == {"c1", "c2", "c3"}


# ——— a canvas file that is really a link to somewhere else never reaches a guest ———
MARKER = "FOREIGN_PROJECT_CONFIDENTIAL"


def foreign_scene(tmp_path) -> Path:
    """Another project's canvas (outside this project), with a marker."""
    f = tmp_path / "other-project" / ".agora" / "canvases" / "secret.excalidraw"
    f.parent.mkdir(parents=True)
    f.write_text(json.dumps({"type": "excalidraw", "version": 2, "elements": [{"id": "x", "type": "text", "x": 0, "y": 0, "width": 10, "height": 10, "text": MARKER, "isDeleted": False}]}))
    return f


async def probe_everything(g) -> str:
    """Every guest read that could carry a canvas's content, as one string."""
    bodies = []
    for path in ("/api/guest/state", "/api/guest/state?canvas=foreign", "/api/guest/state?canvas=c3", "/api/guest/build?canvas=foreign", "/api/guest/build?canvas=c3", "/api/guest/bundle"):
        r = await g.get(path)
        bodies.append(f"{path} {r.status_code} {r.text}")
    return "\n".join(bodies)


async def test_a_link_to_another_projects_canvas_is_not_part_of_the_project_share(env, tmp_path):
    store, shares, *_, app = env
    seed(store)
    (store.dir / "canvases" / "foreign.excalidraw").symlink_to(foreign_scene(tmp_path))  # added
    f3 = store.dir / "canvases" / "c3.excalidraw"
    f3.unlink()
    f3.symlink_to(tmp_path / "other-project" / ".agora" / "canvases" / "secret.excalidraw")  # an existing canvas replaced by one
    async with owner(app) as c:
        r = await c.post("/api/share", json={"scope": "project", "ttl": 600, "buildReplay": True})
    url = r.json()["url"]
    g = await joined(app, url.split("/")[2], url.rsplit("/", 1)[1])
    seen = await probe_everything(g)
    assert MARKER not in seen
    st = (await g.get("/api/guest/state")).json()
    assert [t["id"] for t in st["share"]["tabs"]] == ["c1"] and set(st["canvases"]) == {"c1", "c2"}
    for path in ("/api/guest/state?canvas=foreign", "/api/guest/state?canvas=c3", "/api/guest/build?canvas=foreign", "/api/guest/build?canvas=c3"):
        assert (await g.get(path)).status_code == 403, path
    r = await g.post("/api/guest/comments", json={"op": "create", "threadId": "t", "id": "m", "canvasId": "foreign", "name": "x", "text": "y"})
    assert r.status_code == 403
    assert MARKER not in json.dumps(export_bundle(store.contained(), "c1", whole_project=True))


async def test_a_link_to_another_projects_comments_is_not_read_either(env, tmp_path):
    store, shares, *_, app = env
    seed(store)
    other = tmp_path / "other-threads.json"
    other.write_text(json.dumps({"seq": 1, "threads": [{"id": "t9", "n": 1, "resolved": False, "createdAt": 1, "anchor": None, "messages": [{"id": "m9", "author": "human", "text": MARKER, "at": 1}]}]}))
    t1 = store.dir / "threads" / "c1.json"
    t1.unlink()
    t1.symlink_to(other)
    _, host, token = await project_share(app)
    g = await joined(app, host, token)
    assert MARKER not in await probe_everything(g)
    assert (await g.get("/api/guest/state?canvas=c1")).json()["threads"]["threads"] == []


async def test_a_link_in_the_shared_canvas_place_of_a_single_share_is_refused(env, tmp_path):
    store, shares, *_, app = env
    seed(store)
    async with owner(app) as c:
        single = (await c.post("/api/share", json={"canvasId": "c3", "ttl": 600})).json()
    f3 = store.dir / "canvases" / "c3.excalidraw"
    f3.unlink()
    f3.symlink_to(foreign_scene(tmp_path))
    g = await joined(app, single["url"].split("/")[2], single["url"].rsplit("/", 1)[1])
    r = await g.get("/api/guest/state")
    assert MARKER not in r.text and r.status_code in (403, 404)


def test_a_file_swapped_for_a_link_after_it_was_listed_reads_as_absent(env, tmp_path):
    store, *_ = env
    seed(store)
    view = store.contained()
    assert view.read("canvas", "c3") is not None
    f3 = store.dir / "canvases" / "c3.excalidraw"
    f3.unlink()
    f3.symlink_to(foreign_scene(tmp_path))
    assert view.read("canvas", "c3") is None  # the owner's own store keeps following links, as before
    assert store.read("canvas", "c3") is not None


# ——— a guest's live stream learns that the project's scope changed (a signal, never content) ———
async def feed_for(env, scope="project"):
    store, shares, *_, app = env
    seed(store)
    async with owner(app) as c:
        body = {"scope": "project", "ttl": 600} if scope == "project" else {"canvasId": "c1", "ttl": 600}
        made = (await c.post("/api/share", json=body)).json()["share"]
    return store, GuestFeed(store.contained(), shares.get(made["id"]))


async def test_stream_signals_a_new_canvas_once_and_carries_no_content(env):
    store, feed = await feed_for(env)
    store.write("canvas", "c9", {"elements": CHILD}, base=None)
    first = feed.frames({"t": "canvas", "canvasId": "c9"})
    assert first[0] == {"t": "scope"}  # just the signal
    assert [f["t"] for f in first] == ["scope", "canvas"]  # (the new canvas's drawing is what a canvas event always carried)
    assert [f["t"] for f in feed.frames({"t": "canvas", "canvasId": "c9"})] == ["canvas"]  # a further edit changes no tab: no signal


async def test_stream_signals_a_deleted_canvas_and_drops_its_late_events(env):
    store, feed = await feed_for(env)
    async with owner(env[5]) as c:
        assert (await c.post("/api/project/trash/canvas/c3", json={"title": "数据流"})).status_code == 200
    assert feed.frames({"t": "trash"}) == [{"t": "scope"}]
    assert feed.frames({"t": "trash"}) == []  # the same trash event again: nothing new
    assert feed.frames({"t": "threads", "canvasId": "c3", "data": {"threads": []}}) == []  # a comment event of the deleted canvas reaches nobody


async def test_stream_signals_a_rename_and_a_new_child_link_but_not_a_plain_edit(env):
    store, feed = await feed_for(env)
    ws, v = store.read("workspace")
    ws["docs"][2]["title"] = "数据流（新）"
    store.write("workspace", None, ws, base=v)
    assert feed.frames({"t": "workspace"}) == [{"t": "scope"}]
    store.write("canvas", "c9", {"elements": CHILD}, base=None)
    assert [f["t"] for f in feed.frames({"t": "canvas", "canvasId": "c9"})] == ["scope", "canvas"]
    _, v3 = store.read("canvas", "c3")
    store.write("canvas", "c3", {"elements": [dict(CHILD[0], customData={"childCanvas": "c9"})]}, base=v3)  # c9 becomes c3's child: it leaves the top level
    assert [f["t"] for f in feed.frames({"t": "canvas", "canvasId": "c3"})] == ["scope", "canvas"]
    store.write("canvas", "c3", {"elements": [dict(CHILD[0], id="n2", customData={"childCanvas": "c9"})]}, base=store.read("canvas", "c3")[1])
    assert [f["t"] for f in feed.frames({"t": "canvas", "canvasId": "c3"})] == ["canvas"]  # a plain edit: no tab changed


async def test_a_single_canvas_stream_never_gets_the_signal(env):
    store, feed = await feed_for(env, scope="canvas")
    store.write("canvas", "c9", {"elements": CHILD}, base=None)
    assert feed.frames({"t": "canvas", "canvasId": "c9"}) == []  # not below c1: nothing about it
    assert feed.frames({"t": "trash"}) == [] and feed.frames({"t": "workspace"}) == []
