"""What a two-way Claude turn asks the person (N2): the hub keeps the open requests as runtime state,
takes the answers, ends them with the turn, and never replays them after a restart.
The CLI is tests/fake_claude_duplex.py; its wire format is pinned in tests/test_claude_duplex.py."""

import asyncio
import os
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.canvas import agents, runner
from server.canvas.agents import ClaudeCodeBackend
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app
from server.canvas.sessions import AgentHub

FAKE = Path(__file__).parent / "fake_claude_duplex.py"


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构图"}], "root": {}, "focused": "c1"}, base=None)
    s.bind("s-1", agent="claude", model="", effort="", native_id=str(uuid.uuid4()), started=False)
    return s


def hub_for(store, tmp_path, mode):
    env = {"FAKE_DUPLEX_MODE": mode, "FAKE_DUPLEX_LOG": str(tmp_path / "stdin.log")}
    return AgentHub(store, backend_factory=lambda kind: ClaudeCodeBackend([sys.executable, str(FAKE)], env=env))


async def until(q, pred, timeout=10.0):
    got = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ev = await asyncio.wait_for(q.get(), 0.2)
        except TimeoutError:
            continue
        got.append(ev)
        if pred(ev):
            return got
    raise AssertionError(f"timed out; saw {[(e.get('t'), (e.get('event') or {}).get('t')) for e in got]}")


def stdin_lines(tmp_path):
    return [json.loads(x) for x in (tmp_path / "stdin.log").read_text().splitlines()]


async def test_a_question_waits_for_the_person_and_the_answer_goes_back(store, tmp_path):
    hub = hub_for(store, tmp_path, "ask")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "问我")
    evs = await until(sub.q, lambda e: e.get("t") == "request")
    req = evs[-1]["request"]
    assert req["kind"] == "question" and req["questions"][0]["options"][1]["label"] == "Banana"
    st = hub.status("s-1")
    assert st["waiting"] is True and st["running"] is True and st["mode"] == {"actual": "auto", "asked": "auto"}
    assert [r["id"] for r in hub.requests("s-1")] == [req["id"]]
    with pytest.raises(ValueError):  # not one of its options
        hub.answer_request("s-1", req["id"], {"decision": "allow", "answers": {"Which fruit?": "Cherry"}})
    hub.answer_request("s-1", req["id"], {"decision": "allow", "answers": {"Which fruit?": "Banana"}})
    got = await until(sub.q, lambda e: e.get("t") == "done")
    assert any(e.get("t") == "request_cancel" and e["id"] == req["id"] for e in got)  # the card goes away
    assert got[-1]["error"] is None and hub.requests("s-1") == [] and hub.status("s-1")["waiting"] is False
    assert stdin_lines(tmp_path)[1]["response"]["response"]["updatedInput"]["answers"] == {"Which fruit?": "Banana"}
    with pytest.raises(KeyError):  # answered once, gone
        hub.answer_request("s-1", req["id"], {"decision": "deny"})


async def test_an_approval_can_be_allowed_for_the_session_or_denied(store, tmp_path):
    hub = hub_for(store, tmp_path, "approve")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "写个文件")
    evs = await until(sub.q, lambda e: e.get("t") == "request")
    req = evs[-1]["request"]
    assert req["kind"] == "approval" and req["tool"] == "Write" and req["canSession"] is True and "a.txt" in req["summary"]
    assert hub.status("s-1")["mode"] == {"actual": "default", "asked": "auto"}  # the model has no auto: the page says so
    hub.answer_request("s-1", req["id"], {"decision": "allow_session"})
    await until(sub.q, lambda e: e.get("t") == "done")
    body = stdin_lines(tmp_path)[1]["response"]["response"]
    assert body["behavior"] == "allow" and body["updatedPermissions"] == [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]



async def test_a_call_the_person_denied_is_not_reported_as_blocked_by_auto(store, tmp_path):
    hub = hub_for(store, tmp_path, "approve")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "写个文件")
    req = (await until(sub.q, lambda e: e.get("t") == "request"))[-1]["request"]
    hub.answer_request("s-1", req["id"], {"decision": "deny", "message": "不要"})
    got = await until(sub.q, lambda e: e.get("t") == "done")
    assert [i for e in got if e.get("t") == "transcript" for i in e["items"] if i["kind"] == "notice"] == []  # the CLI lists it in permission_denials, but it was the person's decision


async def test_the_transcript_shows_the_waiting_call_before_the_log_has_it(store, tmp_path):
    hub = hub_for(store, tmp_path, "ask")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "问我")
    req = (await until(sub.q, lambda e: e.get("t") == "request"))[-1]["request"]
    it = hub._get("s-1").items[req["toolUseId"]]
    assert it["kind"] == "tool" and it["tool"]["name"] == "AskUserQuestion" and it["tool"]["input"] == "Which fruit?" and it["tool"]["waitsUser"] is True
    hub.answer_request("s-1", req["id"], {"decision": "deny"})
    await until(sub.q, lambda e: e.get("t") == "done")
    assert hub._get("s-1").items[req["toolUseId"]]["tool"]["waitsUser"] is True  # a question is a wait by nature (its result ends it)


async def test_an_approval_can_be_denied_with_a_reason(store, tmp_path):
    hub = hub_for(store, tmp_path, "approve")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "写个文件")
    req = (await until(sub.q, lambda e: e.get("t") == "request"))[-1]["request"]
    hub.answer_request("s-1", req["id"], {"decision": "deny", "message": "先别动这个文件"})
    await until(sub.q, lambda e: e.get("t") == "done")
    assert stdin_lines(tmp_path)[1]["response"]["response"] == {"behavior": "deny", "message": "先别动这个文件"}


async def test_the_waiting_tool_call_shows_as_waiting_until_answered(store, tmp_path):
    """The runs on the workstation come from the transcript: the tool call a request is about is the wait."""
    hub = hub_for(store, tmp_path, "approve")
    lv = hub._get("s-1")
    lv.items["tu-1"] = {"id": "tu-1", "kind": "tool", "at": 1, "tool": {"name": "Write", "input": "a.txt", "activity": "write"}}
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "写个文件")
    await until(sub.q, lambda e: e.get("t") == "request")
    assert lv.items["tu-1"]["tool"]["waitsUser"] is True
    hub.answer_request("s-1", next(iter(lv.requests)), {"decision": "allow"})
    await until(sub.q, lambda e: e.get("t") == "done")
    assert not lv.items["tu-1"]["tool"].get("waitsUser") and not lv.items["tu-1"]["tool"].get("hostWait")


async def test_interrupt_with_a_request_open_ends_the_turn_and_withdraws_the_card(store, tmp_path):
    hub = hub_for(store, tmp_path, "ask")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "问我")
    await until(sub.q, lambda e: e.get("t") == "request")
    assert hub.interrupt("s-1") is True
    got = await until(sub.q, lambda e: e.get("t") == "done")
    assert any(e.get("t") == "request_cancel" for e in got)
    assert got[-1]["error"] == "已停止" and hub.requests("s-1") == []
    st = hub.status("s-1")
    assert st["running"] is False and st["waiting"] is False
    assert any(x.get("request", {}).get("subtype") == "interrupt" for x in stdin_lines(tmp_path) if x.get("type") == "control_request")


async def test_a_call_that_was_pending_when_interrupted_is_not_reported_as_blocked(store, tmp_path):
    hub = hub_for(store, tmp_path, "approve")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "写个文件")
    await until(sub.q, lambda e: e.get("t") == "request")
    hub.interrupt("s-1")
    got = await until(sub.q, lambda e: e.get("t") == "done")
    assert [i for e in got if e.get("t") == "transcript" for i in e["items"] if i["kind"] == "notice"] == []


async def test_interrupt_while_a_tool_runs(store, tmp_path):
    hub = hub_for(store, tmp_path, "hang")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "跑个长命令")
    await until(sub.q, lambda e: e.get("t") == "run" and e["event"]["t"] == "tool_use")
    assert hub.interrupt("s-1") is True
    got = await until(sub.q, lambda e: e.get("t") == "done")
    assert got[-1]["error"] == "已停止" and hub.status("s-1")["running"] is False


async def test_a_blocked_action_is_said_in_the_conversation(store, tmp_path):
    hub = hub_for(store, tmp_path, "deny_note")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "把权限全开")
    got = await until(sub.q, lambda e: e.get("t") == "done")
    note = next(i for e in got if e.get("t") == "transcript" for i in e["items"] if i["kind"] == "notice")
    assert note["tone"] == "denied" and note["text"] == "被 auto 拦下：Write /work/proj/.claude/settings.json"
    assert hub.item("s-1", note["id"])["text"] == note["text"]  # part of the transcript, not only a toast


async def test_following_the_log_while_a_request_is_open_does_not_deadlock(store, tmp_path, monkeypatch):
    """The follower holds the transcript lock while it reads the log; marking the open request's call must not take it again."""
    hub = hub_for(store, tmp_path, "approve")
    log = tmp_path / "native.jsonl"
    log.write_text(json.dumps({"type": "user", "uuid": "u1", "timestamp": "2026-09-29T06:00:00.000Z", "message": {"role": "user", "content": "问我"}}) + "\n")
    monkeypatch.setattr(agents, "locate_log", lambda kind, nid, root=None, home=None, hint=None: agents.LogLookup("found", log, (log,)) if nid else agents.LogLookup("missing"))
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "问我")
    req = (await until(sub.q, lambda e: e.get("t") == "request"))[-1]["request"]
    lv = hub._get("s-1")
    lv.items[req["toolUseId"]]["tool"].pop("hostWait", None)  # as if the call came from the log with no mark yet
    with log.open("a") as fh:
        fh.write(json.dumps({"type": "assistant", "uuid": "a1", "timestamp": "2026-09-29T06:00:01.000Z", "message": {"id": "m1", "role": "assistant", "content": [{"type": "text", "text": "好"}]}}) + "\n")
    await asyncio.wait_for(asyncio.to_thread(hub._follow, "s-1", lv), 5)
    assert lv.items[req["toolUseId"]]["tool"]["hostWait"] is True  # marked again by the follower
    hub.interrupt("s-1")
    await until(sub.q, lambda e: e.get("t") == "done")


# ——— restart ———
def test_a_turn_a_restart_ended_is_recorded_and_never_replayed(store, tmp_path):
    proc = subprocess.Popen([sys.executable, str(FAKE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True, env={"FAKE_DUPLEX_MODE": "hang", "PATH": ""})
    argv = [sys.executable, str(FAKE)]
    marker = store.run_dir / "headless" / "s-1.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"pid": proc.pid, "argv": argv, "at": 1}))
    calls = []
    hub = AgentHub(store, backend_factory=lambda kind: calls.append(kind))  # a new server
    assert proc.wait(timeout=10) is not None  # the process nobody can answer is ended
    assert not marker.exists()
    hub._follow("s-1", hub._get("s-1"))
    notes = [i for i in hub._get("s-1").items.values() if i["kind"] == "notice"]
    assert len(notes) == 1 and notes[0]["tone"] == "interrupted" and "重启" in notes[0]["text"]
    assert hub.requests("s-1") == [] and calls == []  # nothing was sent again
    assert hub.status("s-1")["waiting"] is False and hub.status("s-1")["busy"] is False


def test_a_marker_never_ends_a_process_that_is_not_the_recorded_command(store):
    other = subprocess.Popen(["sleep", "30"], start_new_session=True)
    try:
        marker = store.run_dir / "headless" / "s-1.json"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps({"pid": other.pid, "argv": ["claude", "-p"], "at": 1}))  # the pid was reused by something else
        AgentHub(store)
        assert other.poll() is None
    finally:
        other.kill()


async def test_the_marker_is_there_while_the_turn_runs_and_gone_after(store, tmp_path):
    hub = hub_for(store, tmp_path, "ask")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "问我")
    req = (await until(sub.q, lambda e: e.get("t") == "request"))[-1]["request"]
    marker = store.run_dir / "headless" / "s-1.json"
    assert json.loads(marker.read_text())["pid"] > 0
    hub.answer_request("s-1", req["id"], {"decision": "deny"})
    await until(sub.q, lambda e: e.get("t") == "done")
    assert not marker.exists()


# ——— API ———
def test_api_lists_and_answers_requests(store, tmp_path, monkeypatch):
    env = {"FAKE_DUPLEX_MODE": "ask", "FAKE_DUPLEX_LOG": str(tmp_path / "stdin.log")}
    monkeypatch.setitem(runner.BACKENDS, "claude", lambda: ClaudeCodeBackend([sys.executable, str(FAKE)], env=env))
    with TestClient(create_project_app(store.root)) as c:
        assert c.get("/api/agent/sessions/s-1/requests").json() == {"requests": []}
        assert c.post("/api/agent/sessions/s-1/send", json={"text": "问我", "raw": True}).status_code == 200
        for _ in range(100):
            reqs = c.get("/api/agent/sessions/s-1/requests").json()["requests"]
            if reqs:
                break
            time.sleep(0.1)
        assert reqs and reqs[0]["kind"] == "question"
        rid = reqs[0]["id"]
        assert c.post(f"/api/agent/sessions/s-1/requests/{rid}", json={"decision": "allow", "answers": {"Which fruit?": "Cherry"}}).status_code == 400
        assert c.post(f"/api/agent/sessions/s-1/requests/{rid}", json={"decision": "maybe"}).status_code == 400
        assert c.post(f"/api/agent/sessions/s-1/requests/{rid}", json={"decision": "allow", "answers": {"Which fruit?": "Apple"}}).json() == {"ok": True}
        assert c.post(f"/api/agent/sessions/s-1/requests/{rid}", json={"decision": "deny"}).status_code == 404  # already answered
        assert c.post("/api/agent/sessions/s-1/interrupt").json() in ({"stopped": False}, {"stopped": True})
        assert c.get("/api/agent/sessions/nope/requests").status_code == 404


# ——— RVF-C ———
def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def marker_pid(store) -> int:
    return json.loads((store.run_dir / "headless" / "s-1.json").read_text())["pid"]


async def test_a_request_nobody_answers_is_waited_for_and_says_for_how_long(store, tmp_path):
    """No auto-deny: the turn keeps waiting for the person, but the status says since when."""
    hub = hub_for(store, tmp_path, "ask")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "问我")
    req = (await until(sub.q, lambda e: e.get("t") == "request"))[-1]["request"]
    st = hub.status("s-1")
    assert st["waiting"] is True and st["waitingSince"] == req["at"]  # ms since epoch: the page turns it into 「等你 N 分钟」
    hub._get("s-1").requests[req["id"]]["at"] -= 7 * 60_000  # seven minutes pass
    assert hub.status("s-1")["waitingSince"] == req["at"] - 7 * 60_000
    await asyncio.sleep(1.0)
    assert hub.status("s-1")["running"] is True and hub.requests("s-1")  # still there, not denied, not ended
    hub.interrupt("s-1")
    await until(sub.q, lambda e: e.get("t") == "done")
    assert hub.status("s-1")["waitingSince"] is None


async def test_interrupting_a_waiting_turn_leaves_no_process(store, tmp_path):
    hub = hub_for(store, tmp_path, "ask")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "问我")
    await until(sub.q, lambda e: e.get("t") == "request")
    pid = marker_pid(store)
    assert pid_alive(pid)
    hub.interrupt("s-1")
    await until(sub.q, lambda e: e.get("t") == "done")
    for _ in range(50):
        if not pid_alive(pid):
            break
        await asyncio.sleep(0.1)
    assert not pid_alive(pid)


async def test_closing_the_hub_with_a_request_open_ends_the_process_before_it_returns(store, tmp_path):
    """`agora down` closes the hub: the claude process waiting for an answer must be gone by then."""
    hub = hub_for(store, tmp_path, "ask")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "问我")
    await until(sub.q, lambda e: e.get("t") == "request")
    pid = marker_pid(store)
    await hub.close()
    assert not pid_alive(pid)


async def test_a_hand_off_hook_that_raises_does_not_leave_the_session_running(store, tmp_path):
    hub = hub_for(store, tmp_path, "ask")
    sub = hub.subscribe(executor=False)

    def boom(sid, send_id):
        raise OSError("disk full")

    hub.handoff_hooks.append(boom)
    hub.send("s-1", "写个文件")
    got = await until(sub.q, lambda e: e.get("t") == "done")
    assert "没能交付" in got[-1]["error"] and "disk full" in got[-1]["error"]
    st = hub.status("s-1")
    assert st["running"] is False and st["busy"] is False
    hub.handoff_hooks.clear()  # the queue is not stuck: the next message runs
    hub.send("s-1", "再来")
    req = (await until(sub.q, lambda e: e.get("t") == "request"))[-1]["request"]
    hub.answer_request("s-1", req["id"], {"decision": "deny"})
    await until(sub.q, lambda e: e.get("t") == "done")
