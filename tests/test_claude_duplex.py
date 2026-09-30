"""Claude Code headless over the two-way protocol (N2): what the CLI writes on stdout becomes requests,
modes and blocked actions; what the person answers becomes ``control_response`` lines.

Mapping is checked against real lines recorded on 2026-09-29 (Claude Code 2.1.284, sanitized, in
tests/fixtures/agents/claude-duplex/); the process itself is tests/fake_claude_duplex.py."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

from server.canvas.adapters import claude as cl
from server.canvas.agents import ClaudeCodeBackend, ClaudeStream
from server.canvas.runner import Control, ExecOptions, RunRequest

FIX = Path(__file__).parent / "fixtures" / "agents" / "claude-duplex"
FAKE = Path(__file__).parent / "fake_claude_duplex.py"


def feed(name: str) -> tuple[ClaudeStream, list[dict]]:
    m = ClaudeStream("m", "s")
    out: list[dict] = []
    for i, line in enumerate((FIX / f"{name}.jsonl").read_text().splitlines()):
        rec = json.loads(line)
        if "_sent" not in rec:
            out += m.feed(rec, 100 + i)
    return m, out


# ——— invocation ———
def test_headless_args_are_two_way_and_auto():
    req = RunRequest(schema=None, system=None, prompt="hi", options=ExecOptions(backend="claude", model="sonnet", effort="high", session="s-1", new_session=False))
    args = ClaudeCodeBackend().args(req)
    assert args[:10] == ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--permission-mode"]
    assert args[10] == "auto"
    assert ["--resume", "s-1"] == args[11:13] and "--effort" in args and "Bash(agora canvas *)" in args


def test_first_message_is_one_stream_json_line():
    req = RunRequest(schema=None, system=None, prompt="改一下\n第二行", options=ExecOptions(backend="claude"))
    raw = ClaudeCodeBackend().stdin(req)
    assert raw.endswith(b"\n") and raw.count(b"\n") == 1
    assert json.loads(raw) == {"type": "user", "message": {"role": "user", "content": "改一下\n第二行"}}


# ——— reading the CLI ———
def test_a_question_becomes_a_request_and_the_mode_is_known():
    _, evs = feed("ask")
    assert [e["t"] for e in evs] == ["mode", "request"]
    assert evs[0]["mode"] == "auto"
    q = evs[1]
    assert q["tool"] == "AskUserQuestion" and q["id"] and q["toolUseId"].startswith("toolu_")
    assert q["input"]["questions"][0]["options"][0]["label"] == "Apple"


def test_an_approval_request_keeps_the_cli_suggestions():
    _, evs = feed("approval")
    assert evs[0] == {"t": "mode", "at": 100, "mode": "default", "model": "claude-sonnet-5-5"} or evs[0]["mode"] == "default"
    reqs = [e for e in evs if e["t"] == "request"]
    assert [r["tool"] for r in reqs] == ["Edit", "Bash", "Bash"]
    assert reqs[0]["suggestions"] == [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]
    assert reqs[1]["suggestions"][0]["destination"] == "localSettings"  # the CLI's default: writes the project's file
    assert reqs[1]["reason"] == "This command requires approval" and reqs[1]["reasonType"] == "other"


def test_cancel_and_interrupted_end_are_not_failures():
    m, evs = feed("cancel")
    assert [e["t"] for e in evs if e["t"] in ("request", "request_cancel")] == ["request", "request_cancel"]
    assert evs[[e["t"] for e in evs].index("request_cancel")]["id"] == next(e["id"] for e in evs if e["t"] == "request")
    assert m.done is True
    first = ClaudeStream("m", "s")
    for line in (FIX / "cancel.jsonl").read_text().splitlines():
        rec = json.loads(line)
        if rec.get("type") == "result":
            first.feed(rec, 1)
            break
    assert first.interrupted is True and first.error is None and first.done is True


def test_a_blocked_action_is_reported_with_its_tool_and_summary():
    m, evs = feed("denied")
    assert [e["t"] for e in evs] == ["mode", "denied"]
    d = evs[1]["denials"]
    assert len(d) == 1 and d[0]["tool"] == "Write" and d[0]["toolUseId"].startswith("toolu_")
    assert ".claude/settings.json" in d[0]["summary"]
    assert m.error is None


# ——— answering ———
QUESTION = {"questions": [{"question": "Which fruit?", "header": "Fruit", "options": [{"label": "Apple"}, {"label": "Banana"}], "multiSelect": False}]}


def test_answer_puts_the_choice_in_updated_input():
    r = cl.answer_response("req-1", QUESTION, {"Which fruit?": "Banana"})
    assert r == {"type": "control_response", "response": {"subtype": "success", "request_id": "req-1", "response": {"behavior": "allow", "updatedInput": {**QUESTION, "answers": {"Which fruit?": "Banana"}}}}}


def test_a_multi_select_answer_is_joined():
    q = {"questions": [{"question": "Which?", "header": "h", "options": [{"label": "A"}, {"label": "B"}], "multiSelect": True}]}
    body = cl.answer_response("r", q, {"Which?": ["A", "B"]})["response"]["response"]
    assert body["updatedInput"]["answers"] == {"Which?": "A, B"}


def test_every_question_needs_an_answer_from_its_options():
    with pytest.raises(ValueError, match="Which fruit"):
        cl.answer_response("r", QUESTION, {})
    with pytest.raises(ValueError, match="Cherry"):
        cl.answer_response("r", QUESTION, {"Which fruit?": "Cherry"})


def test_approve_once_and_for_the_session():
    inp = {"file_path": "/work/proj/a.txt", "content": "x"}
    sug = [{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "rtk ls *"}], "behavior": "allow", "destination": "localSettings"}]
    once = cl.approve_response("r", inp, None)["response"]["response"]
    assert once == {"behavior": "allow", "updatedInput": inp}
    sess = cl.approve_response("r", inp, sug)["response"]["response"]
    assert sess["updatedInput"] == inp
    assert sess["updatedPermissions"] == [{**sug[0], "destination": "session"}]  # never the CLI's localSettings: that writes the project
    assert sug[0]["destination"] == "localSettings"  # the request's own data is not touched


def test_deny_carries_the_persons_words():
    r = cl.deny_response("r", "不要动这个文件")["response"]["response"]
    assert r == {"behavior": "deny", "message": "不要动这个文件"}
    assert cl.deny_response("r", "")["response"]["response"]["message"]  # a default reason: the model must be told something


def test_interrupt_request_shape():
    assert cl.interrupt_request("i-1") == {"type": "control_request", "request_id": "i-1", "request": {"subtype": "interrupt"}}


# ——— the process ———
def backend(tmp_path, mode, **kw):
    env = {"FAKE_DUPLEX_MODE": mode, "FAKE_DUPLEX_LOG": str(tmp_path / "stdin.log")}
    return ClaudeCodeBackend([sys.executable, str(FAKE)], env=env, **kw)


def request(tmp_path, control):
    return RunRequest(schema=None, system=None, prompt="问我一个问题", options=ExecOptions(backend="claude", model="m", session="s-native"), cwd=str(tmp_path), control=control)


async def run_answering(tmp_path, mode, reply):
    ctl = Control()
    seen = []
    async for ev in backend(tmp_path, mode).run(request(tmp_path, ctl)):
        seen.append(ev)
        if ev["t"] == "request":
            ctl.send(reply(ev))
    return seen


async def test_the_turn_waits_for_the_answer_and_stdin_stays_open(tmp_path):
    seen = await run_answering(tmp_path, "ask", lambda ev: cl.answer_response(ev["id"], ev["input"], {"Which fruit?": "Apple"}))
    assert [e["t"] for e in seen] == ["start", "spawned", "mode", "request", "result"]
    assert "error" not in seen[-1] and seen[-1]["raw"] == "done"
    lines = [json.loads(x) for x in (tmp_path / "stdin.log").read_text().splitlines()]
    assert lines[0]["type"] == "user" and lines[1]["response"]["response"]["updatedInput"]["answers"] == {"Which fruit?": "Apple"}


async def test_a_denied_request_still_ends_the_turn(tmp_path):
    seen = await run_answering(tmp_path, "approve", lambda ev: cl.deny_response(ev["id"], "no"))
    assert seen[-1]["t"] == "result" and "error" not in seen[-1]
    assert next(e for e in seen if e["t"] == "mode")["mode"] == "default"


async def test_blocked_actions_come_out_as_events(tmp_path):
    seen = [e async for e in backend(tmp_path, "deny_note").run(request(tmp_path, Control()))]
    assert [e["t"] for e in seen] == ["start", "spawned", "mode", "denied", "result"]


async def test_interrupt_ends_the_turn_cleanly_and_cancels_the_pending_request(tmp_path):
    ctl = Control()
    seen = []
    async for ev in backend(tmp_path, "ask").run(request(tmp_path, ctl)):
        seen.append(ev)
        if ev["t"] == "request":
            ctl.send(cl.interrupt_request("i-1"))
    kinds = [e["t"] for e in seen]
    assert kinds == ["start", "spawned", "mode", "request", "request_cancel", "denied", "result"]  # the CLI lists the withdrawn call in permission_denials; the hub knows it asked
    assert seen[-1].get("interrupted") is True and "error" not in seen[-1]


async def test_a_pending_request_is_not_a_timeout(tmp_path):
    """The person may take a while: the turn's time limit does not run while a request waits for them."""
    ctl = Control()
    seen = []
    async for ev in backend(tmp_path, "ask", timeout_s=0.6).run(request(tmp_path, ctl)):
        seen.append(ev)
        if ev["t"] == "request":
            await asyncio.sleep(1.0)
            ctl.send(cl.answer_response(ev["id"], ev["input"], {"Which fruit?": "Apple"}))
    assert seen[-1]["t"] == "result" and "error" not in seen[-1], seen[-1]


def test_a_question_call_in_the_log_carries_its_question_as_the_input():
    """The workstation's "等你：…" reads the wait's input: the question, not the JSON of the call."""
    st = cl.State(root="/work/proj") if hasattr(cl, "State") else None
    rec = {"type": "assistant", "timestamp": "2026-09-29T06:00:00.000Z", "uuid": "u1", "message": {"id": "m1", "role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "AskUserQuestion", "input": QUESTION}]}}
    items, _ = cl.project(rec, st)
    tool = next(i for i in items if i["kind"] == "tool")["tool"]
    assert tool["input"] == "Which fruit?" and tool["waitsUser"] is True


async def test_a_cli_that_exits_1_after_an_interrupt_is_still_a_clean_stop(tmp_path):
    """Interrupting a running tool ends the real CLI with exit code 1 after its result: not a failure of the turn."""
    ctl = Control()
    env = {"FAKE_DUPLEX_MODE": "hang", "FAKE_DUPLEX_LOG": str(tmp_path / "stdin.log"), "FAKE_DUPLEX_EXIT_AFTER_INTERRUPT": "1"}
    seen = []
    async for ev in ClaudeCodeBackend([sys.executable, str(FAKE)], env=env).run(request(tmp_path, ctl)):
        seen.append(ev)
        if ev["t"] == "tool_use":
            ctl.send(cl.interrupt_request("i-1"))
    assert seen[-1]["t"] == "result" and seen[-1].get("interrupted") is True and "error" not in seen[-1], seen[-1]
