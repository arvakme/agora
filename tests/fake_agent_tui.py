#!/usr/bin/env python3
"""Stand-in for an interactive agent CLI in a tmux pane (tests of terminal sync).

``fake_agent_tui.py <log.jsonl>``: whatever arrives on the terminal within a short burst
(a paste, or a typed line) is one prompt; it is logged in Pi's session format as a user
message, then answered with ``echo: <first line>`` — like a real CLI writing its session log."""

import json
import os
import select
import sys
import time
import uuid

log = sys.argv[1]


def write(role: str, text: str, **extra) -> None:
    rec = {"type": "message", "id": uuid.uuid4().hex[:8], "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "message": {"role": role, "content": [{"type": "text", "text": text}], **extra}}
    with open(log, "a") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


print("fake agent ready", flush=True)
fd = sys.stdin.fileno()
while True:
    select.select([fd], [], [])
    chunk = b""
    while True:
        r, _, _ = select.select([fd], [], [], 1.0)
        if not r:
            break
        data = os.read(fd, 65536)
        if not data:
            sys.exit(0)
        chunk += data
    text = chunk.decode("utf-8", "replace").replace("\r", "\n").strip()
    if not text:
        continue
    write("user", text)
    time.sleep(0.3)
    write("assistant", "echo: " + text.splitlines()[0], stopReason="stop")
    print("answered", flush=True)
