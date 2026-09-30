"""Sharing the whole project (web/docs/sharing.md §11): what a project link lets a guest reach is worked out by the
server from the project's files on every request — later canvases are in, deleted ones are out, nothing else leaks."""

from __future__ import annotations

import json

from server.canvas.share import ShareManager, export_bundle
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
