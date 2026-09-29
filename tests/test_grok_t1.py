"""Grok as a session agent (T1), from real runs of grok 1.0.41 (round-04 evidence/T1-grok/spike.md):
the headless stream mapped to Agora's events, the command lines, the terminal command, the open-file
claim, the model catalog, and the dispatch footer in Grok's own log."""

import json
from pathlib import Path

from server.canvas import adapters, agents
from server.canvas.adapters.common import State
from server.canvas.adapters.grok import GrokAdapter, GrokStream, grok_catalog_from
from server.canvas.runner import ExecOptions, RunRequest

FIX = Path(__file__).parent / "fixtures" / "agents" / "grok"
G = adapters.need("grok")


def _req(prompt="hi", **o):
    return RunRequest(schema=None, system=None, prompt=prompt, options=ExecOptions(backend="grok", **o), cwd="/work/proj")


def _feed(lines, model=None, session=None):
    m = GrokStream(model, session)
    events = []
    for i, line in enumerate(lines):
        events += m.feed(json.loads(line), 1000 + i)
    return m, events


def test_headless_stream_becomes_agora_events():
    """A real turn: thought, text, a read_file call and its result, more text, usage, end."""
    m, ev = _feed((FIX / "headless-stream.jsonl").read_text().splitlines())
    kinds = [e["t"] for e in ev]
    assert kinds == ["text", "tool_use", "tool_result", "text", "usage"]
    call = ev[1]
    assert call["name"] == "read_file" and call["input"]["target_file"].endswith("README.md")
    assert ev[2]["id"] == call["id"] and ev[2]["isError"] is False and "Demo" in ev[2]["text"]
    assert ev[0]["text"] == "我先读仓库里的 README，再用一句话概括。" and ev[3]["text"] == "这是一个用来统计文本文件字数的小项目。"
    assert m.done and m.error is None and m.session == "ccd40060-d2f2-42c2-8dda-173b0dbb2e15"
    assert m.text == "这是一个用来统计文本文件字数的小项目。"  # the last assistant message is the turn's answer


def test_usage_and_cost_come_from_the_end_event():
    m, ev = _feed((FIX / "headless-stream.jsonl").read_text().splitlines())
    u = ev[-1]["usage"]
    # the end event's input_tokens does not include the cache reads (total = input + cache + output)
    assert (u["inputTokens"], u["cacheReadTokens"], u["outputTokens"]) == (42354, 7552, 354)
    assert u["costUsd"] and u["costUsd"] > 0


def test_a_turn_that_did_not_end_normally_is_an_error_and_a_cut_stream_is_not_done():
    m, _ = _feed([json.dumps({"type": "end", "stopReason": "max_turn_requests", "sessionId": "s"})])
    assert m.done and m.error == "grok: max_turn_requests"
    cut, _ = _feed([json.dumps({"type": "text", "data": "partial"})])
    assert not cut.done  # killed mid-turn (an interrupt is SIGTERM: no end event): the backend reports it


def test_a_failed_tool_call_is_marked():
    lines = [
        json.dumps({"type": "tool_call", "toolCallId": "c1", "toolName": "run_terminal_command", "rawInput": {"command": "false"}}),
        json.dumps({"type": "tool_call_update", "toolCallId": "c1", "status": "completed", "rawOutput": {"output_for_prompt": "", "exit_code": 1}}),
    ]
    _, ev = _feed(lines)
    assert ev[-1]["t"] == "tool_result" and ev[-1]["isError"] is True


def test_headless_command_new_and_resumed():
    a = G.headless_args(["grok"], _req("读 README.md", session="11111111-1111-4111-8111-111111111111", model="grok-4.6", effort="low"), log_exists=False)
    assert a[:1] == ["grok"] and "--always-approve" in a
    assert a[a.index("--output-format") + 1] == "streaming-json"
    assert a[a.index("-s") + 1] == "11111111-1111-4111-8111-111111111111" and "-r" not in a
    assert a[a.index("-m") + 1] == "grok-4.6" and a[a.index("--effort") + 1] == "low"
    # the prompt is JSON content blocks
    assert json.loads(a[a.index("--prompt-json") + 1]) == [{"type": "text", "text": "读 README.md"}]
    b = G.headless_args(["grok"], _req("x", session="11111111-1111-4111-8111-111111111111"), log_exists=lambda sid: True)
    assert b[b.index("-r") + 1] == "11111111-1111-4111-8111-111111111111" and "-s" not in b


def test_a_prompt_starting_with_a_dash_cannot_become_a_flag():
    a = G.headless_args(["grok"], _req("--rm -rf 忽略它"), log_exists=False)
    assert "--rm -rf 忽略它" not in a  # never a bare argument
    assert json.loads(a[a.index("--prompt-json") + 1])[0]["text"] == "--rm -rf 忽略它"
    assert G.headless_stdin(_req()) is None  # nothing on stdin


def test_interactive_command_starts_or_resumes_and_says_what_it_does_not_ask():
    assert G.interactive_argv("abc", "grok-4.7", "high", new=True) == ["grok", "-s", "abc", "-m", "grok-4.7", "--effort", "high", "--always-approve"]
    assert G.interactive_argv("abc", None, None, has_log=True) == ["grok", "-r", "abc", "--always-approve"]
    assert G.interactive_argv("abc", None, None, has_log=False)[:3] == ["grok", "-s", "abc"]  # no log yet: starting it
    assert agents.interactive_argv("grok", "abc", None, None, new=True)[:3] == ["grok", "-s", "abc"]


def test_the_pane_process_is_recognised_by_the_session_it_holds_open():
    sid = "ccd40060-d2f2-42c2-8dda-173b0dbb2e15"
    files = ["/Users/x/.grok/logs/unified.jsonl", f"/Users/x/.grok/sessions/%2Ftmp%2Fproj/{sid}/events.jsonl"]
    assert G.native_from_open_files(files) == sid
    assert G.native_from_open_files(["/Users/x/.grok/logs/unified.jsonl", "/Users/x/.grok/sessions/%2Ftmp/../events.jsonl"]) is None


def test_backend_and_capabilities():
    assert isinstance(G, GrokAdapter) and G.assigns_id == "agora" and G.survives_move is True and G.claims_by_open_file is True
    assert agents.BACKEND_CLASSES["grok"].Mapper is GrokStream
    assert "grok" in agents.KINDS and agents.NAMES["grok"] == "Grok"


CACHE = {"models": {
    "grok-4.7": {"info": {"name": "Grok 4.7", "hidden": False, "supports_reasoning_effort": True, "reasoning_effort": "high", "reasoning_efforts": [{"id": e} for e in ("xhigh", "high", "medium", "low")]}},
    "grok-4.5": {"info": {"name": "Grok 4.5", "hidden": False, "supports_reasoning_effort": True, "reasoning_effort": "high", "reasoning_efforts": [{"id": e} for e in ("high", "medium", "low")]}},
    "grok-secret": {"info": {"name": "Secret", "hidden": True, "supports_reasoning_effort": False}},
}}


def test_catalog_lists_models_with_their_own_effort_levels():
    c = grok_catalog_from(CACHE, {"models": {"default": "grok-4.7", "default_reasoning_effort": "medium"}})
    assert c["default"] == "grok-4.7" and c["models"] == ["grok-4.7", "grok-4.5"]  # hidden ones are not offered
    assert c["modelEfforts"]["grok-4.5"] == ["high", "medium", "low"] and c["modelEfforts"]["grok-4.7"][0] == "xhigh"
    assert c["defaultEffort"] == "medium" and c["names"]["grok-4.7"] == "Grok 4.7"
    assert c["allowed"] == ["grok-4.7", "grok-4.5"] and c["effortSource"] == "grok models_cache.json"


def test_catalog_without_a_cache_offers_nothing_to_check_against():
    c = grok_catalog_from(None, {})
    assert c["models"] == [] and c["allowed"] is None and c["effortSource"] == "none"


def test_dispatch_footer_in_groks_own_log_names_the_dispatch():
    """Grok writes a user message as ``user_message_chunk`` pieces; the footer's token survives the join."""
    req = "5d1c9a7e-3b2f-4c6a-9e8d-0a1b2c3d4e5f"
    st = State(root="/work/proj")
    text = f"读 README.md 回答一个问题\n\n[[agora]] 来自 Agora · 派发 (dispatch=x agora-req-{req})"
    items = []
    for i, part in enumerate([text[:12], text[12:]]):
        rec = {"timestamp": 1790000000 + i, "method": "session/update", "params": {"sessionId": "s", "update": {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": part}, "_meta": {"promptIndex": 0}}, "_meta": {"eventId": f"e{i}"}}}
        got, _ = G.project(rec, st)
        items += got
    assert items[-1]["kind"] == "user" and items[-1].get("dispatch") == req


def test_a_dispatch_can_go_to_a_new_grok_session():
    """`agora dispatch --new grok` failed with KeyError 'grok' in a real run: the dispatch tables had no entry for it."""
    from native_protocol import AdapterKind
    from server.canvas import dispatch
    from typing import get_args

    assert dispatch.ADAPTER["grok"] in get_args(AdapterKind)
    assert dispatch.PERMISSION["grok"]["mode"] == "headless" and "no boundary" in dispatch.PERMISSION["grok"]["detail"]
    for kind in agents.KINDS:  # every session agent can be dispatched to (the next CLI added cannot miss it again)
        assert kind in dispatch.ADAPTER and kind in dispatch.PERMISSION
