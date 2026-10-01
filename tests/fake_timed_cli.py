#!/usr/bin/env python3
"""Test double that plays a script of timed steps, as ``codex exec --json`` (headless) or ``codex app-server`` (resident).

``FAKE_SCRIPT`` (or, read afresh at every turn, the file ``FAKE_SCRIPT_FILE``) is a JSON list, one step each: ``{"sleep": s}``, ``{"say": text}`` (an agent message),
``{"tool": "start"|"end"}`` (a command execution begins / ends), ``{"append": path}`` (one byte onto a file: the native log),
``{"stderr": text}``, ``{"done": 1}`` (the turn completes). The script runs once per turn; a turn that never reaches
``done`` simply sleeps on, which is what a hung CLI looks like."""

import json
import os
import sys
import time

APP = "app-server" in sys.argv[1:]


def steps() -> list:
    if os.environ.get("FAKE_SCRIPT_FILE"):
        return json.loads(open(os.environ["FAKE_SCRIPT_FILE"]).read())
    return json.loads(os.environ.get("FAKE_SCRIPT", "[]"))


def rollout(thread: str) -> None:
    """``FAKE_ROLLOUT=1``: leave the native log a real Codex leaves (a resume looks for it), under ``CODEX_HOME``."""
    if os.environ.get("FAKE_ROLLOUT"):
        d = os.path.join(os.environ["CODEX_HOME"], "sessions", "2026", "10", "01")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"rollout-2026-10-01T00-00-00-{thread}.jsonl"), "a") as f:
            f.write(json.dumps({"type": "session_meta", "payload": {"id": thread, "cwd": os.getcwd()}}) + "\n")


def emit(o: dict) -> None:
    print(json.dumps(o, ensure_ascii=False), flush=True)


def play(thread: str, turn: str) -> None:
    for s in steps():
        if "sleep" in s:
            time.sleep(s["sleep"])
        elif "append" in s:
            with open(s["append"], "ab") as f:
                f.write(b".")
        elif "stderr" in s:
            sys.stderr.write(s["stderr"] + "\n")
            sys.stderr.flush()
        elif "say" in s:
            if APP:
                emit({"method": "item/completed", "params": {"threadId": thread, "turnId": turn, "item": {"type": "agentMessage", "id": "a", "text": s["say"], "phase": "final_answer"}}})
            else:
                emit({"type": "item.completed", "item": {"id": "a", "type": "agent_message", "text": s["say"]}})
        elif "tool" in s:
            start = s["tool"] == "start"
            if APP:
                item = {"type": "commandExecution", "id": "c1", "command": "sleep 600", "cwd": "/w", "status": "inProgress" if start else "completed", "commandActions": [], "aggregatedOutput": None if start else "", "exitCode": None if start else 0}
                emit({"method": "item/started" if start else "item/completed", "params": {"threadId": thread, "turnId": turn, "item": item}})
            else:
                item = {"id": "c1", "type": "command_execution", "command": "sleep 600"}
                emit({"type": "item.started", "item": item} if start else {"type": "item.completed", "item": {**item, "exit_code": 0, "aggregated_output": ""}})
        elif "done" in s:
            if APP:
                emit({"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": turn, "status": "completed", "error": None}}})
            else:
                emit({"type": "turn.completed", "usage": {"input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1}})
            return
    time.sleep(600)


def app_server() -> None:
    thread, turn, n = "th-t", None, 0
    for line in sys.stdin:
        m = json.loads(line)
        method, rid = m.get("method"), m.get("id")
        if method == "initialize":
            emit({"id": rid, "result": {"userAgent": "fake", "codexHome": "/tmp/x"}})
        elif method in ("thread/start", "thread/resume"):
            thread = (m.get("params") or {}).get("threadId") or thread
            rollout(thread)
            emit({"id": rid, "result": {"thread": {"id": thread}}})
        elif method == "turn/start":
            n += 1
            turn = f"tu-{n}"
            emit({"id": rid, "result": {"turn": {"id": turn, "status": "inProgress"}}})
            emit({"method": "turn/started", "params": {"threadId": thread, "turn": {"id": turn, "status": "inProgress"}}})
            play(thread, turn)


if APP:
    app_server()
else:
    sys.stdin.read()
    rollout("th-t")
    emit({"type": "thread.started", "thread_id": "th-t"})
    play("th-t", "tu-1")
