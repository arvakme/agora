"""Codex adapter: discover the session rollout log from the pane process."""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

_ROLLOUT = re.compile(r"rollout-.+\.jsonl$")
_SESSIONS = ".codex/sessions"


def thread_id_from_rollout(path: Path) -> str:
    """Return the Codex thread id encoded in a rollout filename."""
    name = path.name
    if not name.startswith("rollout-") or not name.endswith(".jsonl"):
        raise ValueError(f"not a rollout log: {path}")
    return name[len("rollout-") : -len(".jsonl")]


def rollout_opened_by(pid: int) -> Path | None:
    """Return the rollout JSONL this process has open, if any."""
    for raw in _open_paths(pid):
        path = Path(os.path.realpath(raw))
        if _SESSIONS not in path.as_posix():
            continue
        if _ROLLOUT.fullmatch(path.name):
            return path
    return None


def wait_rollout(pid: int, *, timeout: float = 60.0) -> tuple[Path, str]:
    """Wait until ``pid`` opens its rollout log; return path and thread id."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        path = rollout_opened_by(pid)
        if path is not None:
            return path, thread_id_from_rollout(path)
        time.sleep(0.05)
    raise TimeoutError(f"pid {pid} never opened a Codex rollout log within {timeout}s")


def pane_pid(tmux: str, socket: Path, session: str) -> int:
    """Return the pane pid for a named tmux session on a deployment socket."""
    result = subprocess.run(
        [tmux, "-S", str(socket), "list-panes", "-t", session, "-F", "#{pane_pid}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"tmux pane for session {session} is not available")
    return int(result.stdout.strip())


def _open_paths(pid: int) -> list[str]:
    proc = Path(f"/proc/{pid}/fd")
    if proc.is_dir():
        return _linux_open_paths(proc)
    return _lsof_paths(pid)


def _linux_open_paths(proc: Path) -> list[str]:
    paths: list[str] = []
    for entry in proc.iterdir():
        try:
            target = os.readlink(entry)
        except OSError:
            continue
        if target.startswith("/"):
            paths.append(target)
    return paths


def _lsof_paths(pid: int) -> list[str]:
    from shutil import which

    lsof = which("lsof")
    if lsof is None:
        raise RuntimeError("lsof is required to discover Codex rollout logs on this platform")
    result = subprocess.run(
        [lsof, "-nP", "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return []
    paths: list[str] = []
    for line in result.stdout.splitlines():
        parts = line.split(maxsplit=8)
        if len(parts) < 9:
            continue
        name = parts[8]
        if name.startswith("/"):
            paths.append(name)
    return paths
