"""Watching how a canvas was built, as a guest and as someone who imported it (web/docs/share-build-replay.md §5-§7):
the owner's switch, what leaves, comments on the whole canvas, and the log in a share bundle."""

from __future__ import annotations

import json
from typing import Any

import pytest

from server.canvas import build_log, buildlog
from server.canvas.project import ProjectStore
from server.canvas.share import BundleError, ShareFile, export_bundle, import_bundle
from tests.test_share import OWNER, guest, joined, owner  # noqa: F401
from tests.test_share import env as share_env  # noqa: F401

SECRET_REQUEST = "把支付密钥 sk-live-123 画进去"


def box(id: str, label: str, x: int = 0, version: int = 1, **extra: Any) -> list[dict[str, Any]]:
    return [
        {"id": id, "type": "rectangle", "x": x, "y": 200, "width": 120, "height": 60, "isDeleted": False, "version": version, "index": f"a{id}", "boundElements": [{"type": "text", "id": f"{id}-t"}], **extra},
        {"id": f"{id}-t", "type": "text", "x": x + 5, "y": 205, "width": 10, "height": 10, "isDeleted": False, "containerId": id, "text": label, "version": version, "index": f"a{id}t"},
    ]


@pytest.fixture()
def built(share_env, monkeypatch):  # noqa: F811
    """The shared project: a starter (its first write), an agent draws 前端, the person draws 缓存 then deletes it again; the agent's session holds secrets."""
    store, shares, dns, tunnels, clock, app = share_env
    t = {"now": 1_000_000}
    monkeypatch.setattr(buildlog, "now_ms", lambda: t["now"])
    store.bind("s-claude", agent="claude", model="sonnet")
    els = lambda *g: {"elements": [*store.read("canvas", "c1")[0]["elements"][:2], *[e for x in g for e in x]]}  # noqa: E731
    t["now"] += 60_000
    store.append_session("s-claude", [
        {"t": "turn", "turn": {"id": "t1", "sessionId": "s-claude", "canvasId": "c1", "request": SECRET_REQUEST, "startedAt": t["now"], "endedAt": t["now"] + 5, "status": "applied", "reply": {"text": SECRET_REQUEST, "batchId": "b1", "changes": ["server/payments/**"]}}},
        {"t": "batch", "id": "b1", "batch": {"before": [["fe", None], ["fe-t", None]], "after": [["fe", 2], ["fe-t", 2]]}},
    ], base=None, force=True)
    store.write("canvas", "c1", els(box("fe", "前端", x=300, version=2, customData={"codePaths": ["server/payments/**"]})), base=None, force=True)
    t["now"] += 60_000
    store.write("canvas", "c1", els(box("fe", "前端", x=300, version=2), box("cache", "缓存（试试）", x=600, version=5)), base=None, force=True)
    t["now"] += 60_000
    store.write("canvas", "c1", els(box("fe", "前端", x=300, version=2), [{**e, "isDeleted": True, "version": 9} for e in box("cache", "缓存（试试）", x=600, version=8)]), base=None, force=True)
    return store, share_env


async def share(app, build: bool) -> tuple[dict, str, str]:
    async with owner(app) as c:
        r = await c.post("/api/share", json={"canvasId": "c1", "ttl": 600, "buildReplay": build})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    return r.json()["share"], url.split("/")[2], url.rsplit("/", 1)[1]


async def test_without_the_owners_tick_a_guest_gets_no_replay_data_and_the_page_is_told_so(built):
    store, (_, shares, _, _, _, app) = built
    rec, host, token = await share(app, build=False)
    assert rec["buildReplay"] is False
    g = await joined(app, host, token)
    assert (await g.get("/api/guest/build")).status_code == 403  # the server refuses; the page not asking is not the protection
    assert (await g.get("/api/guest/state")).json()["share"]["buildReplay"] is False
    bundle = (await g.get("/api/guest/bundle")).json()
    assert all("build" not in c for c in bundle["canvases"].values())


async def test_with_the_tick_a_guest_watches_the_whole_process_including_what_was_drawn_and_deleted(built):
    store, (_, shares, _, _, _, app) = built
    rec, host, token = await share(app, build=True)
    assert rec["buildReplay"] is True
    g = await joined(app, host, token)
    r = await g.get("/api/guest/state")
    assert r.json()["share"]["buildReplay"] is True
    tl = (await g.get("/api/guest/build")).json()
    got = [(s["actor"].get("agent") or s["actor"]["kind"], it["say"]) for s in tl["steps"] for it in s["items"]]
    assert got == [("claude", "加了节点「前端」"), ("you", "加了节点「缓存（试试）」"), ("you", "删掉了「缓存（试试）」")]  # the idea that was dropped is in it
    assert tl["steps"][0]["at"] == 0 and max(s["at"] for s in tl["steps"]) < 10 * 60_000  # counted from the first step, not the clock
    assert "mode" not in tl and tl["root"] == "c1"


async def test_what_a_guest_watches_holds_nothing_of_the_owners(built):
    store, (_, shares, _, _, _, app) = built
    _, host, token = await share(app, build=True)
    g = await joined(app, host, token)
    tl = (await g.get("/api/guest/build")).text
    bundle = (await g.get("/api/guest/bundle")).text
    for text in (tl, bundle):
        for secret in (SECRET_REQUEST, "sk-live-123", "server/payments", "codePaths", "s-claude", "sessionId", "turnId", "request", "/Users", "mailto:", str(store.root), token):
            assert secret not in text, secret


async def test_a_guest_of_a_share_gets_only_their_share(built):
    store, (_, shares, _, _, _, app) = built
    store.write("canvas", "c9", {"elements": box("z", "别的画布")}, base=None, force=True)
    _, host, token = await share(app, build=True)
    g = await joined(app, host, token)
    assert (await g.get("/api/guest/build", params={"canvas": "c9"})).json()["root"] == "c1"  # there is no way to ask for another one
    assert (await guest(app, host).get("/api/guest/build")).status_code == 403  # no cookie, no answer


# ——— comments on the whole canvas ———


async def comment(g, **body):
    return await g.post("/api/guest/comments", json={"op": "create", "threadId": "t9", "id": "m9", "text": "整体上看不错", "name": "小明", **body})


async def test_a_guest_comments_on_the_whole_canvas_without_pinning_it_to_an_element(built):
    store, (_, shares, _, _, _, app) = built
    _, host, token = await share(app, build=False)
    g = await joined(app, host, token)
    r = await comment(g, anchor=None)
    assert r.status_code == 200 and r.json()["thread"]["anchor"] is None
    r = await g.post("/api/guest/comments", json={"op": "create", "threadId": "t10", "id": "m10", "text": "不带 anchor 字段", "name": "小明"})
    assert r.status_code == 200 and r.json()["thread"].get("anchor") is None
    on_disk = store.read("threads", "c1")[0]["threads"]
    assert {t["id"]: t["anchor"] for t in on_disk if t["id"] in ("t9", "t10")} == {"t9": None, "t10": None}
    threads = (await g.get("/api/guest/state")).json()["threads"]["threads"]
    assert {t["id"] for t in threads} >= {"t1", "t9", "t10"}


async def test_a_pinned_comment_still_has_to_name_elements_that_exist(built):
    store, (_, shares, _, _, _, app) = built
    _, host, token = await share(app, build=False)
    g = await joined(app, host, token)
    bad = {"ids": ["nope"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 0, "y": 0}}
    assert (await comment(g, anchor=bad)).status_code == 400
    good = {"ids": ["fe"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 0, "y": 0}}
    assert (await comment(g, anchor=good)).status_code == 200


async def test_a_comment_can_note_the_moment_of_the_replay_it_was_made_at_only_where_there_is_a_replay(built):
    store, (_, shares, _, _, _, app) = built
    _, host, token = await share(app, build=False)
    g = await joined(app, host, token)
    assert (await comment(g, anchor=None, moment={"step": 1})).status_code == 400  # this share has no replay to point into
    _, host2, token2 = await share(app, build=True)
    g2 = await joined(app, host2, token2)
    r = await comment(g2, anchor=None, moment={"step": 1})
    assert r.status_code == 200 and r.json()["thread"]["moment"] == {"step": 1}
    for bad in ({"step": -1}, {"step": "1"}, {"step": 10**9}, {"step": True}, "1", {}):
        assert (await comment(g2, threadId="tx", id="mx", anchor=None, moment=bad)).status_code == 400, bad


# ——— the log goes with a share bundle ———


def test_a_bundle_carries_the_log_and_the_importer_replays_it(built, tmp_path):
    store, _ = built
    bundle = export_bundle(store, "c1", "架构图")
    recs = bundle["canvases"]["c1"]["build"]
    assert recs[0]["t"] == 0 and "base" in recs[0]
    text = json.dumps(bundle, ensure_ascii=False)
    for secret in (SECRET_REQUEST, "sk-live-123", "server/payments", "codePaths", "s-claude", "sessionId"):
        assert secret not in text, secret
    other = ProjectStore(tmp_path / "other")
    other.root.mkdir()
    other.init()
    out = import_bundle(other, json.loads(text))
    assert out["builds"] == 1
    tl = build_log.build_timeline(other, out["canvasId"])
    assert [(s["actor"].get("agent") or s["actor"]["kind"], it["say"]) for s in tl["steps"] for it in s["items"]] == [("claude", "加了节点「前端」"), ("you", "加了节点「缓存（试试）」"), ("you", "删掉了「缓存（试试）」")]


def test_a_bundle_of_a_project_older_than_the_log_still_carries_a_whole_one(tmp_path, monkeypatch):
    monkeypatch.setattr(ProjectStore, "_log_save", lambda *a, **k: None)  # made before the log
    store = ProjectStore(tmp_path / "old")
    store.root.mkdir()
    store.init()
    store.bind("s-claude", agent="claude", model="sonnet")
    a = box("a", "前端")
    store.write("canvas", "c1", {"elements": a}, base=None, force=True)
    store.append_session("s-claude", [
        {"t": "turn", "turn": {"id": "t1", "sessionId": "s-claude", "canvasId": "c1", "startedAt": 1000, "endedAt": 1005, "status": "applied", "reply": {"batchId": "b1"}}},
        {"t": "batch", "id": "b1", "batch": {"before": [["a", None], ["a-t", None]], "after": [["a", 1], ["a-t", 1]]}},
    ], base=None, force=True)
    store.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "旧项目"}], "root": {}, "focused": "c1"}, base=None)
    bundle = export_bundle(store, "c1")
    recs = bundle["canvases"]["c1"]["build"]
    assert [("base" in r) for r in recs] == [True, False] and recs[1]["g"][0]["by"] == {"kind": "agent", "agent": "claude"}


def test_a_bundle_log_is_untrusted_like_the_rest_of_it(built, tmp_path):
    store, _ = built
    good = export_bundle(store, "c1")

    made: list[int] = []

    def other() -> ProjectStore:
        made.append(1)
        s = ProjectStore(tmp_path / f"o{len(made)}")
        s.root.mkdir()
        s.init()
        return s

    def with_build(records: Any) -> dict:
        b = json.loads(json.dumps(good))
        b["canvases"]["c1"]["build"] = records
        return b

    base = good["canvases"]["c1"]["build"][0]
    for bad in (
        "not a list",
        [{"t": "x", "base": []}],
        [{"t": 1, "g": [{"by": {"kind": "you"}, "put": []}]}],  # no picture to start from
        [base, {"t": 2, "g": [{"by": {"kind": "root"}, "put": []}]}],  # a maker nobody is
        [base, {"t": 2, "g": [{"by": {"kind": "agent", "agent": "../../etc"}, "put": []}]}],
        [base, {"t": 2, "g": [{"by": {"kind": "you"}, "put": [{"id": "x", "type": "rectangle", "x": float("inf"), "y": 0}]}]}],
        [base] * 20_001,
    ):
        s = other()
        with pytest.raises(BundleError):
            import_bundle(s, with_build(bad))
        assert not any((s.dir / "canvases").glob("*.excalidraw")) and not any((s.dir / "buildlog").glob("*.jsonl") if (s.dir / "buildlog").exists() else [])  # nothing written
    # an element that may not come in (an image) is left out of the log as it is of the canvas, and a link to outside is dropped
    hostile = json.loads(json.dumps(base))
    hostile["base"].append({"id": "img", "type": "image", "x": 0, "y": 0, "width": 1, "height": 1})
    hostile["base"].append({**box("cd", "x", customData={"codePaths": ["/etc/passwd"], "childCanvas": "elsewhere"})[0]})
    s = other()
    import_bundle(s, with_build([hostile, *good["canvases"]["c1"]["build"][1:]]))
    log = next((s.dir / "buildlog").glob("*.jsonl")).read_text()
    assert "image" not in log and "/etc/passwd" not in log and "elsewhere" not in log


def test_a_thread_on_the_whole_canvas_comes_in_read_only_with_its_moment(built, tmp_path):
    store, _ = built
    store.write("threads", "c1", {"seq": 1, "threads": [{"id": "w1", "n": 1, "anchor": None, "moment": {"step": 2}, "resolved": False, "createdAt": 1, "createdBy": OWNER, "messages": [{"id": "m1", "author": "human", "by": OWNER, "text": "整体：先画前端是对的", "at": 1}]}]}, base=None, force=True)
    bundle = export_bundle(store, "c1")
    other = ProjectStore(tmp_path / "imp")
    other.root.mkdir()
    other.init()
    out = import_bundle(other, bundle)
    threads = other.read("threads", out["canvasId"])[0]["threads"]
    assert [(t["anchor"], t["moment"], t["messages"][0]["by"]["id"].startswith("imported:")) for t in threads] == [(None, {"step": 2}, True)]


# ——— the owner changes the switch after the link was made ———


async def set_build(app, share_id: str, on: bool):
    async with owner(app) as c:
        return await c.patch(f"/api/share/{share_id}", json={"buildReplay": on})


async def test_the_owner_can_turn_watching_on_and_off_after_sharing_and_the_guest_side_follows_at_once(built):
    store, (_, shares, _, _, _, app) = built
    rec, host, token = await share(app, build=False)
    g = await joined(app, host, token)
    assert (await g.get("/api/guest/build")).status_code == 403
    r = await set_build(app, rec["id"], True)
    assert r.status_code == 200 and r.json()["share"]["buildReplay"] is True
    assert (await g.get("/api/guest/build")).status_code == 200  # the very next request, same guest
    assert (await g.get("/api/guest/state")).json()["share"]["buildReplay"] is True
    assert any("build" in c for c in (await g.get("/api/guest/bundle")).json()["canvases"].values())
    r = await set_build(app, rec["id"], False)
    assert r.json()["share"]["buildReplay"] is False
    assert (await g.get("/api/guest/build")).status_code == 403
    assert all("build" not in c for c in (await g.get("/api/guest/bundle")).json()["canvases"].values())


async def test_the_switch_is_kept_with_the_share_and_shows_in_the_list(built):
    store, (_, shares, _, _, _, app) = built
    rec, _, _ = await share(app, build=False)
    await set_build(app, rec["id"], True)
    assert ShareFile(store).load()[0].buildReplay is True  # on disk, so a restart keeps it
    async with owner(app) as c:
        assert [s["buildReplay"] for s in (await c.get("/api/share")).json()["shares"]] == [True]
    assert shares.get(rec["id"]).buildReplay is True


async def test_an_ended_or_unknown_share_cannot_be_changed_and_a_guest_cannot_change_it(built):
    store, (_, shares, _, _, _, app) = built
    rec, host, token = await share(app, build=False)
    assert (await set_build(app, "nope", True)).status_code == 404
    async with owner(app) as c:
        await c.delete(f"/api/share/{rec['id']}")
    assert (await set_build(app, rec["id"], True)).status_code == 409  # over: nothing to change
    rec2, host2, token2 = await share(app, build=False)
    g = await joined(app, host2, token2)
    assert (await g.patch(f"/api/share/{rec2['id']}", json={"buildReplay": True})).status_code in (403, 404, 405)
    assert (await g.get("/api/guest/build")).status_code == 403


async def test_a_bad_body_is_refused(built):
    store, (_, shares, _, _, _, app) = built
    rec, _, _ = await share(app, build=False)
    async with owner(app) as c:
        assert (await c.patch(f"/api/share/{rec['id']}", json={"buildReplay": "yes"})).status_code == 422
        assert (await c.patch(f"/api/share/{rec['id']}", json={})).status_code == 422
