"""Leaving promptly when the server is told to (SD1).

uvicorn closes its listener on SIGTERM and then waits for every open connection before the app may clean up — and
an event stream (a page's ``/api/agent/events``) never closes by itself, so a server with a page open waited for
the browser for ever, whatever the second signal. So:

- the first SIGTERM/SIGINT ``trigger()``s the stop: open ``text/event-stream`` responses are ended from the server's
  side (``CloseStreamsOnShutdown``: the handler is cancelled, so its own clean-up runs, then the body is closed);
  ordinary requests in flight finish; streams that open later are ended at once;
- a second signal stops all waiting (``AgoraServer.handle_exit``), and uvicorn cancels what is left after
  ``GRACE_S`` (``timeout_graceful_shutdown``);
- every step of the app's own clean-up has a limit (``bounded``), and a watchdog ends the process ``HARD_EXIT_S`` after
  the stop was asked for, whatever is still hanging (a blocked thread, an executor that does not join).
"""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import Awaitable, Callable
from contextlib import contextmanager
from typing import Any

GRACE_S = 4  # uvicorn cancels the connections still open after this
HARD_EXIT_S = 20.0  # the process is ended this long after the stop was asked for, if it is still there

_lock = threading.Lock()
_state: dict[str, Any] = {"stopping": False, "loop": None, "event": None, "callbacks": [], "watchdog": None}


def reset() -> None:
    """Forget a stop (tests)."""
    with _lock:
        w = _state["watchdog"]
        if w is not None:
            w.cancel()
        _state.update(stopping=False, loop=None, event=None, callbacks=[], watchdog=None)


def stopping() -> bool:
    return bool(_state["stopping"])


def on_stop(fn: Callable[[], None]) -> None:
    """Run ``fn`` when the stop is asked for (the share gateway's own server is stopped this way)."""
    _state["callbacks"].append(fn)


def _event() -> asyncio.Event:
    """The stop event of the running loop (created on first use; ``trigger`` sets it from any thread or a signal handler)."""
    loop = asyncio.get_running_loop()
    with _lock:
        if _state["event"] is None or _state["loop"] is not loop:
            ev = asyncio.Event()
            if _state["stopping"]:
                ev.set()
            _state["event"], _state["loop"] = ev, loop
        return _state["event"]


def _hard_exit() -> None:  # pragma: no cover - the process ends
    print(f"agora: still running {HARD_EXIT_S:.0f}s after the stop was asked for: exiting", flush=True)
    os._exit(1)


def trigger() -> None:
    """The server was told to stop: end the event streams, stop what registered, start the watchdog. Safe from a signal handler."""
    with _lock:
        first = not _state["stopping"]
        _state["stopping"] = True
        loop, ev = _state["loop"], _state["event"]
        if first and _state["watchdog"] is None:
            w = threading.Timer(HARD_EXIT_S, _hard_exit)
            w.daemon = True
            w.start()
            _state["watchdog"] = w
    if loop is not None and ev is not None:
        try:
            loop.call_soon_threadsafe(ev.set)
        except RuntimeError:  # the loop is closed: nothing left to end
            pass
    if first:
        for fn in list(_state["callbacks"]):
            try:
                fn()
            except Exception as e:  # keep stopping
                print(f"agora: stop callback failed: {e}", flush=True)


async def bounded(step: Awaitable[Any], seconds: float, what: str, default: Any = None) -> Any:
    """One step of the clean-up, given at most ``seconds``: what it returns, or ``default`` when it hangs or fails
    (said on stdout, never raised — the rest of the shutdown must still happen)."""
    fut = asyncio.ensure_future(step)
    try:
        done, _ = await asyncio.wait({fut}, timeout=seconds)
        if done:
            return fut.result()
        print(f"agora: shutdown step '{what}' took longer than {seconds:.0f}s: not waiting for it", flush=True)
        return default
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"agora: shutdown step '{what}' failed: {e}", flush=True)
        return default
    finally:
        if not fut.done():
            fut.cancel()


class CloseStreamsOnShutdown:
    """ASGI middleware: when the stop is asked for, end every ``text/event-stream`` response — cancel its handler (its
    ``finally`` unsubscribes) and close the body. Other requests are not touched."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        stop = _event()
        streaming = asyncio.Event()

        async def wrapped(message: dict) -> None:
            if message["type"] == "http.response.start" and any(k.lower() == b"content-type" and v.startswith(b"text/event-stream") for k, v in message.get("headers", [])):
                streaming.set()
            await send(message)

        app_task = asyncio.ensure_future(self.app(scope, receive, wrapped))
        stop_task = asyncio.ensure_future(stop.wait())
        opened = asyncio.ensure_future(streaming.wait())
        try:
            await asyncio.wait({app_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
            if not app_task.done():  # asked to stop while the request is running
                if not streaming.is_set():  # an ordinary request: let it finish, unless it turns into a stream
                    await asyncio.wait({app_task, opened}, return_when=asyncio.FIRST_COMPLETED)
                if not app_task.done():
                    app_task.cancel()
                    await asyncio.gather(app_task, return_exceptions=True)
                    try:
                        await send({"type": "http.response.body", "body": b"", "more_body": False})
                    except Exception:  # the client is gone already
                        pass
                    return
            app_task.result()
        finally:
            for t in (app_task, stop_task, opened):
                if not t.done():
                    t.cancel()


def _uvicorn():
    import uvicorn

    return uvicorn


def _servers():
    uvicorn = _uvicorn()

    class AgoraServer(uvicorn.Server):
        """The main server: the first signal ends the event streams, a second stops all waiting."""

        def handle_exit(self, sig: int, frame: Any) -> None:
            again = self.should_exit
            trigger()
            super().handle_exit(sig, frame)
            if again:
                self.force_exit = True

    class GatewayServer(uvicorn.Server):
        """The share gateway inside the app: it must not take the process's signals from the main server."""

        @contextmanager
        def capture_signals(self):
            yield

    return AgoraServer, GatewayServer


def __getattr__(name: str) -> Any:  # AgoraServer / GatewayServer are built on first use (uvicorn is imported lazily)
    if name in ("AgoraServer", "GatewayServer"):
        a, g = _servers()
        globals()["AgoraServer"], globals()["GatewayServer"] = a, g
        return globals()[name]
    raise AttributeError(name)
