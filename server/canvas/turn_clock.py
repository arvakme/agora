"""When a turn has gone on too long: quiet for too long, or running past a fuse. One clock for both ways a turn runs
(``agents._CliBackend.run``, the one process per turn, and ``resident.ResidentBackend.run``, the long-lived one).

A turn is not stopped for taking long: an agent reading a lot, a model call of minutes, a command that works for an hour are
a turn that is going on. It is stopped when nothing has happened for ``idle_s`` (default 30 minutes,
``AGORA_TURN_IDLE_TIMEOUT_S``, 0 = never). What counts as something happening: a line of the CLI's output (stdout or stderr) —
``touch`` —, and, for a CLI that says little while it works (Pi, Codex headless), the native log growing — the ``probe``
(asked only when the clock is about to run out).
While a tool call is open (``tool_use`` without its ``tool_result``) a quiet spell may be ``TOOL_FACTOR`` times longer: the
command may simply print nothing. While the CLI waits for the person (``hold``) neither limit runs.

``max_s`` (default 6 hours, ``AGORA_TURN_MAX_S``, 0 = never) is the fuse for a turn that never goes quiet and never ends.
Stopping is the caller's (``TimeoutError`` out of ``guard``, then ``clock.message()`` says why); the native session stays as it
is, so "继续" resumes it."""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

IDLE_S = 30 * 60
MAX_S = 6 * 3600
TOOL_FACTOR = 4
MIN_WAKE_S = 0.05


def _env_s(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(0.0, value)


def span(seconds: float) -> str:
    """A length of time the way a person says it: ``30 分钟``, ``6 小时``, ``0.6 秒``."""
    if seconds >= 3600 and seconds % 3600 == 0:
        return f"{seconds / 3600:g} 小时"
    if seconds >= 60 and seconds % 60 == 0:
        return f"{seconds / 60:g} 分钟"
    if seconds >= 60:
        return f"{seconds / 60:.1f} 分钟"
    return f"{seconds:g} 秒"


class TurnClock:
    """One turn's clock. ``idle_s`` / ``max_s`` of ``None`` read the environment at the turn's start; 0 switches a limit off."""

    def __init__(self, idle_s: float | None = None, max_s: float | None = None, *, now: Callable[[], float] = time.monotonic) -> None:
        self.idle_s = _env_s("AGORA_TURN_IDLE_TIMEOUT_S", IDLE_S) if idle_s is None else idle_s
        self.max_s = _env_s("AGORA_TURN_MAX_S", MAX_S) if max_s is None else max_s
        self._now = now
        self._started = self._last = now()
        self._tools: set[str] = set()
        self._held_since: float | None = None
        self._held_total = 0.0
        self._nearer = asyncio.Event()  # set when a deadline the watcher sleeps towards may have moved nearer
        self.reason: str | None = None  # "idle" | "max": why ``guard`` stopped the turn
        self.limit_s = 0.0  # the limit that was exceeded

    # ——— what happens ———
    def touch(self) -> None:
        self._last = self._now()

    def observe(self, ev: dict[str, Any]) -> None:
        """A runner event of the turn: it is activity, and it opens or closes a tool call."""
        self.touch()
        kind = ev.get("t")
        if kind == "tool_use":
            self._tools.add(str(ev.get("id")))
        elif kind == "tool_result":
            self._tools.discard(str(ev.get("id")))
            self._nearer.set()  # the ×4 limit is over: the quiet spell that was allowed may now be long past

    def hold(self, on: bool) -> None:
        """The CLI waits for the person: the time is neither quiet nor the turn's."""
        if on and self._held_since is None:
            self._held_since = self._now()
        elif not on and self._held_since is not None:
            self._held_total += self._now() - self._held_since
            self._held_since = None
            self.touch()
            self._nearer.set()  # the watcher slept the wait's own length: the limits run again

    # ——— what it says ———
    def _idle_limit(self) -> float:
        return self.idle_s * TOOL_FACTOR if self._tools else self.idle_s

    def _elapsed(self) -> float:
        return self._now() - self._started - self._held_total

    def expired(self) -> str | None:
        """``"max"``, ``"idle"`` or None. Does not record anything (``guard`` does, once it stops the turn)."""
        if self._held_since is not None:
            return None
        if self.max_s and self._elapsed() >= self.max_s:
            return "max"
        if self.idle_s and self._now() - self._last >= self._idle_limit():
            return "idle"
        return None

    def wake_in(self) -> float:
        """Seconds until the earliest moment ``expired`` could say yes."""
        if self._held_since is not None:
            return max(self.idle_s, 1.0)
        waits = []
        if self.max_s:
            waits.append(self.max_s - self._elapsed())
        if self.idle_s:
            waits.append(self._idle_limit() - (self._now() - self._last))
        return max(MIN_WAKE_S, min(waits)) if waits else 60.0

    def message(self) -> str:
        if self.reason == "max":
            why = f"这一轮已经跑了 {span(self.limit_s)}，到了上限"
        else:
            why = f"这一轮 {span(self.limit_s)}没有任何输出"
        return f"{why}，已中止；原生会话还在，发「继续」就能接着"

    # ——— the stop ———
    async def _watch(self, limit: asyncio.Timeout, probe: Callable[[], float | None] | None) -> None:
        loop = asyncio.get_running_loop()
        if probe is not None:
            await asyncio.to_thread(probe)  # the log as the turn begins: only growth after this is activity
        while True:
            self._nearer.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._nearer.wait(), self.wake_in())
            why = self.expired()
            if why == "idle" and probe is not None:
                age = await asyncio.to_thread(probe)
                if age is not None:  # the log grew, ``age`` ago: that is the last activity
                    self._last = max(self._last, self._now() - age)
                    continue
                why = self.expired()  # the probe took time: the verdict is the clock's now, not the one from before it
            if why:
                self.reason = why
                self.limit_s = self.max_s if why == "max" else self._idle_limit()
                limit.reschedule(loop.time())
                return

    @asynccontextmanager
    async def guard(self, probe: Callable[[], float | None] | None = None) -> AsyncIterator[None]:
        """Run a turn under this clock: ``TimeoutError`` leaves the block when the clock runs out (``reason`` and ``message()`` say why).
        ``probe`` answers how long ago the native log last grew (None: not since it was last asked)."""
        async with asyncio.timeout(None) as limit:
            watcher = asyncio.create_task(self._watch(limit, probe))
            try:
                yield
            finally:
                watcher.cancel()
