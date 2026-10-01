"""Which code a server runs: the checkout's HEAD, read once when the process starts (``/api/project/health``, the
machine's server records, the page's corner). Two worktrees serving at once are told apart by it."""

from __future__ import annotations

import subprocess
from functools import lru_cache
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _git(repo: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def code_version(repo: Path = REPO) -> dict[str, str | bool | None]:
    """``sha``: HEAD of ``repo`` (None outside git: unknown, never guessed); ``dirty``: tracked files differ from it."""
    sha = _git(repo, "rev-parse", "HEAD")
    dirty = bool(_git(repo, "status", "--porcelain", "--untracked-files=no")) if sha else False
    return {"sha": sha, "dirty": dirty}


@lru_cache(maxsize=1)
def running_version() -> dict[str, str | bool | None]:
    """This process's code version, fixed at its first call (the server asks at start-up)."""
    return code_version()
