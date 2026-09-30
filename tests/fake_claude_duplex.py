#!/usr/bin/env python3
"""Test double for ``claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio``.

Reads the first user message from stdin, then behaves by ``FAKE_DUPLEX_MODE``:

- ``ask``      init(auto) → a ``can_use_tool`` AskUserQuestion; a ``allow`` answer ends the turn with
               ``result success``, a ``deny`` one with ``result success`` too (the model carries on)
- ``approve``  init(default) → a ``can_use_tool`` Write; same endings
- ``deny_note`` init(auto) → no request; the result carries one ``permission_denials`` entry
- ``hang``     init, then a tool call that never finishes (interrupt tests)

A ``control_request`` interrupt is answered like the real CLI: ``control_cancel_request`` for a pending
request, ``result error_during_execution / aborted_tools``. It exits when stdin closes. Every line read
from stdin is appended to ``FAKE_DUPLEX_LOG``."""

import json
import os
import sys

MODE = os.environ.get("FAKE_DUPLEX_MODE", "ask")
LOG = os.environ.get("FAKE_DUPLEX_LOG")


def emit(o: dict) -> None:
    print(json.dumps(o), flush=True)


def result(**kw) -> dict:
    return {"type": "result", "subtype": "success", "is_error": False, "result": "done", "session_id": "fake-native", "total_cost_usd": 0.001, "usage": {"input_tokens": 1, "output_tokens": 1}, "terminal_reason": "completed", **kw}


def main() -> None:
    first = sys.stdin.readline()
    if LOG:
        open(LOG, "a").write(first)
    emit({"type": "system", "subtype": "init", "session_id": "fake-native", "model": "fake-model", "permissionMode": "default" if MODE == "approve" else "auto"})
    pending = None
    if MODE == "ask":
        pending = {"type": "control_request", "request_id": "req-1", "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "tool_use_id": "tu-1", "display_name": "AskUserQuestion", "requires_user_interaction": True, "input": {"questions": [{"question": "Which fruit?", "header": "Fruit", "options": [{"label": "Apple", "description": ""}, {"label": "Banana", "description": ""}], "multiSelect": False}]}}}
    elif MODE == "approve":
        pending = {"type": "control_request", "request_id": "req-1", "request": {"subtype": "can_use_tool", "tool_name": "Write", "tool_use_id": "tu-1", "input": {"file_path": "/work/proj/a.txt", "content": "x"}, "permission_suggestions": [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}], "decision_reason_type": "other", "decision_reason": "needs approval"}}
    elif MODE == "deny_note":
        emit(result(permission_denials=[{"tool_name": "Write", "tool_use_id": "tu-9", "tool_input": {"file_path": "/work/proj/.claude/settings.json", "content": "{}"}}]))
    elif MODE == "hang":
        emit({"type": "assistant", "message": {"model": "fake-model", "content": [{"type": "tool_use", "id": "tu-2", "name": "Bash", "input": {"command": "sleep 100"}}]}})
    if pending:
        emit(pending)
    for line in sys.stdin:
        if LOG:
            open(LOG, "a").write(line)
        o = json.loads(line)
        req = o.get("request") or {}
        if o.get("type") == "control_request" and req.get("subtype") == "interrupt":
            denials = []
            if pending:
                emit({"type": "control_cancel_request", "request_id": pending["request_id"]})
                denials = [{"tool_name": pending["request"]["tool_name"], "tool_use_id": pending["request"]["tool_use_id"], "tool_input": pending["request"]["input"]}]  # as the real CLI lists it
                pending = None
            emit({"type": "control_response", "response": {"subtype": "success", "request_id": o["request_id"], "response": {"still_queued": []}}})
            emit(result(subtype="error_during_execution", is_error=True, result=None, terminal_reason="aborted_tools", permission_denials=denials))
            if os.environ.get("FAKE_DUPLEX_EXIT_AFTER_INTERRUPT"):
                sys.exit(1)  # the real CLI does this when the interrupt cut a running tool
        elif o.get("type") == "control_response" and pending:
            body = o["response"]["response"]
            tool = pending["request"]
            pending = None
            # like the real CLI: a call the host denied is listed in the result's permission_denials too
            emit(result(permission_denials=[{"tool_name": tool["tool_name"], "tool_use_id": tool["tool_use_id"], "tool_input": tool["input"]}]) if body.get("behavior") == "deny" else result())


if __name__ == "__main__":
    main()
