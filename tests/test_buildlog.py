"""The construction log (server/canvas/buildlog.py; web/docs/share-build-replay.md §3): what a canvas save
records, who made it, how it is merged and kept small, and what never gets in."""

from __future__ import annotations

import json
from typing import Any

import pytest

from server.canvas import buildlog
from server.canvas.project import ProjectStore
from server.canvas.trash import Trash

SECRET = "把我的支付密钥 sk-live-123 画进架构里"


def node(id: str, label: str, x: int = 0, version: int = 1, **extra: Any) -> list[dict[str, Any]]:
    box = {"id": id, "type": "rectangle", "x": x, "y": 0, "width": 120, "height": 60, "isDeleted": False, "version": version, "versionNonce": 7, "updated": 1000 + version, "index": f"a{id}", "boundElements": [{"type": "text", "id": f"{id}-t"}], **extra}
    txt = {"id": f"{id}-t", "type": "text", "x": x + 5, "y": 5, "width": 10, "height": 10, "isDeleted": False, "containerId": id, "text": label, "version": version, "updated": 1000 + version, "index": f"a{id}t"}
    return [box, txt]


@pytest.fixture()
def clock(monkeypatch):
    t = {"now": 10_000}
    monkeypatch.setattr(buildlog, "now_ms", lambda: t["now"])
    return t


@pytest.fixture()
def store(tmp_path, clock):
    s = ProjectStore(tmp_path)
    s.init("log")
    s.bind("s-claude", agent="claude", model="sonnet")
    return s


def save(store: ProjectStore, cid: str, *groups: list[dict[str, Any]]) -> None:
    store.write("canvas", cid, {"elements": [e for g in groups for e in g]}, base=None, force=True)


def log(store: ProjectStore, cid: str = "c1") -> list[dict[str, Any]]:
    return buildlog.read(store.dir, cid)


def test_the_first_write_of_a_canvas_is_its_start_and_each_later_save_is_a_record(store, clock):
    save(store, "c1", node("starter", "示例"))
    clock["now"] += 5000
    save(store, "c1", node("starter", "示例"), node("a", "前端", x=200))
    clock["now"] += 5000
    save(store, "c1", node("starter", "示例"), node("a", "前端", x=200), node("b", "后端", x=400))
    recs = log(store)
    assert [("base" in r) for r in recs] == [True, False, False]
    assert not recs[0].get("legacy") and {e["id"] for e in recs[0]["base"]} == {"starter", "starter-t"}
    assert [{e["id"] for e in r["g"][0]["put"]} for r in recs[1:]] == [{"a", "a-t"}, {"b", "b-t"}]
    assert recs[1]["g"][0]["by"] == {"kind": "you"}
    assert {e["id"] for e in buildlog.state_of(recs).values()} == {"starter", "starter-t", "a", "a-t", "b", "b-t"}


def test_changes_and_removals_are_recorded_whole_and_bumping_a_version_alone_is_not_a_change(store, clock):
    save(store, "c1", node("a", "前端"), node("b", "后端", x=300))
    clock["now"] += 5000
    save(store, "c1", node("a", "前端", version=2), node("b", "后端", x=300))  # same picture, newer version
    assert len(log(store)) == 1
    save(store, "c1", node("a", "前端", x=50, version=3), node("b", "后端", x=300))  # moved
    clock["now"] += 5000
    save(store, "c1", node("a", "前端", x=50, version=3))  # b left the file
    recs = log(store)
    assert len(recs) == 3
    assert recs[1]["g"][0]["put"][0]["x"] == 50
    assert set(recs[2]["g"][0]["del"]) == {"b", "b-t"}


def test_saves_a_moment_apart_by_the_same_maker_are_one_record(store, clock):
    save(store, "c1", node("a", "前端"))
    for k in range(1, 6):  # dragging: a save every 200 ms
        clock["now"] += 200
        save(store, "c1", node("a", "前端", x=10 * k, version=1 + k))
    assert len(log(store)) == 2  # the start and one drag
    assert log(store)[1]["g"][0]["put"][0]["x"] == 50
    clock["now"] += 5000
    save(store, "c1", node("a", "前端", x=80, version=9))
    assert len(log(store)) == 3


def test_what_belongs_to_the_owner_alone_is_not_written(store, clock):
    save(store, "c1", node("a", "前端", customData={"codePaths": ["server/payments/**"], "agora": {"library": True}, "childCanvas": "c2"}))
    clock["now"] += 5000
    save(store, "c1", node("a", "前端", customData={"codePaths": ["server/payments/**"], "childCanvas": "c2"}), node("b", "后端", customData={"codePaths": ["web/**"]}))
    store.append_session(
        "s-claude",
        [{"t": "turn", "turn": {"id": "t1", "sessionId": "s-claude", "canvasId": "c1", "request": SECRET, "startedAt": 1, "status": "applied", "reply": {"text": SECRET, "batchId": "b1"}}}],
        base=None,
        force=True,
    )
    raw = (store.dir / "buildlog" / "c1.jsonl").read_text()
    for secret in ("server/payments", "web/**", "codePaths", "library", SECRET, "sk-live", "s-claude", "t1", "request", "sessionId"):
        assert secret not in raw, secret
    assert '"childCanvas":"c2"' in raw  # the link to the sub-diagram stays: a replay steps into it


def test_an_agents_change_is_filed_under_the_agent_when_its_batch_came_first(store, clock):
    save(store, "c1", node("starter", "示例"))
    batch = {"t": "batch", "id": "b1", "batch": {"before": [["a", None], ["a-t", None]], "after": [["a", 2], ["a-t", 2]]}}
    store.append_session("s-claude", [batch], base=None, force=True)
    clock["now"] += 5000
    save(store, "c1", node("starter", "示例"), node("a", "前端", version=2), node("h", "我加的", x=300, version=5))
    by = {json.dumps(g["by"], sort_keys=True): {e["id"] for e in g["put"]} for g in log(store)[1]["g"]}
    assert by == {'{"agent": "claude", "kind": "agent"}': {"a", "a-t"}, '{"kind": "you"}': {"h", "h-t"}}


def test_the_text_inside_an_agents_shape_goes_with_the_shape(store, clock):
    save(store, "c1", node("starter", "示例"))
    store.append_session("s-claude", [{"t": "batch", "id": "b1", "batch": {"before": [["a", None]], "after": [["a", 2]]}}], base=None, force=True)
    clock["now"] += 5000
    save(store, "c1", node("starter", "示例"), node("a", "前端", version=2))  # the batch knew the shape's version, not the text's (1)
    assert [(g["by"]["kind"], {e["id"] for e in g["put"]}) for g in log(store)[1]["g"]] == [("agent", {"a", "a-t"})]


def test_an_agents_change_is_filed_under_the_agent_when_its_batch_came_after_the_save(store, clock):
    save(store, "c1", node("starter", "示例"))
    clock["now"] += 5000
    save(store, "c1", node("starter", "示例"), node("a", "前端", version=2))
    assert log(store)[1]["g"][0]["by"] == {"kind": "you"}  # not known yet
    clock["now"] += 1000
    batch = {"t": "batch", "id": "b1", "batch": {"before": [["a", None], ["a-t", None]], "after": [["a", 2], ["a-t", 2]]}}
    store.append_session("s-claude", [batch], base=None, force=True)
    g = log(store)[1]["g"]
    assert [x["by"] for x in g] == [{"kind": "agent", "agent": "claude"}] and {e["id"] for e in g[0]["put"]} == {"a", "a-t"}
    # a later save by the person is not the agent's
    clock["now"] += 5000
    save(store, "c1", node("starter", "示例"), node("a", "前端", x=99, version=3))
    assert log(store)[2]["g"][0]["by"] == {"kind": "you"}


def test_a_project_older_than_the_log_starts_it_at_what_is_already_there(store, clock):
    store.write("canvas", "c1", {"elements": [*node("a", "前端"), *node("b", "后端", x=300)]}, base=None, force=True)
    (store.dir / "buildlog" / "c1.jsonl").unlink()  # this project was made before the log
    clock["now"] += 5000
    store.write("canvas", "c1", {"elements": [*node("a", "前端"), *node("b", "后端", x=300), *node("c", "新的", x=600)]}, base=None, force=True)
    recs = log(store)
    assert recs[0].get("legacy") is True and {e["id"] for e in recs[0]["base"]} == {"a", "a-t", "b", "b-t"}
    assert {e["id"] for e in recs[1]["g"][0]["put"]} == {"c", "c-t"}


def test_a_torn_line_is_skipped_and_the_log_goes_on(store, clock):
    save(store, "c1", node("a", "前端"))
    with open(store.dir / "buildlog" / "c1.jsonl", "ab") as fh:
        fh.write(b'{"t": 1, "g": [{"by"')  # a crash mid-write
    clock["now"] += 5000
    save(store, "c1", node("a", "前端"), node("b", "后端", x=300))
    recs = log(store)
    assert [("base" in r) for r in recs] == [True, False]


def test_a_log_that_grows_too_big_is_merged_by_maker_then_folded_and_the_end_state_is_the_same(store, clock, monkeypatch):
    monkeypatch.setattr(buildlog, "SOFT_BYTES", 6000)
    monkeypatch.setattr(buildlog, "KEEP_TAIL", 5)
    save(store, "c1", node("s", "示例"))
    els = node("s", "示例")
    for k in range(60):
        clock["now"] += 5000
        els = [*els, *node(f"n{k}", f"节点{k}", x=k * 10, version=1 + k)]
        save(store, "c1", els)
    recs = log(store)
    history = sum(len(buildlog.dump([r])) for r in recs[1:])
    assert history <= 6000 + 1000  # the history is kept under the size (the starting picture is the canvas itself)
    assert len(recs) < 30
    now = {e["id"] for e in store.read("canvas", "c1")[0]["elements"]}
    assert set(buildlog.state_of(recs)) == now  # nothing lost from what the canvas is
    assert recs[0].get("folded") is True or len(recs) > 5
    assert recs[-1]["t"] == clock["now"] and len([r for r in recs if "g" in r]) >= 5  # the recent steps stay whole


def test_the_log_goes_to_the_trash_and_comes_back_with_its_canvas(store, clock):
    save(store, "c1", node("a", "前端"))
    clock["now"] += 5000
    save(store, "c1", node("a", "前端"), node("b", "后端", x=300))
    store.write("workspace", None, {"docs": [{"id": "c1", "kind": "canvas", "title": "总架构"}]}, base=None, force=True)
    trash = Trash(store)
    item = trash.put("canvas", "c1", title="总架构")
    assert not (store.dir / "buildlog" / "c1.jsonl").exists()
    trash.restore(item["trashId"])
    assert len(log(store)) == 2
