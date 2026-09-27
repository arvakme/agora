"""server.canvas.runner tests — the fake `claude` CLI stands in for stream-json output."""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest

from server.canvas.runner import (
    NEW_SESSION,
    ClaudeCliBackend,
    ExecOptions,
    RunRequest,
    build_prompt,
    make_backend,
)

FAKE = [sys.executable, str(Path(__file__).parent / "fake_claude_cli.py")]
# Small inline schema keeps the runner tests independent of generated/ artifacts.
PLAN_SCHEMA = {
    "type": "object",
    "required": ["ops"],
    "properties": {"ops": {"type": "array"}},
}


def req(prompt: str = "prompt", **opts) -> RunRequest:
    return RunRequest(schema=PLAN_SCHEMA, system="sys", prompt=prompt, options=ExecOptions(**opts))


async def drain(env: dict[str, str] | None = None, request: RunRequest | None = None, **kwargs):
    backend = ClaudeCliBackend(list(FAKE), env=env, **kwargs)
    return [ev async for ev in backend.run(request or req())]


def result_of(events):
    assert events[-1]["t"] == "result"
    return events[-1]


async def test_successful_run_streams_then_results():
    events = await drain()
    assert events[0]["t"] == "start"
    types = [e["t"] for e in events]
    assert types == ["start", "text", "usage", "output", "result"]
    assert events[0]["backend"] == "claude-cli" and events[0]["model"] == "claude-sonnet-5"
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
    backend = ClaudeCliBackend(["/definitely/not/a/claude"])
    events = [ev async for ev in backend.run(req("p"))]
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
    backend = ClaudeCliBackend(
        list(FAKE), env={"FAKE_CLAUDE_MODE": "nostdin"}, timeout_s=0.5
    )
    events = [ev async for ev in backend.run(req("p" * 2_000_000))]
    assert result_of(events)["error"].startswith("timeout")


async def test_task_cancellation_escalates_to_sigkill(tmp_path, monkeypatch):
    # ASGI disconnect cancels the runner task; a SIGTERM-ignoring child must die.
    monkeypatch.setattr("server.canvas.runner.KILL_GRACE_S", 0.2)
    pidfile = tmp_path / "pid"
    backend = ClaudeCliBackend(
        list(FAKE),
        env={"FAKE_CLAUDE_MODE": "ignore_term", "FAKE_CLAUDE_PIDFILE": str(pidfile)},
        timeout_s=60,
    )

    async def consume():
        async for _ in backend.run(req("p")):
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
    backend = ClaudeCliBackend(
        list(FAKE), env={"FAKE_CLAUDE_MODE": "hang", "FAKE_CLAUDE_PIDFILE": str(pidfile)}
    )
    agen = backend.run(req("p"))
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


async def test_usage_is_kept_not_dropped():
    events = await drain()
    per_message = next(e for e in events if e["t"] == "usage")["usage"]
    assert per_message["model"] == "claude-sonnet-5"
    assert per_message["inputTokens"] == 400 and per_message["outputTokens"] == 20
    usage = result_of(events)["usage"]
    assert usage == {
        "model": "claude-sonnet-5",
        "inputTokens": 1200,
        "outputTokens": 80,
        "cacheReadTokens": 900,
        "cacheWriteTokens": 300,
        "durationMs": result_of(events)["durationMs"],
        "costUsd": pytest.approx(0.012),
    }
    # Error results still carry whatever usage the backend reported.
    err = result_of(await drain(env={"FAKE_CLAUDE_MODE": "claude_error"}))
    assert err["usage"]["costUsd"] == pytest.approx(0.01)
    assert err["usage"]["inputTokens"] is None


async def test_child_runs_in_a_neutral_empty_workdir(tmp_path):
    # Regression (T1 "already named Redis"): claude -p folds its cwd — git status,
    # recent commits, project memory — into the model context. The planner must not
    # inherit the server's cwd (the repo root).
    probe = tmp_path / "probe.json"
    events = await drain(env={"FAKE_CLAUDE_PROBEFILE": str(probe)})
    assert "error" not in result_of(events)
    cwd = Path(json.loads(probe.read_text())["cwd"]).resolve()
    assert cwd != Path.cwd().resolve()
    assert not any((p / ".git").exists() for p in [cwd, *cwd.parents])
    assert list(cwd.iterdir()) == []


async def test_exec_options_map_onto_cli_flags(tmp_path):
    probe = tmp_path / "probe.json"
    env = {"FAKE_CLAUDE_PROBEFILE": str(probe)}

    await drain(env=env)
    argv = json.loads(probe.read_text())["argv"]
    assert argv[argv.index("--model") + 1] == "claude-sonnet-5"
    assert "--no-session-persistence" in argv and "--effort" not in argv and "--resume" not in argv

    events = await drain(env=env, request=req(model="claude-opus-5", effort="low", session=NEW_SESSION))
    argv = json.loads(probe.read_text())["argv"]
    assert argv[argv.index("--model") + 1] == "claude-opus-5"
    assert argv[argv.index("--effort") + 1] == "low"
    assert "--no-session-persistence" not in argv and "--resume" not in argv
    assert result_of(events)["session"] == "fake-session"  # id to continue with

    await drain(env=env, request=req(session="abc-123"))
    argv = json.loads(probe.read_text())["argv"]
    assert argv[argv.index("--resume") + 1] == "abc-123"


def test_exec_options_from_env_and_registry():
    o = ExecOptions.from_env({"AGORA_CANVAS_MODEL": "claude-opus-5", "AGORA_CANVAS_EFFORT": "high"})
    assert (o.backend, o.model, o.effort, o.session) == ("claude-cli", "claude-opus-5", "high", None)
    assert ExecOptions.from_env({}) == ExecOptions()
    with pytest.raises(ValueError):
        ExecOptions.from_env({"AGORA_CANVAS_EFFORT": "huge"})
    assert make_backend("claude-cli").name == "claude-cli"
    assert make_backend("pi").name == "pi"  # the native session agents register on first use
    with pytest.raises(ValueError, match="unknown canvas backend"):
        make_backend("kimi")
