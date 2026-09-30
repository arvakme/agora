"""Ending the whole process tree of a turn (KT1). Standard library only (``adapters/devin_run.py`` runs by path).

Signalling a CLI's process group is not enough: its shells and tools live in other groups (Node ``detached``,
``setsid``), some ignore SIGTERM, and once the CLI is gone its children belong to init and cannot be found
from it any more. So the tree is remembered while the turn runs (``Watch``) and ``stop`` ends all of it:

1. SIGTERM to the CLI's group (when it leads one) and to every remembered / current descendant outside it;
2. after a grace, SIGKILL to whatever is still there — also when the CLI itself has already exited.

Only this turn's own processes are touched: descendants by parent pid, each remembered with its start time so a
pid the system reused for something else is left alone. Nothing here looks at names or other sessions.
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import threading
import time
from collections.abc import Mapping

GRACE_S = 5.0
POLL_S = 0.25  # while waiting out the grace: a `ps` costs ~35 ms on a busy machine
SHARE_S = 0.5  # running turns share one snapshot this long (well under the 1 s a Watch waits: a poll never reuses the previous round's)


_cache: tuple[float, dict[int, tuple[int, int, str]]] | None = None
_cache_lock = threading.Lock()

# ``-ww``: without it Linux procps cuts every column at ``$COLUMNS`` (80 under pytest and in most services) when the output is a pipe
_PS_ENV = {"LC_ALL": "C"}


def parse_snapshot(out: str) -> dict[int, tuple[int, int, str]]:
    """The rows of ``ps -A -o pid=,ppid=,pgid=,stat=,lstart=`` (macOS and Linux print them alike), zombies left out."""
    procs: dict[int, tuple[int, int, str]] = {}
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) == 5 and parts[0].isdigit() and parts[1].isdigit() and parts[2].isdigit() and not parts[3].startswith("Z"):
            procs[int(parts[0])] = (int(parts[1]), int(parts[2]), parts[4].strip())
    return procs


def snapshot(max_age: float = 0.0) -> dict[int, tuple[int, int, str]]:
    """Every live process (zombies are already gone as far as stopping goes): pid → (ppid, pgid, start time as ``ps`` prints it).
    ``max_age``: a snapshot taken that recently (by anyone) is reused — the watches of several running turns share one
    ``ps``; stopping asks for a fresh one (0)."""
    global _cache
    with _cache_lock:
        if max_age > 0 and _cache is not None and time.monotonic() - _cache[0] < max_age:
            return dict(_cache[1])
        try:
            out = subprocess.run(["ps", "-ww", "-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], capture_output=True, text=True, timeout=10, env={**os.environ, **_PS_ENV}).stdout
        except (OSError, subprocess.SubprocessError):
            return {}
        procs = parse_snapshot(out)
        _cache = (time.monotonic(), procs)
        return dict(procs)


def command(pid: int) -> str | None:
    """The whole command line ``pid`` runs now (``None`` when there is no such process or ``ps`` cannot say)."""
    try:
        out = subprocess.run(["ps", "-ww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=5, env={**os.environ, **_PS_ENV}).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out or None


def descendants(root: int, snap: Mapping[int, tuple[int, int, str]] | None = None) -> dict[int, str]:
    """pid → start time of everything below ``root`` (children, their children …)."""
    snap = snapshot() if snap is None else snap
    kids: dict[int, list[int]] = {}
    for pid, (ppid, _, _) in snap.items():
        kids.setdefault(ppid, []).append(pid)
    found: dict[int, str] = {}
    todo = [root]
    while todo:
        for k in kids.get(todo.pop(), []):
            if k not in found and k != root:
                found[k] = snap[k][2]
                todo.append(k)
    return found


class Watch:
    """The descendants a running turn has had, kept while it runs (they are unreachable from the CLI once it is gone)."""

    def __init__(self, root: int) -> None:
        self.root = root
        self.seen: dict[int, str] = {}
        self.root_start: str | None = (snapshot().get(root) or (0, 0, None))[2]  # the root is recognised by its start time too

    def update(self, max_age: float = 0.0) -> None:
        self.seen.update(descendants(self.root, snapshot(max_age)))

    async def run(self, every: float = 1.0) -> None:
        first = True
        while True:
            await asyncio.to_thread(self.update, 0.0 if first else SHARE_S)  # the first look is always fresh; later ones share one `ps` with the other turns
            first = False
            await asyncio.sleep(every)


def _alive(pid: int, snap: Mapping[int, tuple[int, int, str]], start: str | None = None) -> bool:
    got = snap.get(pid)
    return got is not None and (start is None or got[2] == start)


def _send(pid: int, sig: int) -> None:
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def stop(root: int, seen: Mapping[int, str] | None = None, grace: float = GRACE_S, root_start: str | None = None) -> None:
    """End ``root`` and everything that belongs to its turn (see the module docstring). Blocks up to ``grace`` seconds.
    ``root_start``: when the root started (``Watch.root_start``); a pid that now has another start time is not ours."""
    snap = snapshot()
    mine = _alive(root, snap, root_start)  # False also when the pid now belongs to another process (its start time differs)
    members = dict(seen or {})
    if mine:
        members.update(descendants(root, snap))  # a reused root pid's children are not this turn's
    members = {p: s for p, s in members.items() if _alive(p, snap, s)}  # a reused pid is not ours
    leads = mine and snap[root][1] == root
    if leads:
        try:
            os.killpg(root, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    elif mine:
        _send(root, signal.SIGTERM)
    for pid in members:
        if not (leads and snap[pid][1] == root):
            _send(pid, signal.SIGTERM)
    end = time.time() + grace
    while time.time() < end:
        now = snapshot()
        if not (_alive(root, now, root_start) or any(_alive(p, now, s) for p, s in members.items())):
            return
        time.sleep(POLL_S)
    now = snapshot()
    if leads:
        try:
            os.killpg(root, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    if _alive(root, now, root_start):
        _send(root, signal.SIGKILL)
    for pid, start in members.items():
        if _alive(pid, now, start):
            _send(pid, signal.SIGKILL)
