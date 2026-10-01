"""Dispatches (server/canvas/dispatch.py): the flow A → B, told only by B's own log and its receipt.

The hub is the real ``AgentHub``; the terminal is a fake (two sessions with panes, so nothing runs a CLI)
and B's "log" is what the test puts into the hub's transcript, in the shape the adapters project (the three
CLIs' real records are checked in test_dispatch_marks)."""

from __future__ import annotations

import asyncio
import json
import signal
import time
from pathlib import Path

import pytest

from server.canvas import agents
from server.canvas.dispatch import Dispatches, DispatchError
from server.canvas.dispatch_store import derive_state
from server.canvas.project import ProjectStore
from server.canvas.sessions import AgentHub
from server.canvas.terminal import PasteSubmitFailed, make_gate

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


async def test_a_restart_whose_target_log_gained_records_does_not_wait_on_its_own_lock(rig, store, monkeypatch):
    # The server was killed while B's turn ran and B's CLI went on writing. At the next start `recover()` reads that
    # log on the loop thread, the follower tells the listeners about the new records while it holds the follower
    # lock, and the dispatch listener looks at the same transcript: it must not wait for a lock this thread holds.
    rid, _ = await go(rig)
    await rig.deliver(rid)
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    real = hub2._follow_locked

    def follow_finding_news(sid, lv):
        real(sid, lv)
        if sid == "s-b":
            news = rig.user(sid, "u1", rid)
            lv.items[news["id"]] = news
            hub2.broadcast({"t": "transcript", "sessionId": sid, "items": [news]})

    monkeypatch.setattr(hub2, "_follow_locked", follow_finding_news)
    stuck = []

    def give_up(*_):
        stuck.append(True)
        raise TimeoutError  # a lock wait is interrupted by the signal; the hub's listener guard swallows this, hence the flag

    old = signal.signal(signal.SIGALRM, give_up)
    signal.setitimer(signal.ITIMER_REAL, 5)
    try:
        dp2.recover()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)
    assert not stuck, "recover() waited on a lock its own thread holds"
    d = dp2.get(rid)
    assert d.delivery.bound is not None and d.delivery.bound.turn == "u1" and hub2.terms.pastes == []


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


# ——— RVF-C: the receipt notification is at-least-once-noticed and exactly-once-sent ———
def told_a(rig):
    return [t for sid, t in rig.terms.pastes if sid == "s-a"]


async def finish(rig, rid):
    await rig.deliver(rid)
    rig.show("s-b", rig.user("s-b", "u1", rid))
    rig.show("s-b", {"id": "a1", "kind": "assistant", "text": "加好了", "at": 1100}, {"id": "end-u1", "kind": "end", "at": 1200, "turn": "u1"})
    rig.dp.reply(rid, "done", "已加", session="s-b")


async def test_a_failed_notification_is_not_marked_as_sent_and_says_why(rig, monkeypatch):
    real = rig.hub.send

    def refuse(sid, prompt):
        if sid == "s-a":
            raise RuntimeError("s-a 的日志没了")
        return real(sid, prompt)

    monkeypatch.setattr(rig.hub, "send", refuse)
    rid, _ = await go(rig)
    await finish(rig, rid)
    await asyncio.sleep(0.5)
    d = rig.dp.get(rid)
    assert rig.state(rid) == "done" and d.notified is None  # not "told": it was not
    assert "s-a 的日志没了" in (d.delivery.note or "") and "通知" in d.delivery.note  # the reason is in the record, not swallowed
    monkeypatch.setattr(rig.hub, "send", real)
    rig.dp.recover()  # the next start tells it
    await asyncio.sleep(0.8)
    assert len(told_a(rig)) == 1 and rig.dp.get(rid).notified == "done"
    rig.dp.recover()
    await asyncio.sleep(0.5)
    assert len(told_a(rig)) == 1  # and only once


async def test_a_dispatch_that_ended_but_was_never_told_is_told_once_after_a_restart(rig, store):
    rid, _ = await go(rig)
    await finish(rig, rid)
    await asyncio.sleep(0.8)
    assert len(told_a(rig)) == 1
    d = rig.dp.get(rid)
    d.notified = None  # the server died between "it ended" and "the source was told"
    rig.dp.files.write(d)
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    lv = hub2._get("s-a")
    dp2.recover()
    await asyncio.sleep(0.8)
    told2 = [t for sid, t in hub2.terms.pastes if sid == "s-a"]
    assert len(told2) == 1 and "完成了" in told2[0] and dp2.get(rid).notified == "done"
    dp2.recover()
    await asyncio.sleep(0.4)
    assert len([t for sid, t in hub2.terms.pastes if sid == "s-a"]) == 1


async def test_a_note_the_source_already_shows_in_its_log_is_not_sent_again(rig, store):
    rid, _ = await go(rig)
    await finish(rig, rid)
    await asyncio.sleep(0.8)
    d = rig.dp.get(rid)
    d.notified = None  # sent, but the crash came before "notified" was written
    rig.dp.files.write(d)
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    hub2._get("s-a").items["n1"] = {"id": "n1", "kind": "user", "text": "[Agora 派发回执]", "at": 1, "source": "agora", "receipt": f"{rid}:done"}
    dp2.recover()
    await asyncio.sleep(0.6)
    assert [t for sid, t in hub2.terms.pastes if sid == "s-a"] == [] and dp2.get(rid).notified == "done"


async def test_the_open_set_is_read_under_the_lock(rig):
    """`reply()` (a worker thread) changes `_open` under the lock; `_on_event` must not walk it without it."""
    held = []

    class Watching(dict):
        def items(self):
            held.append(rig.dp.lock._is_owned())
            return super().items()

    rid, _ = await go(rig)
    rig.dp._open = Watching(rig.dp._open)
    rig.dp._on_event({"t": "done", "sessionId": "s-b"})
    assert held and all(held)


async def test_request_seq_never_repeats(rig):
    seqs = []
    for i in range(3):
        rid, _ = await go(rig)
        seqs.append(rig.dp.get(rid).delivery.request.origin.request_seq)
        if i == 0:
            (rig.store.dir / "dispatch" / f"{rid}.json").unlink()  # a record went away: `len(all()) + 1` would repeat
    assert len(set(seqs)) == 3 and seqs == sorted(seqs)


async def test_a_new_session_whose_send_failed_does_not_stay_behind(rig, store, monkeypatch):
    def refuse(sid, prompt):
        raise RuntimeError("cannot send")

    monkeypatch.setattr(rig.hub, "send", refuse)
    before = set(store.bindings())
    s = await rig.dp.dispatch(source=SRC, task="加一行", new="codex", model="", effort="")
    assert s["state"] == "failed" and "cannot send" in s["error"]
    assert set(store.bindings()) == before  # no empty session left over
    assert not (store.dir / "sessions" / f"{s['target']['sessionId']}.jsonl").exists()


# ——— RVF-C: pasted, but Enter failed ———
class PasteThenFail(FakeTerms):
    def paste(self, sid, text, **_):
        self.pastes.append((sid, text))
        raise PasteSubmitFailed("send-keys Enter failed")


async def test_a_paste_whose_enter_failed_is_not_run_again_by_the_headless_path(store):
    terms = PasteThenFail("s-a", "s-b")
    hub = AgentHub(store, terminals=terms, backend_factory=lambda kind: (_ for _ in ()).throw(AssertionError("must not run headless")))
    dp = Dispatches(hub)
    hub.ensure_started()
    try:
        s = await dp.dispatch(source=SRC, task="加一行", to="s-b")
        rid = s["id"]
        sub = hub.subscribe(executor=False)
        for _ in range(100):
            d = dp.get(rid)
            if d.delivery.turn_state == "uncertain":
                break
            await asyncio.sleep(0.05)
        d = dp.get(rid)
        assert d.delivery.turn_state == "uncertain" and derive_state(d) == "unknown"  # not "failed", not run twice
        assert "输入框" in d.delivery.note or "已粘贴" in d.delivery.note
        lv = hub._get("s-b")
        assert not lv.headless and not lv.pane and not lv.running  # nothing was sent the headless way
        assert len(terms.pastes) == 1
    finally:
        await hub.close()


# ——— a comment thread is one conversation (web/docs/workstation.md §12) ———
def _thread(store, n=1):
    t = {"id": "t1", "n": n, "anchor": {"ids": ["r"], "rel": {"x": 0.5, "y": 0.5}, "last": {"x": 0, "y": 0}}, "resolved": False, "messages": [{"id": "m0", "author": "you", "text": "加个说明节点", "at": 1}], "createdAt": 1}
    store.thread_op("c1", {"op": "create", "thread": t})


def _handoff(store):
    return json.loads((store.dir / "threads" / "c1.json").read_text())["threads"][0].get("handoff")


COMMENT = {"kind": "comment", "canvasId": "c1", "threadId": "t1", "threadN": 1, "name": "评论 #1 · r"}


async def test_the_first_at_opens_a_new_conversation_and_binds_the_thread_to_it(rig, store, monkeypatch):
    monkeypatch.setattr(rig.hub, "send", lambda sid, prompt: {"sendId": "m-1", "route": "headless"})
    _thread(store)
    s = await rig.dp.dispatch(source=COMMENT, task="画布评论 #1", new="codex", inline=True, expects_reply=False, canvas_id="c1")
    sid = s["target"]["sessionId"]
    assert s["target"]["new"] is True
    assert _handoff(store) == {"sessionId": sid, "agent": "codex", "name": "评论 #1 · r"}  # the record of the thread is the binding


async def test_later_messages_go_to_the_bound_conversation_and_keep_the_binding(rig, store, monkeypatch):
    monkeypatch.setattr(rig.hub, "send", lambda sid, prompt: {"sendId": f"m-{sid}", "route": "headless"})
    _thread(store)
    first = await rig.dp.dispatch(source=COMMENT, task="一", new="codex", inline=True, expects_reply=False, canvas_id="c1")
    sid = first["target"]["sessionId"]
    again = await rig.dp.dispatch(source=COMMENT, task="二", to=sid, inline=True, expects_reply=False, canvas_id="c1")
    assert again["target"] == {"sessionId": sid, "agent": "codex", "new": False}  # the same conversation, not a second one
    assert _handoff(store)["sessionId"] == sid
    assert len([b for b in store.bindings() if b not in ("s-a", "s-b")]) == 1


async def test_an_at_on_an_existing_conversation_binds_the_thread_to_that_one(rig, store, monkeypatch):
    monkeypatch.setattr(rig.hub, "send", lambda sid, prompt: {"sendId": "m-1", "route": "headless"})
    _thread(store)
    await rig.dp.dispatch(source={**COMMENT, "name": "主对话"}, task="x", to="s-b", inline=True, expects_reply=False, canvas_id="c1")
    assert _handoff(store) == {"sessionId": "s-b", "agent": "codex", "name": "主对话"}


async def test_a_bound_conversation_that_is_gone_is_refused_and_the_binding_stays_for_the_page_to_end(rig, store, monkeypatch):
    monkeypatch.setattr(rig.hub, "send", lambda sid, prompt: {"sendId": "m-1", "route": "headless"})
    _thread(store)
    await rig.dp.dispatch(source=COMMENT, task="一", to="s-b", inline=True, expects_reply=False, canvas_id="c1")
    store.delete_session("s-b") if hasattr(store, "delete_session") else store.discard_session("s-b")
    with pytest.raises(DispatchError, match="no agent"):
        await rig.dp.dispatch(source=COMMENT, task="二", to="s-b", inline=True, expects_reply=False, canvas_id="c1")
    assert _handoff(store)["sessionId"] == "s-b"  # the page tells the person and ends the hand-off


async def test_a_comment_that_could_not_be_sent_binds_nothing(rig, store, monkeypatch):
    def refuse(sid, prompt):
        raise agents.NativeMissing("codex", NID_B, agents.LogLookup("missing"))

    monkeypatch.setattr(rig.hub, "send", refuse)
    _thread(store)
    s = await rig.dp.dispatch(source=COMMENT, task="x", to="s-b", inline=True, expects_reply=False, canvas_id="c1")
    assert s["error"] and _handoff(store) is None


def test_ending_a_hand_off_is_a_thread_op_that_wins_over_an_older_copy(store):
    from server.canvas.project import merge_thread_files

    _thread(store)
    store.thread_op("c1", {"op": "bind", "threadId": "t1", "handoff": {"sessionId": "s-b", "agent": "codex", "name": "n"}, "at": 100})
    data, _, t = store.thread_op("c1", {"op": "unbind", "threadId": "t1", "at": 200})
    assert t["handoff"] is None and t["updatedAt"] == 200
    older = {"seq": 1, "threads": [{**t, "handoff": {"sessionId": "s-b", "agent": "codex", "name": "n"}, "updatedAt": 100}]}
    merged = merge_thread_files(data, older)  # a page that still had the binding saves: the later unbinding stays
    assert merged["threads"][0]["handoff"] is None


async def test_a_thread_the_page_has_not_saved_yet_is_bound_when_the_answer_arrives(rig, store):
    """The page creates the thread and dispatches at once; its file is saved a moment later."""
    s = await rig.dp.dispatch(source=COMMENT, task="x", to="s-b", inline=True, expects_reply=False, canvas_id="c1")  # no thread file yet: nothing to bind
    _thread(store)  # ... the page's save arrives
    await rig.deliver(s["id"])
    rig.show("s-b", rig.user("s-b", "u1", s["id"]), {"id": "a1", "kind": "assistant", "text": "好了", "at": 1100}, {"id": "end-u1", "kind": "end", "at": 1200, "turn": "u1"})
    await asyncio.sleep(0.3)
    assert _handoff(store) == {"sessionId": "s-b", "agent": "codex", "name": "评论 #1 · r"}


async def test_an_answer_does_not_bind_again_a_thread_whose_hand_off_the_person_ended(rig, store):
    _thread(store)
    s = await rig.dp.dispatch(source=COMMENT, task="x", to="s-b", inline=True, expects_reply=False, canvas_id="c1")
    store.thread_op("c1", {"op": "unbind", "threadId": "t1"})  # 「结束交接」 while the agent is still working
    await rig.deliver(s["id"])
    rig.show("s-b", rig.user("s-b", "u1", s["id"]), {"id": "a1", "kind": "assistant", "text": "好了", "at": 1100}, {"id": "end-u1", "kind": "end", "at": 1200, "turn": "u1"})
    await asyncio.sleep(0.3)
    assert _handoff(store) is None  # the answer is posted, the thread stays ordinary



# ——— RVF-D: B (a queued note is not a delivered one), C (a failed hand-off hook), F (the log follower's lock) ———
async def test_a_note_that_was_only_queued_when_the_server_died_is_sent_again_once(rig, store, monkeypatch):
    """`notified` is written when the note is queued; if the server dies before it reaches the source's log the source
    would wait for ever. A restart looks for the note in the source's own log and sends it again if it is not there."""
    real = rig.hub.send
    monkeypatch.setattr(rig.hub, "send", lambda sid, prompt: {"sendId": "m-q", "route": "queued"} if sid == "s-a" else real(sid, prompt))  # queued, never delivered
    rid, _ = await go(rig)
    await finish(rig, rid)
    await asyncio.sleep(0.8)
    assert rig.dp.get(rid).notified == "done" and told_a(rig) == []  # "told" as far as the record knows; the source's log has nothing
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    dp2.recover()
    await asyncio.sleep(0.8)
    assert len([t for sid, t in hub2.terms.pastes if sid == "s-a"]) == 1  # sent again after the restart
    hub2._get("s-a").items["n1"] = {"id": "n1", "kind": "user", "text": "[Agora 派发回执]", "at": 1, "source": "agora", "receipt": f"{rid}:done"}  # ... and it arrived
    dp2.recover()
    await asyncio.sleep(0.5)
    assert len([t for sid, t in hub2.terms.pastes if sid == "s-a"]) == 1  # only once


async def test_a_handoff_hook_that_fails_makes_the_dispatch_failed_and_a_restart_does_not_deliver_it(rig, store):
    def broken(sid, send_id):
        raise OSError("磁盘满了")

    rig.hub.handoff_hooks.insert(0, broken)  # runs before the dispatch's own hook: the record stays `pending`
    rid, _ = await go(rig)
    await asyncio.sleep(1.0)
    d = rig.dp.get(rid)
    assert derive_state(d) == "failed" and "没能交付" in d.error and "磁盘满了" in d.error
    assert d.delivery.turn_state == "pending"  # it was never handed over
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    dp2.recover()
    await asyncio.sleep(0.6)
    assert [t for sid, t in hub2.terms.pastes if sid == "s-b"] == [] and derive_state(dp2.get(rid)) == "failed"


async def test_the_log_followers_items_are_read_under_the_follow_lock(rig):
    """`_follow_locked` changes `live.items` under `_follow_lock`; `_on_event` (the event loop) must copy it under the same lock."""
    from collections import OrderedDict

    held = []

    class Watching(OrderedDict):
        def values(self):
            held.append(rig.hub._follow_lock._is_owned())  # held by this very thread
            return super().values()

    rid, _ = await go(rig)
    lv = rig.hub._get("s-b")
    lv.items = Watching(lv.items)
    rig.dp._open[rid] = "s-b"
    rig.dp._on_event({"t": "transcript", "sessionId": "s-b", "items": []})
    assert held and all(held)


# ——— RVF-D round 2: only a note that was sent with a marker can be missed for lack of one ———
async def test_an_old_record_without_the_marker_field_is_not_told_again_after_a_restart(rig, store):
    """Records from before the receipt marker existed have no `notice`: their log has no marker whatever happened to them."""
    rid, _ = await go(rig)
    await finish(rig, rid)
    await asyncio.sleep(0.8)
    d = rig.dp.get(rid)
    d.notice = None  # what an old record looks like: told (`notified`), nothing about a marker
    d.notified = "done"
    rig.dp.files.write(d)
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    dp2.recover()
    await asyncio.sleep(0.8)
    assert [t for sid, t in hub2.terms.pastes if sid == "s-a"] == []  # the source's log has no marker, and never will


async def test_a_record_that_says_it_sent_a_marker_that_the_log_lacks_is_told_once_more(rig, store):
    rid, _ = await go(rig)
    await finish(rig, rid)
    await asyncio.sleep(0.8)
    d = rig.dp.get(rid)
    d.notified = "done"
    d.notice = {"state": "done", "mark": True, "at": 1}  # the note went out with `agora-receipt-<id>:done`
    rig.dp.files.write(d)
    assert rig.dp.get(rid).notice == {"state": "done", "mark": True, "at": 1}  # it is in the record, not only in memory
    hub2 = AgentHub(store, terminals=FakeTerms("s-a", "s-b"))
    dp2 = Dispatches(hub2)
    dp2.recover()
    await asyncio.sleep(0.8)
    assert len([t for sid, t in hub2.terms.pastes if sid == "s-a"]) == 1
    hub2._get("s-a").items["n1"] = {"id": "n1", "kind": "user", "text": "[Agora 派发回执]", "at": 1, "source": "agora", "receipt": f"{rid}:done"}
    dp2.recover()
    await asyncio.sleep(0.5)
    assert len([t for sid, t in hub2.terms.pastes if sid == "s-a"]) == 1  # once


async def test_a_note_sent_now_records_that_it_carried_the_marker(rig):
    rid, _ = await go(rig)
    await finish(rig, rid)
    await asyncio.sleep(0.8)
    n = rig.dp.get(rid).notice
    assert n and n["state"] == "done" and n["mark"] is True and n["at"] > 0
