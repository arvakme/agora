"""server.canvas.router tests — a fake AgentBackend replaces `claude`, the real
Library serves catalog queries, and the SSE contract is asserted end to end."""

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from server.canvas.library import Library
from server.canvas.router import create_router
from server.canvas.runner import ClaudeCliBackend, ExecOptions

FAKE_CLI = [sys.executable, str(Path(__file__).parent / "fake_claude_cli.py")]

CTX = {
    "origin": "thread",
    "anchors": [{"id": "e1", "label": "缓存"}],
    "messages": [{"author": "u", "text": "换成 Redis"}],
    "selection": [],
    "scene": [],
}


class FakeBackend:
    """Yields a fixed event list; records the RunRequest for assertions."""

    name = "fake"

    def __init__(self, events):
        self.events = events
        self.req = None

    async def run(self, req):
        self.req = req
        for ev in self.events:
            yield ev


def app_with(backend, library=None, options=None) -> FastAPI:
    app = FastAPI()
    app.include_router(
        create_router(backend=backend, options=options or ExecOptions(), library=library or Library()),
        prefix="/api/canvas",
    )
    return app


def sse_frames(body: str) -> list[dict]:
    return [json.loads(frame[5:]) for frame in body.split("\n\n") if frame.startswith("data:")]


async def test_turns_stream_sse_events():
    runner = FakeBackend(
        [
            {"t": "start", "at": 1},
            {"t": "text", "at": 2, "text": "thinking"},
            {"t": "result", "at": 3, "raw": {"ops": []}, "costUsd": 0.01, "durationMs": 2, "prompt": "p"},
        ]
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(runner)), base_url="http://t"
    ) as client:
        resp = await client.post("/api/canvas/turns", json=CTX)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = sse_frames(resp.text)
    assert [e["t"] for e in events] == ["start", "text", "result"]
    assert events[-1]["raw"] == {"ops": []}
    # The backend was handed the plan schema, system prompt and library MCP config.
    assert runner.req.schema["type"] == "object"
    assert "library" in runner.req.mcp_config["mcpServers"]
    assert 'e1 "缓存"' in runner.req.prompt


async def test_turns_accept_json_returns_result_object():
    runner = FakeBackend([{"t": "result", "at": 1, "raw": {"ops": []}, "costUsd": None, "durationMs": 1, "prompt": "p"}])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(runner)), base_url="http://t"
    ) as client:
        resp = await client.post("/api/canvas/turns", json=CTX, headers={"accept": "application/json"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["raw"] == {"ops": []}
    assert "t" not in body


async def test_turns_error_event_is_explicit_not_empty():
    # Contract: an unavailable/failed `claude` surfaces an error result event —
    # never a silently empty ops list.
    runner = FakeBackend([{"t": "result", "at": 1, "raw": None, "error": "spawn: claude not found"}])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(runner)), base_url="http://t"
    ) as client:
        resp = await client.post("/api/canvas/turns", json=CTX)
    events = sse_frames(resp.text)
    assert events[-1]["t"] == "result"
    assert events[-1]["error"].startswith("spawn:")


async def test_sse_disconnect_kills_sigterm_ignoring_child(tmp_path, monkeypatch):
    # Real ASGI disconnect cancels the streaming generator; even a child that
    # ignores SIGTERM must be dead after the kill grace.
    monkeypatch.setattr("server.canvas.runner.KILL_GRACE_S", 0.2)
    pidfile = tmp_path / "pid"
    runner = ClaudeCliBackend(
        list(FAKE_CLI),
        env={"FAKE_CLAUDE_MODE": "ignore_term", "FAKE_CLAUDE_PIDFILE": str(pidfile)},
        timeout_s=60,
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(runner)), base_url="http://t"
    ) as client:
        async with client.stream("POST", "/api/canvas/turns", json=CTX) as resp:
            assert resp.status_code == 200
            async for line in resp.aiter_lines():
                if line.startswith("data:"):
                    break  # saw the first frame → drop the connection
        for _ in range(100):
            if pidfile.exists() and pidfile.read_text():
                break
            await asyncio.sleep(0.05)
        pid = int(pidfile.read_text())
        for _ in range(200):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            await asyncio.sleep(0.05)
    pytest.fail("claude child survived SSE disconnect")


async def test_anim_returns_script_and_usage():
    usage = {"model": "m", "inputTokens": 1, "outputTokens": 2, "cacheReadTokens": 0, "cacheWriteTokens": 0, "durationMs": 5, "costUsd": 0.1}
    script = {"title": "t", "w": 1, "h": 1, "nodes": [], "steps": []}
    runner = FakeBackend([{"t": "result", "at": 1, "raw": script, "costUsd": 0.1, "durationMs": 5, "usage": usage}])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(runner)), base_url="http://t"
    ) as client:
        resp = await client.post("/api/canvas/anim", json={"request": "冒泡排序"})
    body = resp.json()
    assert body["raw"] == script
    assert body["usage"] == usage
    assert "engine" not in body
    assert "title" in runner.req.schema["properties"]


async def test_exec_options_reach_the_backend():
    runner = FakeBackend([{"t": "result", "at": 1, "raw": {"ops": []}}])
    opts = ExecOptions(model="claude-opus-5", effort="low")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(runner, options=opts)), base_url="http://t"
    ) as client:
        await client.post("/api/canvas/turns", json=CTX)
    assert runner.req.options == opts


async def test_turns_sse_carries_usage():
    usage = {"model": "m", "inputTokens": 10, "outputTokens": 2, "cacheReadTokens": 8, "cacheWriteTokens": 0, "durationMs": 3, "costUsd": 0.01}
    runner = FakeBackend(
        [
            {"t": "start", "at": 1, "backend": "fake", "model": "m"},
            {"t": "usage", "at": 2, "usage": usage},
            {"t": "result", "at": 3, "raw": {"ops": []}, "costUsd": 0.01, "durationMs": 2, "usage": usage},
        ]
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(runner)), base_url="http://t"
    ) as client:
        resp = await client.post("/api/canvas/turns", json=CTX)
    events = sse_frames(resp.text)
    assert events[1] == {"t": "usage", "at": 2, "usage": usage}
    assert events[-1]["usage"] == usage


async def test_anim_appends_validation_errors_to_prompt():
    runner = FakeBackend([{"t": "result", "at": 1, "raw": {"title": "t", "w": 1, "h": 1, "nodes": [], "steps": []}}])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(runner)), base_url="http://t"
    ) as client:
        resp = await client.post("/api/canvas/anim", json={"request": "bfs", "errors": ["step 2 dup"]})
    assert resp.status_code == 200
    assert "step 2 dup" in runner.req.prompt


async def test_library_routes_against_real_catalog():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app_with(FakeBackend([]))), base_url="http://t"
    ) as client:
        search = await client.get("/api/canvas/library/search", params={"q": "redis"})
        assert search.status_code == 200
        items = search.json()["items"]
        assert items
        detail = await client.get("/api/canvas/library/item", params={"id": items[0]["id"]})
        assert detail.json()["id"] == items[0]["id"]
        assert isinstance(detail.json()["elements"], list)
        libs = await client.get("/api/canvas/library/libs")
        assert libs.json()["libraries"]
        missing = await client.get("/api/canvas/library/item", params={"id": "nope:x"})
        assert missing.status_code == 404
