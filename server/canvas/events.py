"""In-process pub/sub for server-sent events. ``publish`` is safe from any thread (sync route
handlers run in a thread pool); each subscriber owns an asyncio queue on its own loop."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass(eq=False)
class Sub:
    q: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    accept: Callable[[dict[str, Any]], bool] = field(default=lambda _ev: True)


class Events:
    def __init__(self, maxsize: int = 256) -> None:
        self._subs: set[Sub] = set()
        self._lock = threading.Lock()
        self._maxsize = maxsize

    def subscribe(self, accept: Callable[[dict[str, Any]], bool] | None = None) -> Sub:
        sub = Sub(asyncio.Queue(self._maxsize), asyncio.get_running_loop(), accept or (lambda _ev: True))
        with self._lock:
            self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Sub) -> None:
        with self._lock:
            self._subs.discard(sub)

    def count(self) -> int:
        with self._lock:
            return len(self._subs)

    def publish(self, ev: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs)
        for sub in subs:
            if not sub.accept(ev):
                continue

            def put(sub: Sub = sub) -> None:
                try:
                    sub.q.put_nowait(ev)
                except asyncio.QueueFull:  # a stuck reader loses events rather than memory
                    pass

            try:
                sub.loop.call_soon_threadsafe(put)
            except RuntimeError:  # loop closed
                self.unsubscribe(sub)
