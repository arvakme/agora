"""server.canvas.runner tests — the fake `claude` CLI stands in for stream-json output."""

import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

from server.canvas.runner import ClaudeCliRunner, build_prompt

FAKE = [sys.executable, str(Path(__file__).parent / "fake_claude_cli.py")]
# Small inline schema keeps the runner tests independent of generated/ artifacts.
PLAN_SCHEMA = {
    "type": "object",
    "required": ["ops"],
    "properties": {"ops": {"type": "array"}},
}


async def drain(env: dict[str, str] | None = None, **kwargs):
    runner = ClaudeCliRunner(list(FAKE), env=env, **kwargs)
    return [
        ev
        async for ev in runner.run(schema=PLAN_SCHEMA, system="sys", prompt="prompt")
    ]


def result_of(events):
    assert events[-1]["t"] == "result"
    return events[-1]


async def test_successful_run_streams_then_results():
    events = await drain()
    assert events[0]["t"] == "start"
    types = [e["t"] for e in events]
    assert types == ["start", "text", "output", "result"]
    result = result_of(events)
    assert "error" not in result
    assert result["raw"] == {"ops": [], "note": "noop"}
    assert result["costUsd"] == pytest.approx(0.012)
    assert result["durationMs"] >= 0
    assert all("at" in e for e in events)


async def test_tool_use_and_result_events_pass_through():
    events = await drain(env={"FAKE_CLAUDE_MODE": "use_library"})
    tool_use = next(e for e in events if e["t"] == "tool_use")
    assert tool_use["name"] == "mcp__library__search_library"
    assert tool_use["input"] == {"query": "redis"}
    tool_result = next(e for e in events if e["t"] == "tool_result")
    assert tool_result["id"] == "t1"
    assert tool_result["text"] == '[{"id":"x"}]'
    # StructuredOutput bookkeeping is collapsed into a single `output` marker.
    assert "[structured" not in " ".join(e.get("text", "") for e in events)


async def test_schema_violation_is_an_error_result():
    result = result_of(await drain(env={"FAKE_CLAUDE_MODE": "bad_shape"}))
    assert result["error"].startswith("schema:")
    assert result["raw"] == {"oops": True}


async def test_claude_error_result_is_explicit():
    result = result_of(await drain(env={"FAKE_CLAUDE_MODE": "claude_error"}))
    assert result["error"].startswith("claude: error_max_turns")
    assert "hit the turn limit" in result["error"]


async def test_nonzero_exit_is_explicit():
    result = result_of(await drain(env={"FAKE_CLAUDE_MODE": "exit1"}))
    assert result["error"].startswith("exit 1")
    assert "boom" in result["error"]


async def test_missing_binary_is_explicit_spawn_failure():
    runner = ClaudeCliRunner(["/definitely/not/a/claude"])
    events = [ev async for ev in runner.run(schema=PLAN_SCHEMA, system="s", prompt="p")]
    result = result_of(events)
    assert result["error"].startswith("spawn:")


async def test_timeout_kills_child_and_reports():
    started = time.monotonic()
    events = await drain(env={"FAKE_CLAUDE_MODE": "hang"}, timeout_s=0.5)
    assert time.monotonic() - started < 30
    assert result_of(events)["error"].startswith("timeout")


async def test_long_stream_lines_survive():
    # stream-json assistant lines can exceed StreamReader's default 64 KiB.
    events = await drain(env={"FAKE_CLAUDE_MODE": "bigline"})
    assert max(len(e.get("text", "")) for e in events) == 200_000
    assert "error" not in result_of(events)


async def test_exit_nonzero_after_valid_final_is_an_error():
    result = result_of(await drain(env={"FAKE_CLAUDE_MODE": "exit_after_final"}))
    assert result["error"].startswith("exit 7")
    assert result["raw"] is not None  # final event kept for debugging


async def test_stdin_write_bounded_by_timeout():
    # A child that never reads stdin blocks drain(); the timeout must still fire.
    runner = ClaudeCliRunner(
        list(FAKE), env={"FAKE_CLAUDE_MODE": "nostdin"}, timeout_s=0.5
    )
    events = [
        ev
        async for ev in runner.run(
            schema=PLAN_SCHEMA, system="s", prompt="p" * 2_000_000
        )
    ]
    assert result_of(events)["error"].startswith("timeout")


async def test_task_cancellation_escalates_to_sigkill(tmp_path, monkeypatch):
    # ASGI disconnect cancels the runner task; a SIGTERM-ignoring child must die.
    monkeypatch.setattr("server.canvas.runner.KILL_GRACE_S", 0.2)
    pidfile = tmp_path / "pid"
    runner = ClaudeCliRunner(
        list(FAKE),
        env={"FAKE_CLAUDE_MODE": "ignore_term", "FAKE_CLAUDE_PIDFILE": str(pidfile)},
        timeout_s=60,
    )

    async def consume():
        async for _ in runner.run(schema=PLAN_SCHEMA, system="s", prompt="p"):
            pass

    task = asyncio.create_task(consume())
    for _ in range(100):
        if pidfile.exists() and pidfile.read_text():
            break
        await asyncio.sleep(0.05)
    pid = int(pidfile.read_text())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    for _ in range(100):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        await asyncio.sleep(0.05)
    pytest.fail("SIGTERM-ignoring child survived task cancellation")


async def test_closing_the_stream_kills_the_child(tmp_path):
    pidfile = tmp_path / "pid"
    runner = ClaudeCliRunner(
        list(FAKE), env={"FAKE_CLAUDE_MODE": "hang", "FAKE_CLAUDE_PIDFILE": str(pidfile)}
    )
    agen = runner.run(schema=PLAN_SCHEMA, system="s", prompt="p")
    assert (await agen.__anext__())["t"] == "start"
    await agen.__anext__()  # "text" — the child is spawned by the time this arrives
    for _ in range(50):  # wait until the child has written its pid
        if pidfile.exists() and pidfile.read_text():
            break
        await asyncio.sleep(0.05)
    pid = int(pidfile.read_text())
    await agen.aclose()  # client disconnect → generator close → child terminated
    for _ in range(100):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        await asyncio.sleep(0.05)
    pytest.fail("claude child survived stream close")


def test_build_prompt_thread_and_chat():
    ctx = {
        "origin": "thread",
        "anchors": [{"id": "e1", "label": "缓存"}],
        "messages": [{"author": "zhijie", "text": "把缓存换成 Redis"}],
        "selection": ["e1"],
        "scene": [{"id": "e1", "type": "node", "label": "缓存"}],
    }
    prompt = build_prompt(ctx)
    assert 'anchored to: e1 "缓存"' in prompt
    assert "zhijie: 把缓存换成 Redis" in prompt
    assert "Current selection: e1" in prompt
    chat = build_prompt({**ctx, "origin": "chat"})
    assert "Act on the LAST user message" in chat
