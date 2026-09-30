#!/usr/bin/env python3
"""Test double for ``pi --mode rpc`` (event shapes recorded 2026-09-29 from pi 0.87.1, tests/fixtures/agents/pi-rpc/) and for
``pi -p --mode json`` (the one-shot way, the fallback).  ``FAKE_MODE`` as in fake_codex_appserver.py: ``quick``, ``hold`` (a tool
runs, then it waits for ``steer`` — which ends the turn — or ``abort``), ``die``; ``FAKE_NO_RPC=1``: this "old" Pi has no rpc mode;
``FAKE_CHILD=<file>`` starts a sleeping child and writes its pid there.  Every line read from stdin, and the argv, go to ``FAKE_LOG``."""

import json
import os
import subprocess
import sys

LOG = os.environ.get("FAKE_LOG")
MODE = os.environ.get("FAKE_MODE", "hold")


def log(o) -> None:
    if LOG:
        open(LOG, "a").write(json.dumps(o, ensure_ascii=False) + "\n")


def emit(o: dict) -> None:
    print(json.dumps(o, ensure_ascii=False), flush=True)


def assistant(text: str, stop: str = "stop", tools=()) -> dict:
    content = ([{"type": "text", "text": text}] if text else []) + [{"type": "toolCall", "id": tid, "name": "read", "arguments": {"path": p}} for tid, p in tools]
    return {"role": "assistant", "content": content, "provider": "fake", "model": "m", "stopReason": stop, "usage": {"input": 10, "output": 5, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 15, "cost": {"total": 0.001}}}


def settle() -> None:
    emit({"type": "agent_end", "messages": []})
    emit({"type": "agent_settled"})


def main() -> None:
    args = sys.argv[1:]
    log({"argv": args})
    if "rpc" not in args:
        emit({"type": "session", "id": "pi-exec"})
        emit({"type": "message_end", "message": assistant("一次性跑法的回答")})
        emit({"type": "agent_settled"})
        return
    if os.environ.get("FAKE_NO_RPC"):
        sys.stderr.write("error: unknown mode 'rpc'\n")
        sys.exit(2)
    if os.environ.get("FAKE_CHILD"):
        p = subprocess.Popen(["sh", "-c", "sleep 300"])
        open(os.environ["FAKE_CHILD"], "w").write(str(p.pid))
    emit({"type": "extension_ui_request", "id": "x1", "method": "setStatus", "statusKey": "preset"})
    for line in sys.stdin:
        m = json.loads(line)
        log(m)
        t, rid = m.get("type"), m.get("id")
        if t == "get_state":
            emit({"id": rid, "type": "response", "command": "get_state", "success": True, "data": {"isStreaming": False}})
        elif t == "prompt":
            if MODE == "die":
                sys.stderr.write("pi: fatal: out of memory\n")
                sys.stderr.flush()
                sys.exit(3)
            emit({"id": rid, "type": "response", "command": "prompt", "success": True})
            emit({"type": "agent_start"})
            emit({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": m["message"]}]}})
            emit({"type": "message_end", "message": assistant("读 f1", tools=[("tc1", "f1.txt")])})
            emit({"type": "tool_execution_start", "toolCallId": "tc1", "toolName": "read", "args": {"path": "f1.txt"}})
            emit({"type": "tool_execution_end", "toolCallId": "tc1", "toolName": "read", "result": {"content": [{"type": "text", "text": "file 1: content-1"}]}, "isError": False})
            if MODE == "quick" or m["message"].startswith("quick:"):
                emit({"type": "message_end", "message": assistant("f1 是 content-1")})
                settle()
            elif MODE == "ui" and not m["message"].startswith("quick:"):
                emit({"type": "extension_ui_request", "id": "ask-1", "method": "confirm", "title": "ok?", "message": "?"})
        elif t == "extension_ui_response" and m.get("id") == "ask-1":
            emit({"type": "message_end", "message": assistant("done")})
            settle()
        elif t == "steer":
            emit({"id": rid, "type": "response", "command": "steer", "success": True})
            emit({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": m["message"]}]}})
            emit({"type": "message_end", "message": assistant("收到，只读前两个")})
            settle()
        elif t == "abort":
            emit({"id": rid, "type": "response", "command": "abort", "success": True})
            emit({"type": "message_end", "message": assistant("", stop="aborted")})
            settle()


if __name__ == "__main__":
    main()
