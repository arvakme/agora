"""The server leaves when it is told to, also with a page open (SD1). uvicorn waits for open connections before it
lets the app clean up, and an event stream never closes by itself: SIGTERM stopped the listener and then waited
for the browser for ever (a second SIGTERM did not change that; measured on the user's preview backend). Now the
first signal ends the streams from the server's side, and every step of shutting down has an upper limit."""

import asyncio
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from server.canvas import shutdown
from server.canvas.project import ProjectStore

REPO = Path(__file__).resolve().parents[1]


# ——— each step of shutting down has a limit (pure) ———
async def test_bounded_returns_the_value_when_the_step_finishes():
    async def step():
        return 7

    assert await shutdown.bounded(step(), 1.0, "step") == 7


async def test_bounded_gives_up_on_a_step_that_hangs_and_says_which(capsys):
    async def hangs():
        await asyncio.sleep(60)

    t = time.time()
    assert await shutdown.bounded(hangs(), 0.2, "shares.shutdown", default="gave up") == "gave up"
    assert time.time() - t < 2
    assert "shares.shutdown" in capsys.readouterr().out


async def test_bounded_gives_up_on_a_thread_that_never_returns():
    t = time.time()
    done = threading.Event()
    await shutdown.bounded(asyncio.to_thread(done.wait, 30), 0.2, "blocking call")
    assert time.time() - t < 2
    done.set()


async def test_bounded_swallows_a_failing_step_and_carries_on(capsys):
    async def fails():
        raise RuntimeError("boom")

    assert await shutdown.bounded(fails(), 1.0, "x", default=None) is None
    assert "boom" in capsys.readouterr().out


# ——— streams are ended by the server (ASGI) ———
def sse_app(chunks):
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/event-stream")]})
        try:
            for c in chunks:
                await send({"type": "http.response.body", "body": c, "more_body": True})
            await asyncio.sleep(3600)  # an event stream that never ends by itself
        finally:
            app.cleaned = True
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    app.cleaned = False
    return app


async def call(app, path="/"):
    sent: list[dict] = []

    async def send(m):
        sent.append(m)

    async def receive():
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    task = asyncio.create_task(app({"type": "http", "method": "GET", "path": path, "headers": []}, receive, send))
    return task, sent


@pytest.fixture(autouse=True)
def _fresh_state():
    shutdown.reset()
    yield
    shutdown.reset()


async def test_an_open_event_stream_is_ended_when_the_server_is_told_to_stop():
    inner = sse_app([b"data: hello\n\n"])
    task, sent = await call(shutdown.CloseStreamsOnShutdown(inner))
    await asyncio.sleep(0.1)
    assert not task.done()
    shutdown.trigger()
    await asyncio.wait_for(task, 2)
    assert inner.cleaned  # the handler's own clean-up ran (it unsubscribes)
    assert sent[-1] == {"type": "http.response.body", "body": b"", "more_body": False}  # the response ends properly


async def test_an_ordinary_request_in_flight_is_left_to_finish():
    async def slow(scope, receive, send):
        await asyncio.sleep(0.3)
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b"{}", "more_body": False})

    task, sent = await call(shutdown.CloseStreamsOnShutdown(slow))
    await asyncio.sleep(0.05)
    shutdown.trigger()
    await asyncio.wait_for(task, 2)
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"] and sent[-1]["body"] == b"{}"


async def test_a_stream_opened_after_the_stop_was_asked_for_is_ended_at_once():
    shutdown.trigger()
    inner = sse_app([b"data: late\n\n"])
    task, sent = await call(shutdown.CloseStreamsOnShutdown(inner))
    await asyncio.wait_for(task, 2)
    assert inner.cleaned and sent[-1]["more_body"] is False


def test_a_second_signal_stops_waiting_altogether():
    import uvicorn

    server = shutdown.AgoraServer(uvicorn.Config(lambda *a: None, port=1))
    server.handle_exit(signal.SIGTERM, None)
    assert server.should_exit and not server.force_exit
    server.handle_exit(signal.SIGTERM, None)
    assert server.force_exit


# ——— a real server with pages connected ———
def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(tmp_path) -> tuple[subprocess.Popen, int]:
    proj = tmp_path / "proj"
    ProjectStore(proj).init()
    port = free_port()
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = {**os.environ, "HOME": str(home), "AGORA_STATE_DIR": str(tmp_path / "state")}
    p = subprocess.Popen([sys.executable, "-m", "agora_cli", "serve", "--project", str(proj), "--port", str(port)], cwd=REPO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(100):
        try:
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            c.request("GET", "/api/agent/adapters")
            if c.getresponse().status == 200:
                return p, port
        except OSError:
            time.sleep(0.2)
    p.kill()
    raise AssertionError("the server did not start")


class Pages:
    """What two open Agora tabs hold: an agent event stream (an executor) and the project event stream."""

    def __init__(self, port: int) -> None:
        self.conns = []
        for path in ("/api/agent/events?executor=2", "/api/project/events"):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", path)
            r = c.getresponse()
            assert r.status == 200
            r.fp.readline()  # the first line: the stream is live
            self.conns.append((c, r))

    def ended(self, timeout: float) -> bool:
        """Whether the server closed every stream (a read returns b'' at the end of the body)."""
        end = time.time() + timeout
        for c, r in self.conns:
            c.sock.settimeout(max(end - time.time(), 0.1))
            try:
                while r.fp.readline():
                    pass
            except (OSError, ValueError):
                return False
        return True

    def close(self) -> None:
        for c, _ in self.conns:
            c.close()


def test_a_server_with_pages_open_exits_on_the_first_sigterm(tmp_path):
    p, port = start_server(tmp_path)
    pages = Pages(port)
    try:
        t = time.time()
        os.killpg(p.pid, signal.SIGTERM)
        rc = p.wait(timeout=15)
        took = time.time() - t
        assert took < 8, f"took {took:.1f}s"
        assert rc != -signal.SIGKILL
        assert pages.ended(2)  # the streams were closed from the server's side
    finally:
        pages.close()
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGKILL)


def test_agora_down_gets_a_clean_exit_with_pages_open_not_a_sigkill(tmp_path):
    from agora_cli.main import stop

    p, port = start_server(tmp_path)
    pages = Pages(port)
    try:
        t = time.time()
        stop(p.pid, timeout=8.0)  # what `agora down` does: SIGTERM, and SIGKILL only after the wait
        rc = p.wait(timeout=2)
        assert time.time() - t < 8 and rc != -signal.SIGKILL
    finally:
        pages.close()
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGKILL)
