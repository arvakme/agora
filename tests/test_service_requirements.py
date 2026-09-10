from __future__ import annotations

import os
import socket
import subprocess
import sys
from contextlib import ExitStack
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _refusing_port(stack: ExitStack) -> int:
    """Hold a bound but never listening port: connecting to it is always refused.

    Holding it for the whole subprocess also keeps a real service from landing
    on the port and turning this regression green by accident.
    """
    sock = stack.enter_context(socket.socket())
    sock.bind(("127.0.0.1", 0))
    return sock.getsockname()[1]


def test_unreachable_services_fail_the_run() -> None:
    with ExitStack() as held:
        env = {key: value for key, value in os.environ.items() if key not in ("CI", "GITHUB_ACTIONS")}
        env.update(
            PATH="/usr/bin:/bin",  # no docker: nothing may start the services behind our back
            AGORA_DATABASE_URL=f"postgresql://agora:agora@127.0.0.1:{_refusing_port(held)}/agora",
            AGORA_REDIS_URL=f"redis://127.0.0.1:{_refusing_port(held)}/0",
        )
        completed = subprocess.run(
            [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-q", "tests/test_seq.py"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )

    assert completed.returncode != 0, completed.stdout
    assert "services unreachable" in completed.stdout
    assert "skipped" not in completed.stdout
