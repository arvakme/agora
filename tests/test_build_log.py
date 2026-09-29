"""How a canvas was built (server/canvas/build_log.py; web/docs/share-build-replay.md): the steps of a project
older than the construction log (from the agents' recorded changes and the canvas files), of one that has it, and
what leaves in either case."""

from __future__ import annotations

import json
from typing import Any

import pytest

from server.canvas import buildlog
from server.canvas.build_log import build_timeline
from server.canvas.project import ProjectStore

SECRET_REQUEST = "把我的支付密钥 sk-live-123 画进架构里"


def rect(id: str, label: str, x: int = 0, y: int = 0, version: int = 1, updated: int = 1000, tversion: int = 1, **cd: Any) -> list[dict[str, Any]]:
    node = {"id": id, "type": "rectangle", "x": x, "y": y, "width": 120, "height": 60, "isDeleted": False, "version": version, "updated": updated, "index": f"a{id}", "boundElements": [{"type": "text", "id": f"{id}-t"}], **({"customData": cd} if cd else {})}
    txt = {"id": f"{id}-t", "type": "text", "x": x + 5, "y": y + 5, "width": 10, "height": 10, "isDeleted": False, "containerId": id, "text": label, "version": tversion, "updated": updated, "index": f"a{id}t"}
    return [node, txt]


def arrow(id: str, a: str, b: str, label: str | None = None, version: int = 1, updated: int = 1000) -> list[dict[str, Any]]:
    e = {"id": id, "type": "arrow", "x": 0, "y": 0, "width": 50, "height": 0, "points": [[0, 0], [50, 0]], "isDeleted": False, "version": version, "updated": updated, "index": f"a{id}", "startBinding": {"elementId": a}, "endBinding": {"elementId": b}, "boundElements": []}
    out = [e]
    if label:
        e["boundElements"] = [{"type": "text", "id": f"{id}-t"}]
        out.append({"id": f"{id}-t", "type": "text", "x": 0, "y": 0, "width": 10, "height": 10, "isDeleted": False, "containerId": id, "text": label, "version": version, "updated": updated, "index": f"a{id}t"})
    return out


def batch(before: list[tuple[str, Any]], after: list[tuple[str, int]]) -> dict[str, Any]:
    return {"before": [[i, e] for i, e in before], "after": [[i, v] for i, v in after]}


def turn(id: str, sid: str, cid: str, at: int, batch_id: str, **extra: Any) -> dict[str, Any]:
    return {"t": "turn", "turn": {"id": id, "n": 1, "sessionId": sid, "canvasId": cid, "origin": {"kind": "agent"}, "request": SECRET_REQUEST, "refs": [], "startedAt": at, "endedAt": at + 5, "status": "applied", "steps": [{"kind": "tool", "title": "curl https://secret.example/token", "detail": "sk-live-123", "id": "st-1", "status": "done", "startedAt": at}], "reply": {"text": f"已修改：{SECRET_REQUEST}", "changes": ["关联代码路径：server/payments/**"], "batchId": batch_id, **extra}}}


def elements_of(store: ProjectStore, cid: str) -> list[dict[str, Any]]:
    return [e for e in store.read("canvas", cid)[0]["elements"] if not e.get("isDeleted")]


def replay(tl: dict[str, Any], cid: str) -> dict[str, dict[str, Any]]:
    """Apply a timeline's steps for one canvas to its starting elements, the way a viewer does."""
    scene = {e["id"]: e for e in tl["start"].get(cid, [])}
    for s in tl["steps"]:
        if s["canvas"] != cid:
            continue
        for it in s["items"]:
            for e in [*it.get("add", []), *it.get("change", [])]:
                scene[e["id"]] = e
            for i in it.get("remove", []):
                scene.pop(i, None)
    return scene


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """A project made before the construction log: saving a canvas leaves no log, so the steps come from the sessions."""
    monkeypatch.setattr(ProjectStore, "_log_save", lambda *a, **k: None)
    s = ProjectStore(tmp_path)
    s.init("build")
    s.write("workspace", None, {"docs": [{"id": "c1", "kind": "canvas", "title": "总架构"}, {"id": "be", "kind": "canvas", "title": "后端"}]}, base=None, force=True)
    s.bind("s-claude", agent="claude", model="sonnet")
    return s


def seed_two_changes(store: ProjectStore):
    """A starter node (never touched by an agent); then an agent draws two nodes and an arrow; links one; renames one."""
    starter = rect("starter", "示例", updated=500)
    a1, b1 = rect("a", "前端", x=0, y=200, updated=1000), rect("b", "后端", x=300, y=200, updated=1000)
    link = arrow("ab", "a", "b", "HTTP", updated=1000)
    a2 = rect("a", "前端", x=0, y=200, version=2, updated=2000, codePaths=["web/**"])
    b3 = rect("b", "API 服务", x=300, y=200, version=1, tversion=2, updated=3000)
    current = [*starter, *a2, *b3, *link]
    store.write("canvas", "c1", {"elements": current}, base=None, force=True)
    recs = [
        {"t": "session", "session": {"id": "s-claude", "canvasId": "c1", "createdAt": 900, "turnIds": ["t1", "t2", "t3"]}},
        turn("t1", "s-claude", "c1", 1000, "b1"),
        turn("t2", "s-claude", "c1", 2000, "b2"),
        turn("t3", "s-claude", "c1", 3000, "b3"),
        {"t": "batch", "id": "b1", "batch": batch([(e["id"], None) for e in [*a1, *b1, *link]], [(e["id"], 1) for e in [*a1, *b1, *link]])},
        {"t": "batch", "id": "b2", "batch": batch([("a", a1[0])], [("a", 2)])},
        {"t": "batch", "id": "b3", "batch": batch([("b-t", b1[1])], [("b-t", 2)])},
    ]
    store.append_session("s-claude", recs, base=None, force=True)


def test_steps_come_from_the_recorded_changes_in_the_canvas_own_words(store):
    seed_two_changes(store)
    tl = build_timeline(store, "c1")
    assert tl["format"] == "agora-build-timeline" and tl["root"] == "c1"
    # the starter diagram is the picture before the first step; what the agent drew is not
    assert {e["id"] for e in tl["start"]["c1"]} == {"starter", "starter-t"}
    kinds = [(s["actor"].get("name"), [(it["kind"], it["say"]) for it in s["items"]]) for s in tl["steps"]]
    assert kinds == [
        ("Claude Code", [("add-node", "加了节点「前端」"), ("add-node", "加了节点「后端」"), ("add-arrows", "连了 前端 → 后端「HTTP」")]),
        ("Claude Code", [("link", "把「前端」关联到代码")]),
        ("Claude Code", [("rename", "把「后端」改名为「API 服务」")]),
    ]
    assert [it["place"] for it in tl["steps"][0]["items"]] == ["a", "b", "a"]  # where the figure stands: the node, and the arrow's source
    assert all(it["quiet"] for it in tl["steps"][1]["items"])  # links change nothing visible
    assert [s["at"] for s in tl["steps"]] == [1000, 2000, 3000]
    assert tl["sources"]["changes"] == 3


def test_walking_the_steps_forward_gives_the_canvas_as_it_is_now(store):
    seed_two_changes(store)
    tl = build_timeline(store, "c1")
    now = {e["id"]: e for e in elements_of(store, "c1")}
    got = replay(tl, "c1")
    assert set(got) == set(now)
    assert got["b-t"]["text"] == "API 服务"  # the rename landed
    assert got["a"]["version"] == 2


def test_nothing_private_leaves(store):
    seed_two_changes(store)
    dump = json.dumps(build_timeline(store, "c1"), ensure_ascii=False)
    for secret in (SECRET_REQUEST, "sk-live-123", "secret.example", "web/**", "server/payments", "s-claude", "t1", "b1", "codePaths", "关联代码路径", "sessionId", "request"):
        assert secret not in dump, secret
    # elements are what a guest sees: no customData at all here (no child link)
    tl = build_timeline(store, "c1")
    for e in [*tl["start"]["c1"], *(x for s in tl["steps"] for it in s["items"] for x in [*it.get("add", []), *it.get("change", [])])]:
        assert "customData" not in e


def test_an_undone_change_and_a_failed_one_are_not_steps(store):
    seed_two_changes(store)
    recs = [
        turn("t4", "s-claude", "c1", 4000, "b4", undone=True),
        {"t": "batch", "id": "b4", "batch": batch([("a", None)], [("a", 3)])},
        {"t": "turn", "turn": {"id": "t5", "n": 5, "sessionId": "s-claude", "canvasId": "c1", "origin": {"kind": "agent"}, "request": "x", "startedAt": 5000, "status": "invalid", "steps": [], "reply": {"text": "未通过"}}},
    ]
    store.append_session("s-claude", recs, base=None, force=True)
    assert [s["at"] for s in build_timeline(store, "c1")["steps"]] == [1000, 2000, 3000]


def test_what_the_person_drew_after_the_first_change_is_a_step_of_theirs(store):
    seed_two_changes(store)
    scene = store.read("canvas", "c1")[0]
    mine = rect("mine", "缓存", x=600, y=200, updated=9000)
    store.write("canvas", "c1", {**scene, "elements": [*scene["elements"], *mine]}, base=None, force=True)
    tl = build_timeline(store, "c1")
    assert {e["id"] for e in tl["start"]["c1"]} == {"starter", "starter-t"}  # not in the starting picture
    last = tl["steps"][-1]
    assert last["actor"] == {"kind": "you"} and last["at"] == 9000
    assert [(it["kind"], it["say"]) for it in last["items"]] == [("add-node", "加了节点「缓存」")]
    assert tl["sources"]["yourSteps"] == 1
    assert set(replay(tl, "c1")) == {e["id"] for e in elements_of(store, "c1")}


def test_a_persons_edit_between_two_changes_is_a_quiet_step(store):
    x1 = rect("x", "缓存", version=1, updated=1000)
    x_edited = rect("x", "缓存层", version=5, updated=1500)  # someone edited it between the two changes
    x2 = rect("x", "缓存层", version=6, updated=2000, codePaths=["cache/**"])
    store.write("canvas", "c1", {"elements": x2}, base=None, force=True)
    store.append_session("s-claude", [
        turn("t1", "s-claude", "c1", 1000, "b1"), turn("t2", "s-claude", "c1", 2000, "b2"),
        {"t": "batch", "id": "b1", "batch": batch([(e["id"], None) for e in x1], [("x", 1), ("x-t", 1)])},
        {"t": "batch", "id": "b2", "batch": batch([("x", x_edited[0])], [("x", 6)])},
    ], base=None, force=True)
    tl = build_timeline(store, "c1")
    assert [(s["actor"]["kind"], s["at"]) for s in tl["steps"]] == [("agent", 1000), ("you", 1500), ("agent", 2000)]
    assert tl["steps"][1]["items"][0]["quiet"] is True
    assert tl["sources"]["unseenEdits"] == 1


def test_a_sub_diagram_is_a_step_of_its_own_canvas_and_the_node_that_opens_it_says_so(store):
    parent_before = rect("api", "后端", updated=1000)
    parent_after = rect("api", "后端", version=2, updated=2000, childCanvas="be")
    child = rect("orders", "订单", updated=3000)
    store.write("canvas", "c1", {"elements": parent_after}, base=None, force=True)
    store.write("canvas", "be", {"elements": child}, base=None, force=True)
    store.append_session("s-claude", [
        turn("t1", "s-claude", "c1", 1000, "b1"), turn("t2", "s-claude", "c1", 2000, "b2"), turn("t3", "s-claude", "be", 3000, "b3"),
        {"t": "batch", "id": "b1", "batch": batch([(e["id"], None) for e in parent_before], [(e["id"], 1) for e in parent_before])},
        {"t": "batch", "id": "b2", "batch": batch([("api", parent_before[0])], [("api", 2)])},
        {"t": "batch", "id": "b3", "batch": batch([(e["id"], None) for e in child], [(e["id"], 1) for e in child])},
    ], base=None, force=True)
    tl = build_timeline(store, "c1")
    assert tl["canvases"] == {"be": {"title": "后端", "parent": {"canvas": "c1", "node": "api"}}, "c1": {"title": "总架构", "parent": None}}
    assert [(s["canvas"], it["kind"], it["say"], it.get("child")) for s in tl["steps"] for it in s["items"]] == [
        ("c1", "add-node", "加了节点「后端」", None),
        ("c1", "expand", "把「后端」展开成子图", "be"),
        ("be", "add-node", "加了节点「订单」", None),
    ]
    # the child link is the one thing of customData a guest keeps
    expand = tl["steps"][1]["items"][0]["change"][0]
    assert expand["customData"] == {"childCanvas": "be"}
    # a share of the child alone does not learn of the parent
    only_child = build_timeline(store, "be")
    assert set(only_child["canvases"]) == {"be"} and [s["canvas"] for s in only_child["steps"]] == ["be"]


def test_a_canvas_no_agent_touched_has_no_steps_and_starts_as_it_is(store):
    store.write("canvas", "c1", {"elements": rect("a", "前端")}, base=None, force=True)
    tl = build_timeline(store, "c1")
    assert tl["steps"] == [] and {e["id"] for e in tl["start"]["c1"]} == {"a", "a-t"}
    assert tl["sources"] == {"changes": 0, "yourSteps": 0, "unseenEdits": 0, "steps": 0, "dropped": 0}


def test_unknown_canvas(store):
    with pytest.raises(ValueError):
        build_timeline(store, "nope")


def test_the_owner_asks_over_http(store):
    from fastapi import APIRouter
    from fastapi.testclient import TestClient

    from server.canvas.project_router import create_project_app

    seed_two_changes(store)
    c = TestClient(create_project_app(store.root, canvas_router=APIRouter()))
    r = c.get("/api/project/build", params={"canvas": "c1"})
    assert r.status_code == 200 and r.json()["format"] == "agora-build-timeline" and len(r.json()["steps"]) == 3
    assert c.get("/api/project/build", params={"canvas": "nope"}).status_code == 404


def seed_with_secrets(store: ProjectStore):
    """An agent draws 「密钥服务」 (later deleted), draws 「前端」 and 「后端」 (later renamed 「API 服务」), moves 前端."""
    secret = rect("secret", "密钥 sk-live-999", x=900, y=0)
    a1, b1 = rect("a", "前端", x=0, y=200), rect("b", "后端", x=300, y=200)
    a2 = rect("a", "前端", x=50, y=210, version=2, updated=2500)
    b2 = rect("b", "API 服务", x=300, y=200, tversion=2, updated=3000)
    secret_gone = [{**e, "isDeleted": True, "version": 2, "updated": 4000} for e in secret]
    current = [*a2, *b2, *secret_gone]
    store.write("canvas", "c1", {"elements": current}, base=None, force=True)
    store.append_session("s-claude", [
        {"t": "session", "session": {"id": "s-claude", "canvasId": "c1", "createdAt": 900, "turnIds": ["t1", "t2", "t3", "t4"]}},
        turn("t1", "s-claude", "c1", 1000, "b1"), turn("t2", "s-claude", "c1", 2000, "b2"), turn("t3", "s-claude", "c1", 3000, "b3"), turn("t4", "s-claude", "c1", 4000, "b4"),
        {"t": "batch", "id": "b1", "batch": batch([(e["id"], None) for e in [*a1, *b1, *secret]], [(e["id"], 1) for e in [*a1, *b1, *secret]])},
        {"t": "batch", "id": "b2", "batch": batch([("a", a1[0])], [("a", 2)])},
        {"t": "batch", "id": "b3", "batch": batch([("b-t", b1[1])], [("b-t", 2)])},
        {"t": "batch", "id": "b4", "batch": batch([("secret", secret[0]), ("secret-t", secret[1])], [("secret", 2), ("secret-t", 2)])},
    ], base=None, force=True)


def test_all_of_it_is_told_what_was_drawn_renamed_moved_and_deleted_again(store):
    seed_with_secrets(store)
    tl = build_timeline(store, "c1")
    says = [it["say"] for s in tl["steps"] for it in s["items"]]
    assert "加了节点「密钥 sk-live-999」" in says and "把「后端」改名为「API 服务」" in says and "挪了「前端」" in says and "删掉了「密钥 sk-live-999」" in says


def test_a_guest_is_not_told_the_time_of_day(store):
    seed_with_secrets(store)
    tl = build_timeline(store, "c1", relative=True)
    assert tl["steps"][0]["at"] == 0 and all(0 <= s["at"] < 10_000 for s in tl["steps"])  # counted from the first step (the owner's was 1000)
    assert build_timeline(store, "c1")["steps"][0]["at"] == 1000


# ——— a project that has the construction log (server/canvas/buildlog.py) ———


@pytest.fixture()
def logged(tmp_path, monkeypatch):
    t = {"now": 100_000}
    monkeypatch.setattr(buildlog, "now_ms", lambda: t["now"])
    s = ProjectStore(tmp_path)
    s.init("logged")
    s.write("workspace", None, {"docs": [{"id": "c1", "kind": "canvas", "title": "总架构"}]}, base=None, force=True)
    s.bind("s-claude", agent="claude", model="sonnet")
    s.clock = t  # type: ignore[attr-defined]
    return s


def save(s: ProjectStore, cid: str, *groups: list[dict[str, Any]]) -> None:
    s.clock["now"] += 20_000  # type: ignore[attr-defined]
    s.write("canvas", cid, {"elements": [e for g in groups for e in g]}, base=None, force=True)


def says(tl: dict[str, Any]) -> list[tuple[str, str]]:
    return [(s["actor"].get("agent") or s["actor"]["kind"], it["say"]) for s in tl["steps"] for it in s["items"]]


def test_the_log_is_the_history_the_person_and_the_agent_in_the_order_they_worked(logged):
    save(logged, "c1", rect("starter", "示例"))
    logged.append_session("s-claude", [{"t": "batch", "id": "b1", "batch": batch([("a", None), ("a-t", None)], [("a", 2), ("a-t", 2)])}], base=None, force=True)
    save(logged, "c1", rect("starter", "示例"), rect("a", "前端", x=300, version=2))  # the agent draws 前端
    save(logged, "c1", rect("starter", "示例"), rect("a", "前端", x=300, version=2), rect("h", "边缘缓存", x=600, version=4))  # the person draws one
    tl = build_timeline(logged, "c1")
    assert says(tl) == [("claude", "加了节点「前端」"), ("you", "加了节点「边缘缓存」")]
    assert {e["id"] for e in tl["start"]["c1"]} == {"starter", "starter-t"}  # the first write is the picture it starts from
    assert [s["at"] for s in tl["steps"]] == [140_000, 160_000]
    assert set(replay(tl, "c1")) == {e["id"] for e in elements_of(logged, "c1")}, (set(replay(tl, "c1")), tl["steps"][0]["items"])


def test_what_was_drawn_and_deleted_again_is_in_it_and_so_is_a_person_dragging_one_node_as_a_single_move(logged):
    save(logged, "c1", rect("starter", "示例"))
    save(logged, "c1", rect("starter", "示例"), rect("x", "试一试", x=300, version=3))
    logged.clock["now"] += 20_000  # type: ignore[attr-defined]
    for k in range(1, 5):  # a drag: saves 200 ms apart
        logged.clock["now"] += 200  # type: ignore[attr-defined]
        logged.write("canvas", "c1", {"elements": [*rect("starter", "示例"), *rect("x", "试一试", x=300 + 20 * k, version=3 + k)]}, base=None, force=True)
    save(logged, "c1", rect("starter", "示例"), [{**e, "isDeleted": True, "version": 9} for e in rect("x", "试一试", x=380, version=8)])
    tl = build_timeline(logged, "c1")
    assert says(tl) == [("you", "加了节点「试一试」"), ("you", "挪了「试一试」"), ("you", "删掉了「试一试」")]


def test_a_project_older_than_the_log_tells_what_came_before_from_the_sessions_and_the_rest_from_the_log(tmp_path, monkeypatch):
    t = {"now": 500_000}
    monkeypatch.setattr(buildlog, "now_ms", lambda: t["now"])
    s = ProjectStore(tmp_path)
    s.init("old")
    s.write("workspace", None, {"docs": [{"id": "c1", "kind": "canvas", "title": "总架构"}]}, base=None, force=True)
    s.bind("s-claude", agent="claude", model="sonnet")
    a1, b1 = rect("a", "前端", x=0, y=200, updated=1000), rect("b", "后端", x=300, y=200, updated=1000)
    starter = rect("starter", "示例", updated=500)
    s.write("canvas", "c1", {"elements": [*starter, *a1, *b1]}, base=None, force=True)
    s.append_session("s-claude", [turn("t1", "s-claude", "c1", 1000, "b1"), {"t": "batch", "id": "b1", "batch": batch([(e["id"], None) for e in [*a1, *b1]], [(e["id"], 1) for e in [*a1, *b1]])}], base=None, force=True)
    (s.dir / "buildlog" / "c1.jsonl").unlink()  # before the log
    t["now"] += 20_000
    s.write("canvas", "c1", {"elements": [*starter, *a1, *b1, *rect("c", "缓存", x=600, version=3)]}, base=None, force=True)
    tl = build_timeline(s, "c1")
    assert says(tl) == [("claude", "加了节点「前端」"), ("claude", "加了节点「后端」"), ("you", "加了节点「缓存」")]
    assert {e["id"] for e in tl["start"]["c1"]} == {"starter", "starter-t"}
    assert replay(tl, "c1").keys() == {e["id"] for e in elements_of(s, "c1")}


def test_what_came_before_the_log_is_told_as_it_was_told_without_one_links_to_code_included(store, monkeypatch):
    """The log leaves code paths out, but an older project's history has them (a link to code is a step): the log's first save must not change how the history before it reads."""
    seed_two_changes(store)
    without = [(s["actor"]["kind"], it["say"]) for s in build_timeline(store, "c1")["steps"] for it in s["items"]]
    assert ("agent", "把「前端」关联到代码") in without
    monkeypatch.undo()  # the project now saves with the log
    current = store.read("canvas", "c1")[0]["elements"]
    store.write("canvas", "c1", {"elements": [*current, *rect("late", "后来我画的", x=900, updated=10**13)]}, base=None, force=True)
    assert (store.dir / "buildlog" / "c1.jsonl").exists()
    tl = build_timeline(store, "c1")
    told = [(s["actor"]["kind"], it["say"]) for s in tl["steps"] for it in s["items"]]
    assert told == [*without, ("you", "加了节点「后来我画的」")]
    assert {e["id"] for e in tl["start"]["c1"]} == {"starter", "starter-t"}


def test_the_log_carries_nothing_private_and_neither_does_the_timeline_made_from_it(logged):
    save(logged, "c1", rect("starter", "示例"))
    logged.append_session("s-claude", [turn("t1", "s-claude", "c1", 1000, "b1"), {"t": "batch", "id": "b1", "batch": batch([("a", None), ("a-t", None)], [("a", 2), ("a-t", 2)])}], base=None, force=True)
    save(logged, "c1", rect("starter", "示例"), rect("a", "前端", x=300, version=2, codePaths=["server/payments/**"]))
    for text in (json.dumps(build_timeline(logged, "c1"), ensure_ascii=False), (logged.dir / "buildlog" / "c1.jsonl").read_text()):
        for secret in (SECRET_REQUEST, "sk-live-123", "secret.example", "server/payments", "s-claude", "t1", "b1", "codePaths", "sessionId", "request"):
            assert secret not in text, secret
