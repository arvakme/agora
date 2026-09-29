"""Dispatches (server/canvas/dispatch.py): the flow A → B, told only by B's own log and its receipt.

The hub is the real ``AgentHub``; the terminal is a fake (two sessions with panes, so nothing runs a CLI)
and B's "log" is what the test puts into the hub's transcript, in the shape the adapters project (the three
CLIs' real records are checked in test_dispatch_marks)."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest

from server.canvas import agents
from server.canvas.dispatch import Dispatches, DispatchError
from server.canvas.dispatch_store import derive_state
from server.canvas.project import ProjectStore
from server.canvas.sessions import AgentHub
from server.canvas.terminal import make_gate

NID_A, NID_B = "44444444-0000-0000-0000-00000000000a", "44444444-0000-0000-0000-00000000000b"


class FakeTerms:
    """Panes for the sessions in ``open``; ``right`` is the input right (a takeover) the gate reports."""

    def __init__(self, *open_: str):
        self.open, self.pastes, self.right, self.writers = set(open_), [], None, 0

    def alive(self, sid):
        return sid in self.open

    def kill(self, sid):
        self.open.discard(sid)

    def attach_command(self, sid, *, readonly=False):
        return f"tmux attach -t agora-{sid}"

    def clients(self, sid):
        return 0

    def gate(self, sid):
        return make_gate(self.right, self.writers)

    def paste(self, sid, text, **_):
        self.pastes.append((sid, text))

    @staticmethod
    def name(sid):
        return f"agora-{sid}"


@pytest.fixture(autouse=True)
def _no_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)
    monkeypatch.setattr(agents, "install_skill", lambda *a, **k: None)


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构图"}], "root": {}, "focused": "c1"}, base=None)
    s.write("canvas", "c1", {"elements": [{"id": "r", "type": "rectangle", "x": 0, "y": 0, "width": 1, "height": 1, "version": 1, "groupIds": []}]}, base=None)
    s.bind("s-a", agent="claude", native_id=NID_A, started=True)
    s.bind("s-b", agent="codex", native_id=NID_B, started=True)
    s.append_session("s-a", [{"t": "session", "session": {"id": "s-a", "canvasId": "c1"}}], base=None)
    return s


class SlowBackend:
    """A headless run that starts and then keeps going (nothing real is ever run)."""

    async def run(self, req):
        yield {"t": "start"}
        await asyncio.sleep(30)


class Rig:
    def __init__(self, store):
        self.store = store
        self.terms = FakeTerms("s-a", "s-b")
        self.hub = AgentHub(store, terminals=self.terms, backend_factory=lambda kind: SlowBackend())
        self.dp = Dispatches(self.hub)

    def user(self, sid, item_id, rid, at=1000):
        return {"id": item_id, "kind": "user", "text": "x", "at": at, "source": "agora", "dispatch": rid}

    def show(self, sid, *items):
        """B's own log shows these items (the hub merged them, then told the pages)."""
        lv = self.hub._get(sid)
        for it in items:
            lv.items[it["id"]] = it
        self.hub.broadcast({"t": "transcript", "sessionId": sid, "items": list(items)})

    def state(self, rid):
        return derive_state(self.dp.get(rid))

    async def deliver(self, rid):
        """Let the hub's own loop inject the queued message (it calls the hand-off hook first)."""
        for _ in range(200):
            d = self.dp.get(rid)
            # in_flight is written first, the paste (into a pane) or the headless start follows it
            if d.delivery.turn_state == "in_flight" and (d.target["sessionId"] not in self.terms.open or any(sid == d.target["sessionId"] for sid, _ in self.terms.pastes)):
                return
            await asyncio.sleep(0.05)
        raise AssertionError(f"not handed over: {self.dp.summary(self.dp.get(rid))}")


@pytest.fixture
async def rig(store):
    r = Rig(store)
    r.hub.ensure_started()
    yield r
    await r.hub.close()


SRC = {"kind": "session", "sessionId": "s-a"}


async def go(rig, **kw):
    s = await rig.dp.dispatch(source=SRC, task="在 notes.md 末尾加一行\n细节…", to="s-b", scope=["notes.md"], **kw)
    return s["id"], s


# ——— the flow ———
async def test_pending_then_in_flight_then_accepted_then_done(rig):
    rid, s = await go(rig)
    assert s["state"] == "dispatched" and s["turnState"] == "pending" and s["target"] == {"sessionId": "s-b", "agent": "codex", "new": False}
    folder = Path(s["dir"])
    assert (folder / "task.md").read_text().startswith("在 notes.md 末尾加一行") and (folder.parent / f"{rid}.json").exists()
    await rig.deliver(rid)
    # What B was given: one line with the task file and the footer's marker.
    (sid, text), = rig.terms.pastes
    assert sid == "s-b" and str(folder / "task.md") in text and f"dispatch={rid}" in text and f"agora-req-{rid}" in text
    assert "\n" not in text.split("\n\n[[agora]]")[0]
    assert rig.state(rid) == "dispatched"  # handed over; B's own log has not shown it yet
    rig.show("s-b", rig.user("s-b", "u1", rid))
    assert rig.state(rid) == "running" and rig.dp.get(rid).delivery.bound.turn == "u1"  # the marker in B's log = accepted
    rig.show("s-b", {"id": "a1", "kind": "assistant", "text": "加好了", "at": 1100}, {"id": "end-u1", "kind": "end", "at": 1200, "turn": "u1"})
    assert rig.state(rid) == "idle_no_reply"  # the turn ended and nothing was handed back
    await asyncio.sleep(0.6)
    assert len([t for sid, t in rig.terms.pastes if sid == "s-a"]) == 1
    a = rig.hub._get("s-a")
    a.state.busy, a.awaiting = False, []  # A finished answering that note
    rig.dp.reply(rid, "done", "已在 notes.md 末尾加了一行", session="s-b")
    assert rig.state(rid) == "done"
    assert [h["state"] for h in rig.dp.get(rid).history] == ["dispatched", "running", "idle_no_reply", "done"]
    await asyncio.sleep(1.0)  # A is told through the hub's queue, not by typing into anything
    told = [t for sid, t in rig.terms.pastes if sid == "s-a"]
    assert len(told) == 2 and "没有交回执" in told[0] and "完成了" in told[1] and "已在 notes.md 末尾加了一行" in told[1]  # a late receipt moves it and is told once more
    assert all("这是通知，不需要回复" in t for t in told)  # so A does not answer with "same receipt as before"
    assert (folder / "reply.md").read_text().strip() == "已在 notes.md 末尾加了一行"


@pytest.mark.parametrize("status,want", [("failed", "failed"), ("blocked", "blocked")])
async def test_failed_and_blocked_receipts(rig, status, want):
    rid, _ = await go(rig)
    await rig.deliver(rid)
    rig.show("s-b", rig.user("s-b", "u1", rid))
    rig.dp.reply(rid, status, "做不了：权限")
    assert rig.state(rid) == "running"  # the receipt is a claim; the turn has not ended
    rig.show("s-b", {"id": "end-u1", "kind": "end", "at": 1200, "turn": "u1"})
    assert rig.state(rid) == want
    assert rig.dp.summary(rig.dp.get(rid))["reply"]["summary"] == "做不了：权限"


async def test_a_turn_that_ends_with_an_error_is_failed_with_that_error(rig):
    rid, _ = await go(rig)
    await rig.deliver(rid)
    rig.show("s-b", rig.user("s-b", "u1", rid), {"id": "end-u1", "kind": "end", "at": 1200, "turn": "u1", "error": "rate limited"})
    s = rig.dp.summary(rig.dp.get(rid))
    assert s["state"] == "failed" and s["result"]["outcome"] == "failed" and "rate limited" in s["result"]["summary"]


async def test_a_message_with_another_marker_or_no_marker_is_not_this_dispatch(rig):
    rid, _ = await go(rig)
    await rig.deliver(rid)
    rig.show("s-b", rig.user("s-b", "u9", "9d5f6a1e-7b3c-4c1f-9a52-3e8d2b6c4f99"), {"id": "u8", "kind": "user", "text": "hi", "at": 5, "source": "terminal"}, {"id": "end-u8", "kind": "end", "at": 6, "turn": "u8"})
    assert rig.state(rid) == "dispatched" and rig.dp.get(rid).delivery.bound is None


async def test_the_receipt_must_come_from_the_target_and_be_one_of_three(rig):
    rid, _ = await go(rig)
    with pytest.raises(DispatchError):
        rig.dp.reply(rid, "done", "x", session="s-a")
    with pytest.raises(DispatchError):
        rig.dp.reply(rid, "great")


# ——— held by a person ———
async def test_a_person_holding_the_pane_leaves_it_queued_with_the_reason_and_it_goes_when_given_back(rig):
    rig.terms.right = {"right": "human", "at": 1}
    rig.hub._get("s-b").pane_since = time.time() - 60
    rid, _ = await go(rig)
    for _ in range(40):
        s = rig.dp.summary(rig.dp.get(rid))
        if s.get("queuedBecause"):
            break
        await asyncio.sleep(0.05)
    assert s["state"] == "dispatched" and s["turnState"] == "pending" and "接管" in s["queuedBecause"] and not s["error"]
    await asyncio.sleep(0.6)
    assert rig.terms.pastes == [] and rig.state(rid) == "dispatched"  # not failed, not resent, not typed over the person
    rig.terms.right = None
    await rig.deliver(rid)
    for _ in range(100):  # in_flight is written first, the paste follows it
        if rig.terms.pastes:
            break
        await asyncio.sleep(0.05)
    assert len(rig.terms.pastes) == 1


# ——— restart ———
async def test_after_a_restart_nothing_that_may_have_been_injected_is_sent_again(rig, store):
    rid, _ = await go(rig)
    await rig.deliver(rid)
    n = len(rig.terms.pastes)
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)  # the same project after a restart: memory is gone, the record is not
    hub2.ensure_started()
    try:
        dp2.recover()
        d = dp2.get(rid)
        assert d.delivery.turn_state == "uncertain" and "not resent" in d.delivery.note and derive_state(d) == "unknown"
        assert hub2.live.get("s-b") is None or (not hub2.live["s-b"].pane and not hub2.live["s-b"].headless)  # queued nothing
        assert hub2.terms.pastes == [] and len(rig.terms.pastes) == n
        dp2.recover()  # and again: still nothing
        assert hub2.terms.pastes == []
    finally:
        await hub2.close()


async def test_after_a_restart_the_marker_in_b_s_log_settles_what_it_can(rig, store, monkeypatch):
    rid, _ = await go(rig)
    await rig.deliver(rid)
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    monkeypatch.setattr(hub2, "items", lambda sid: [rig.user(sid, "u1", rid), {"id": "end-u1", "kind": "end", "at": 9, "turn": "u1"}] if sid == "s-b" else [])
    dp2.recover()
    assert derive_state(dp2.get(rid)) == "idle_no_reply" and dp2.get(rid).delivery.turn_state == "completed" and hub2.terms.pastes == []


async def test_a_pending_record_that_was_never_handed_over_is_delivered_after_a_restart(rig, store):
    rig.terms.right = {"right": "human", "at": 1}
    rid, _ = await go(rig)  # queued behind a person, then the server dies
    assert rig.dp.get(rid).delivery.turn_state == "pending"
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    hub2.ensure_started()
    try:
        dp2.recover()
        for _ in range(100):
            if hub2.terms.pastes:
                break
            await asyncio.sleep(0.05)
        assert len(hub2.terms.pastes) == 1 and dp2.get(rid).delivery.turn_state == "in_flight"
    finally:
        await hub2.close()


# ——— interrupt: a withdrawn dispatch's late result is evidence, never published ———
async def test_a_result_that_arrives_after_the_withdrawal_is_kept_but_not_published_or_told(rig):
    rid, _ = await go(rig)
    await rig.deliver(rid)
    rig.show("s-b", rig.user("s-b", "u1", rid))
    s = rig.dp.interrupt(rid)
    assert s["withdrawn"] and s["state"] == "unknown" and "terminal pane" in s["note"]  # a turn in a pane cannot be stopped from here: not claimed
    rig.dp.reply(rid, "done", "还是做完了")
    rig.show("s-b", {"id": "a1", "kind": "assistant", "text": "做完了", "at": 1100}, {"id": "end-u1", "kind": "end", "at": 1200, "turn": "u1"})
    s = rig.dp.summary(rig.dp.get(rid))
    assert s["state"] == "interrupted" and s["result"] == {"outcome": "completed", "summary": "做完了", "published": False}
    await asyncio.sleep(0.6)
    assert [t for sid, t in rig.terms.pastes if sid == "s-a"] == []  # A is not told a result it withdrew


async def test_interrupting_a_message_still_in_the_queue_takes_it_out(rig):
    rig.terms.right = {"right": "human", "at": 1}
    rid, _ = await go(rig)
    s = rig.dp.interrupt(rid)
    assert s["state"] == "interrupted" and not rig.hub._get("s-b").pane
    rig.terms.right = None
    await asyncio.sleep(0.6)
    assert rig.terms.pastes == []  # never delivered


async def test_a_headless_run_that_is_cancelled_is_recorded_interrupted(rig, monkeypatch):
    monkeypatch.setattr(rig.hub, "check_native", lambda sid, b: None)  # the native log is not what is tested here
    rig.terms.open.discard("s-b")
    rid, _ = await go(rig)
    await rig.deliver(rid)  # the hub started the headless run; the hand-off hook wrote in_flight first
    lv = rig.hub._get("s-b")
    assert lv.running
    rig.show("s-b", rig.user("s-b", "u1", rid))
    s = rig.dp.interrupt(rid)
    assert s["state"] == "interrupted" and s["stopped"]["how"] == "headless run cancelled"
    await asyncio.sleep(0.2)
    assert not lv.running


# ——— sources and targets ———
async def test_dispatch_rules(rig):
    with pytest.raises(DispatchError, match="itself"):
        await rig.dp.dispatch(source=SRC, task="x", to="s-a")
    with pytest.raises(DispatchError, match="no agent"):
        await rig.dp.dispatch(source=SRC, task="x", to="s-none")
    with pytest.raises(DispatchError, match="exactly one"):
        await rig.dp.dispatch(source=SRC, task="x")
    with pytest.raises(DispatchError, match="empty"):
        await rig.dp.dispatch(source=SRC, task=" ", to="s-b")
    with pytest.raises(DispatchError, match="--new takes"):
        await rig.dp.dispatch(source=SRC, task="x", new="no-such-agent")  # (Grok was the example while it was observed only)


async def test_a_new_session_is_made_and_bound_like_one_made_by_hand(rig, store, monkeypatch):
    sent = []
    monkeypatch.setattr(rig.hub, "send", lambda sid, prompt: sent.append((sid, prompt)) or {"sendId": "m-1", "route": "headless"})
    s = await rig.dp.dispatch(source=SRC, task="加一行", new="codex", model="", effort="")
    sid = s["target"]["sessionId"]
    assert s["target"]["new"] is True and s["target"]["agent"] == "codex" and store.read_binding(sid)["agent"] == "codex"
    head = store.read_session(sid)[0]["session"]
    assert head["canvasId"] == "c1" and head["turnIds"] == [] and head["createdAt"] > 0  # on the giver's canvas, in the shape the page reads
    assert sent and sent[0][0] == sid and f"agora-req-{s['id']}" in sent[0][1]


async def test_a_target_that_cannot_take_it_is_a_failed_dispatch_not_a_lost_one(rig, monkeypatch):
    def refuse(sid, prompt):
        raise agents.NativeMissing("codex", NID_B, agents.LogLookup("missing"))

    monkeypatch.setattr(rig.hub, "send", refuse)
    rid, s = await go(rig)
    assert s["state"] == "failed" and "codex" in s["error"] or s["error"]


# ——— a canvas comment handed to a session ———
async def test_a_comment_dispatch_posts_the_answer_into_the_thread_from_the_server(rig, store):
    t = {"id": "t1", "n": 1, "anchor": {"ids": ["r"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 0, "y": 0}}, "resolved": False, "messages": [{"id": "m0", "author": "you", "text": "把缓存换成 Redis", "at": 1}], "createdAt": 1}
    store.thread_op("c1", {"op": "create", "thread": t})
    src = {"kind": "comment", "canvasId": "c1", "threadId": "t1", "threadN": 1}
    s = await rig.dp.dispatch(source=src, task="画布评论 #1：把缓存换成 Redis", to="s-b", inline=True, expects_reply=False, canvas_id="c1")
    rid = s["id"]
    await rig.deliver(rid)
    (sid, text), = rig.terms.pastes
    assert text.startswith("画布评论 #1：把缓存换成 Redis") and f"agora-req-{rid}" in text  # the comment itself is the message
    rig.show("s-b", rig.user("s-b", "u1", rid), {"id": "a1", "kind": "assistant", "text": "已把缓存换成 Redis。", "at": 1100}, {"id": "end-u1", "kind": "end", "at": 1200, "turn": "u1"})
    assert rig.state(rid) == "done"  # no receipt needed: the turn's answer is the reply
    await asyncio.sleep(0.3)
    data = json.loads((store.dir / "threads" / "c1.json").read_text())
    msgs = data["threads"][0]["messages"]
    assert msgs[-1]["author"] == "agent" and msgs[-1]["text"] == "已把缓存换成 Redis。" and msgs[-1]["sessionId"] == "s-b"
    assert [t for sid, t in rig.terms.pastes if sid == "s-a"] == []  # nobody else is told
    # …and a page that was reloaded meanwhile loses nothing: the answer is in the file.


async def test_a_failed_comment_dispatch_says_so_in_the_thread(rig, store):
    t = {"id": "t1", "n": 1, "anchor": {"ids": ["r"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 0, "y": 0}}, "resolved": False, "messages": [], "createdAt": 1}
    store.thread_op("c1", {"op": "create", "thread": t})
    s = await rig.dp.dispatch(source={"kind": "comment", "canvasId": "c1", "threadId": "t1", "threadN": 1}, task="改", to="s-b", inline=True, expects_reply=False)
    await rig.deliver(s["id"])
    rig.show("s-b", rig.user("s-b", "u1", s["id"]), {"id": "end-u1", "kind": "end", "at": 5, "turn": "u1", "error": "额度用完"})
    await asyncio.sleep(0.3)
    m = json.loads((store.dir / "threads" / "c1.json").read_text())["threads"][0]["messages"][-1]
    assert m["author"] == "system" and m["tone"] == "error" and "额度用完" in m["text"]


# ——— the file receipt (agora reply without a server) ———
async def test_a_receipt_written_as_files_is_taken_up(rig):
    rid, s = await go(rig)
    folder = Path(s["dir"])
    (folder / "reply.md").write_text("文件里的回执")
    (folder / "reply.status").write_text("blocked")
    rig.dp.status(rid)
    d = rig.dp.get(rid)
    assert d.reply["status"] == "blocked" and d.reply["summary"] == "文件里的回执" and not (folder / "reply.status").exists()


async def test_a_turn_that_was_running_at_the_restart_is_uncertain_until_the_log_shows_its_end(rig, store, monkeypatch):
    rid, _ = await go(rig)
    await rig.deliver(rid)
    rig.show("s-b", rig.user("s-b", "u1", rid))
    assert rig.state(rid) == "running"
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    log = [rig.user("s-b", "u1", rid)]
    monkeypatch.setattr(hub2, "items", lambda sid: list(log) if sid == "s-b" else [])
    dp2.recover()
    d = dp2.get(rid)
    assert derive_state(d) == "unknown" and d.delivery.bound.turn == "u1" and "no end yet" in d.delivery.note and hub2.terms.pastes == []
    log.append({"id": "end-u1", "kind": "end", "at": 9, "turn": "u1"})  # the process that outlived the restart finished
    dp2._sync(d, log)
    assert dp2.get(rid).delivery.turn_state == "completed" and derive_state(dp2.get(rid)) == "idle_no_reply"
