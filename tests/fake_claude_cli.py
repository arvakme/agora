#!/usr/bin/env python3
"""Test double for the ``claude`` CLI used by server/canvas tests.

Speaks ``stream-json`` on stdout like ``claude -p --output-format stream-json --verbose``:
system init → assistant text/tool_use → user tool_result → result. Behaviour is selected
through ``FAKE_CLAUDE_MODE`` so runner/router tests never touch a model or the network:

- ``ok`` (default)  structured_output {"ops": [], "note": "noop"} (or FAKE_CLAUDE_OPS json)
- ``anim``          a minimal animation script object
- ``bad_shape``     structured_output that fails the plan schema
- ``claude_error``  result line with is_error=true (e.g. unauthenticated/turn limit)
- ``exit1``         die with stderr noise and exit code 1
- ``exit_after_final`` emit a valid result, then exit 7
- ``use_library``   emits a search_library tool_use + tool_result first
- ``bigline``       emit a >64 KiB assistant line before the result
- ``hang``          sleep forever (timeout / client-disconnect kill tests)
- ``ignore_term``   trap SIGTERM and keep running (SIGKILL escalation tests)
- ``nostdin``       never read stdin (stdin-drain timeout tests)

``FAKE_CLAUDE_PIDFILE`` makes the process write its pid (kill assertions)."""

import json
import os
import signal
import sys
import time
from pathlib import Path

MODE = os.environ.get("FAKE_CLAUDE_MODE", "ok")


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def structured() -> dict:
    if MODE == "anim":
        return {"title": "demo", "w": 800, "h": 400, "nodes": [], "steps": []}
    if MODE == "bad_shape":
        return {"oops": True}
    raw = os.environ.get("FAKE_CLAUDE_OPS")
    if raw is not None:
        return json.loads(raw)
    return {"ops": [], "note": "noop"}


def main() -> None:
    if MODE == "ignore_term":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if pidfile := os.environ.get("FAKE_CLAUDE_PIDFILE"):
        Path(pidfile).write_text(str(os.getpid()))
    if MODE == "nostdin":
        emit({"type": "system", "subtype": "init", "session_id": "fake"})
        time.sleep(600)
        return
    sys.stdin.read()  # the runner pipes the prompt on stdin

    emit({"type": "system", "subtype": "init", "session_id": "fake"})
    emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "thinking …"}]}})
    if MODE == "bigline":
        emit(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "x" * 200_000}]},
            }
        )
    if MODE == "use_library":
        emit(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "t1",
                            "name": "mcp__library__search_library",
                            "input": {"query": "redis"},
                        }
                    ]
                },
            }
        )
        emit(
            {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "t1",
                            "content": [{"type": "text", "text": '[{"id":"x"}]'}],
                        }
                    ]
                },
            }
        )
    emit(
        {
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": "s1", "name": "StructuredOutput", "input": {}}]},
        }
    )
    emit(
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "s1",
                        "content": [{"type": "text", "text": "Structured output provided"}],
                    }
                ]
            },
        }
    )

    if MODE in ("hang", "ignore_term"):
        time.sleep(600)
        return
    if MODE == "exit_after_final":
        emit(
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "structured_output": structured(),
                "total_cost_usd": 0.012,
                "result": "",
                "duration_ms": 10,
            }
        )
        sys.stderr.write("dying anyway\n")
        sys.stderr.flush()
        sys.exit(7)
    if MODE == "exit1":
        sys.stderr.write("boom\n")
        sys.stderr.flush()
        sys.exit(1)
    if MODE == "claude_error":
        emit(
            {
                "type": "result",
                "subtype": "error_max_turns",
                "is_error": True,
                "result": "hit the turn limit",
                "total_cost_usd": 0.01,
            }
        )
        return
    emit(
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "structured_output": structured(),
            "total_cost_usd": 0.012,
            "result": "",
            "duration_ms": 10,
        }
    )


if __name__ == "__main__":
    main()
