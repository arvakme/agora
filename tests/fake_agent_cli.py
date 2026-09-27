#!/usr/bin/env python3
"""Test double for the three agent CLIs in their headless modes.

``fake_agent_cli.py <fixture.jsonl> [real CLI args…]`` replays a recorded stdout stream
(tests/fixtures/agents/*-stream.jsonl) after reading stdin, and — when
``FAKE_AGENT_PROBE`` is set — writes {"cwd", "argv", "stdin", "env"} there first, so tests
can assert where and how the backend launched it. ``FAKE_AGENT_EXIT`` sets the exit code."""

import json
import os
import sys
from pathlib import Path

fixture = Path(sys.argv[1])
stdin = "" if sys.stdin is None or sys.stdin.isatty() else sys.stdin.read()
if probe := os.environ.get("FAKE_AGENT_PROBE"):
    keep = {k: v for k, v in os.environ.items() if k.startswith(("AGORA_", "CLAUDE")) or k == "PATH"}
    Path(probe).write_text(json.dumps({"cwd": os.getcwd(), "argv": sys.argv[2:], "stdin": stdin, "env": keep}))
for line in fixture.read_text().splitlines():
    print(line, flush=True)
sys.exit(int(os.environ.get("FAKE_AGENT_EXIT", "0")))
