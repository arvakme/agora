"""Which code a server runs: the checkout's HEAD, read once when the process starts (``/api/project/health``, the
machine's server records, the page's corner). Two worktrees serving at once are told apart by it. An installed copy
has no checkout: it reports its package version, and git is never asked (site-packages may sit inside someone else's
repository, whose HEAD is not ours)."""

from __future__ import annotations

import subprocess
from functools import lru_cache
from importlib import metadata
from pathlib import Path

from server.paths import CHECKOUT, ROOT

DIST_NAME = "agora-canvas"  # [project] name in pyproject.toml


def _git(repo: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def code_version(repo: Path = ROOT) -> dict[str, str | bool | None]:
    """``sha``: HEAD of ``repo`` (None outside git: unknown, never guessed); ``dirty``: tracked files differ from it
    (None when git could not say: not the same as clean)."""
    sha = _git(repo, "rev-parse", "HEAD")
    status = _git(repo, "status", "--porcelain", "--untracked-files=no") if sha else None
    return {"sha": sha, "dirty": None if status is None else bool(status)}


def package_version() -> str | None:
    """The installed distribution's version; None when it is not installed (a checkout run through PYTHONPATH only)."""
    try:
        return metadata.version(DIST_NAME)
    except metadata.PackageNotFoundError:
        return None


@lru_cache(maxsize=1)
def running_version() -> dict[str, str | bool | None]:
    """This process's code version, fixed at its first call (the server asks at start-up)."""
    code = code_version() if CHECKOUT else {"sha": None, "dirty": None}
    return {**code, "version": package_version()}
