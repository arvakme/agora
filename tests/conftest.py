from __future__ import annotations

import os

import pytest

# Starlette's TestClient sends Host: testserver; the owner app only answers to local names.
os.environ.setdefault("AGORA_ALLOWED_HOSTS", "testserver")


@pytest.fixture(autouse=True)
def _agora_state_dir(tmp_path_factory, monkeypatch):
    """Machine-local Agora state (instance registry, server records, backups) goes to a temporary
    directory in every test, never to ~/.local/state/agora."""
    if "AGORA_STATE_DIR" not in os.environ or not os.environ["AGORA_STATE_DIR"].startswith(str(tmp_path_factory.getbasetemp())):
        monkeypatch.setenv("AGORA_STATE_DIR", str(tmp_path_factory.mktemp("agora-state")))


# ——— no tmux servers left behind (KT1) ———
# A test that starts a real tmux server (terminal panes: a fake CLI runs in it) must not leave it running when it
# fails, is interrupted, or the whole run dies: eleven ``tmux -L agora-<id>`` servers with fake CLIs were found
# after such runs. Every server started under this pytest inherits ``AGORA_TEST_RUN`` (its process id), which is
# how a server is known to be a test's: after each test the new sockets that carry it are closed, and at the
# start of a run the ones whose pytest process is gone (killed: no teardown could run) are. A user's own Agora
# servers, or those of another pytest run that is still alive, are never touched.
import shutil  # noqa: E402
import subprocess  # noqa: E402
from pathlib import Path  # noqa: E402

RUN_ID = "AGORA_TEST_RUN"
os.environ[RUN_ID] = str(os.getpid())
TMUX = shutil.which("tmux")


def _tmux_dir() -> Path:
    return Path(os.environ.get("TMUX_TMPDIR") or "/tmp") / f"tmux-{os.getuid()}"


def _tmux_sockets() -> set[str]:
    try:
        return {p.name for p in _tmux_dir().iterdir() if p.name.startswith("agora-")}
    except OSError:
        return set()


def _tests_run_of(socket: str) -> int | None:
    """The pytest process a tmux server was started under (None: not a test's server, or not running)."""
    try:
        out = subprocess.run([TMUX, "-L", socket, "show-environment", "-g", RUN_ID], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return int(out.split("=", 1)[1]) if out.startswith(RUN_ID + "=") and out.split("=", 1)[1].isdigit() else None


def _close_tmux(socket: str) -> None:
    subprocess.run([TMUX, "-L", socket, "kill-server"], capture_output=True, timeout=10)
    (_tmux_dir() / socket).unlink(missing_ok=True)  # a killed server can leave its socket file


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def pytest_sessionstart(session):
    if TMUX is None:
        return
    for name in _tmux_sockets():
        owner = _tests_run_of(name)
        if owner is not None and owner != os.getpid() and not _pid_alive(owner):
            _close_tmux(name)


@pytest.fixture(autouse=True)
def _no_tmux_servers_left_behind():
    before = _tmux_sockets() if TMUX else set()
    try:
        yield
    finally:
        if TMUX:
            for name in _tmux_sockets() - before:
                if _tests_run_of(name) == os.getpid():
                    _close_tmux(name)
