#!/usr/bin/env python3
"""Test double for ``codex app-server`` (JSON-RPC lines on stdio; shapes recorded 2026-09-29 from codex 0.157.1,
tests/fixtures/agents/codex-appserver/) and for ``codex exec --json`` (the one-shot way, used by the fallback).

``FAKE_MODE`` for a turn: ``quick`` (one command, one answer, done), ``hold`` (default: a command runs, then it waits for a
``turn/steer`` — which ends the turn — or a ``turn/interrupt``), ``die`` (exit 3 as the turn starts), ``approval`` (asks the
host for an approval first and goes on once answered).  ``FAKE_NO_APPSERVER=1``: ``app-server`` is not a command of this
"old" CLI.  ``FAKE_CHILD=<file>``: start a child process (a shell that sleeps) and write its pid to the file.
Every line read from stdin (and the argv) is appended to ``FAKE_LOG``."""

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


def item(kind: str, iid: str, **kw) -> dict:
    return {"type": kind, "id": iid, **kw}


def notify(method: str, **params) -> None:
    emit({"method": method, "params": params})


def usage(total: int) -> dict:
    return {"total": {"totalTokens": total, "inputTokens": total - 10, "cachedInputTokens": 5, "cacheWriteInputTokens": 0, "outputTokens": 10, "reasoningOutputTokens": 0}, "last": {}}


def exec_main() -> None:
    log({"argv": sys.argv[1:], "stdin": sys.stdin.read()})
    emit({"type": "thread.started", "thread_id": "th-exec"})
    emit({"type": "item.completed", "item": {"id": "m1", "type": "agent_message", "text": "一次性跑法的回答"}})
    emit({"type": "turn.completed", "usage": {"input_tokens": 3, "cached_input_tokens": 0, "output_tokens": 4}})


def main() -> None:
    log({"argv": sys.argv[1:]})
    if sys.argv[1:2] == ["exec"] or (len(sys.argv) > 2 and sys.argv[2:3] == ["exec"]):
        return exec_main()
    if os.environ.get("FAKE_NO_APPSERVER"):
        sys.stderr.write("error: unrecognized subcommand 'app-server'\n")
        sys.exit(2)
    if os.environ.get("FAKE_CHILD"):
        p = subprocess.Popen(["sh", "-c", "sleep 300"])
        open(os.environ["FAKE_CHILD"], "w").write(str(p.pid))
    thread = None
    turn = None
    n_turn = 0
    total = 100
    for line in sys.stdin:
        log(json.loads(line))
        m = json.loads(line)
        method, rid, params = m.get("method"), m.get("id"), m.get("params") or {}
        if method == "initialize":
            emit({"id": rid, "result": {"userAgent": "fake/0.157.1", "codexHome": "/tmp/x"}})
        elif method in ("thread/start", "thread/resume"):
            thread = params.get("threadId") or "th-1"
            emit({"id": rid, "result": {"thread": {"id": thread}}})
            notify("thread/started", thread={"id": thread})
            if method == "thread/resume":
                notify("thread/tokenUsage/updated", threadId=thread, turnId="", tokenUsage=usage(total))
        elif method == "turn/start":
            n_turn += 1
            turn = f"tu-{n_turn}"
            if MODE == "die":
                sys.stderr.write("app-server: fatal: database is locked\n")
                sys.stderr.flush()
                sys.exit(3)
            emit({"id": rid, "result": {"turn": {"id": turn, "status": "inProgress"}}})
            notify("turn/started", threadId=thread, turn={"id": turn, "status": "inProgress"})
            text = params["input"][0]["text"]
            mode = "quick" if text.startswith("quick:") else MODE
            notify("item/started", threadId=thread, turnId=turn, item=item("userMessage", "u1", content=[{"type": "text", "text": text}]))
            if mode == "approval":
                emit({"id": "srv-1", "method": "item/commandExecution/requestApproval", "params": {"threadId": thread, "turnId": turn, "itemId": "c1", "command": "rm x"}})
                continue
            first(thread, turn)
            if mode == "quick":
                finish(thread, turn, "completed", total := total + 50)
        elif method == "turn/steer":
            emit({"id": rid, "result": {"turnId": params["expectedTurnId"]}})
            notify("item/completed", threadId=thread, turnId=turn, item=item("userMessage", "u2", content=params["input"]))
            notify("item/completed", threadId=thread, turnId=turn, item=item("agentMessage", "a2", text="收到，只读前两个", phase="final_answer"))
            total += 50
            finish(thread, turn, "completed", total)
        elif method == "turn/interrupt":
            emit({"id": rid, "result": None})
            finish(thread, turn, "interrupted", total)
        elif rid is not None and method is None and rid == "srv-1":
            first(thread, turn)
            finish(thread, turn, "completed", total := total + 50)


def first(thread: str, turn: str) -> None:
    notify("item/started", threadId=thread, turnId=turn, item=item("commandExecution", "c1", command="/bin/zsh -lc 'cat f1.txt'", cwd="/w", status="inProgress", commandActions=[{"type": "read", "command": "cat f1.txt", "name": "f1.txt", "path": "/w/f1.txt"}], aggregatedOutput=None, exitCode=None))
    notify("item/completed", threadId=thread, turnId=turn, item=item("commandExecution", "c1", command="/bin/zsh -lc 'cat f1.txt'", cwd="/w", status="completed", commandActions=[{"type": "read", "command": "cat f1.txt", "name": "f1.txt", "path": "/w/f1.txt"}], aggregatedOutput="file 1: content-1\n", exitCode=0))
    notify("item/completed", threadId=thread, turnId=turn, item=item("agentMessage", "a1", text="f1 是 content-1", phase="commentary"))


def finish(thread: str, turn: str, status: str, total: int) -> None:
    notify("thread/tokenUsage/updated", threadId=thread, turnId=turn, tokenUsage=usage(total))
    notify("turn/completed", threadId=thread, turn={"id": turn, "status": status, "error": None})


if __name__ == "__main__":
    main()
