"""A selected integration test must fail, not skip, when the services are down.

Skipping here used to report success while proving nothing, so this runs the
real pytest entry point against unreachable services in a subprocess.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_unreachable_services_fail_the_run() -> None:
    env = {
        **os.environ,
        "CI": "true",
        "PATH": "/usr/bin:/bin",  # no docker: nothing may start the services behind our back
        "AGORA_DATABASE_URL": "postgresql://agora:agora@127.0.0.1:59999/agora",
        "AGORA_REDIS_URL": "redis://127.0.0.1:59998/0",
    }
    completed = subprocess.run(
        [sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-q", "tests/test_seq.py"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert completed.returncode != 0, completed.stdout
    assert "services unreachable" in completed.stdout
    assert "skipped" not in completed.stdout
