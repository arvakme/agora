"""The marker a dispatch puts in its message is found in each CLI's own log record (a real record of
Claude Code, Codex and Pi, with the footer Agora adds); a dispatch's ``agora dispatch`` shell call is a
delegation in the parent's trajectory."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server.canvas.adapters.tools import dispatches_a_task
from server.canvas.transcript import State, project

RID = "0d5f6a1e-7b3c-4c1f-9a52-3e8d2b6c4f10"
FIX = Path(__file__).parent / "fixtures" / "dispatch"


@pytest.mark.parametrize("kind", ["claude", "codex", "pi"])
def test_the_marker_in_the_users_message_names_the_dispatch(kind):
    st, items = State(), []
    for line in (FIX / f"mark-{kind}.jsonl").read_text().splitlines():
        items += project(kind, json.loads(line), st)[0]
    users = [i for i in items if i["kind"] == "user"]
    assert [u.get("dispatch") for u in users] == [RID] and users[0]["source"] == "agora"
    assert "agora-req" not in users[0]["text"] and "[[agora]]" not in users[0]["text"]  # the footer stays hidden
    assert [i["kind"] for i in items if i["kind"] in ("user", "end")] == ["user", "end"]  # the turn that follows the marked message ends: what the dispatch folds


@pytest.mark.parametrize("kind,rec", [
    ("claude", {"type": "user", "uuid": "u1", "message": {"role": "user", "content": "你好"}}),
    ("pi", {"type": "message", "id": "m1", "message": {"role": "user", "content": [{"type": "text", "text": "你好\n\n[[agora]] 来自 Agora。"}]}}),
])
def test_a_message_without_the_marker_has_none(kind, rec):
    (item,), _ = project(kind, rec, State())
    assert "dispatch" not in item


@pytest.mark.parametrize("cmd,want", [
    ("agora dispatch --to s-b --task-file t.md", True),
    ("cd web && agora dispatch --new codex --task-file t.md --scope 'server/**'", True),
    ("bin/agora dispatch --to s-b --text hi", True),
    (["/bin/zsh", "-lc", "agora dispatch --new pi --task-file -"], True),
    ("agora dispatch status 0d5f6a1e", False),
    ("agora dispatch wait 0d5f6a1e", False),
    ("agora dispatch interrupt 0d5f6a1e", False),
    ("agora reply --request 0d5f6a1e --status done", False),
    ("echo agora dispatch", False),
    ("grep 'agora dispatch' notes.md", False),
])
def test_a_shell_call_that_gives_a_task_is_a_delegation(cmd, want):
    assert dispatches_a_task(cmd) is want


def test_the_claude_bash_call_shows_up_as_subagents_in_the_trajectory():
    rec = {"type": "assistant", "uuid": "a1", "timestamp": "2026-09-29T01:00:00Z", "message": {"id": "m1", "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "agora dispatch --new codex --task-file t.md"}}]}}
    items, _ = project("claude", rec, State())
    assert items[0]["tool"]["activity"] == "subagents"
