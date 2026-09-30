"""server/canvas/transcript.py — native session logs as one transcript, followed live.

Fixtures are real session logs from the 2026-09-28 run (sanitized): a Claude Code session
with a headless turn, a turn typed in the terminal and one delivered from Agora; a Pi and a
Codex session driven headless from Agora."""

import json
from pathlib import Path

from server.canvas.transcript import MARKER, State, Tail, project, split_agora

from tests.agent_fixtures import legacy


def replay(kind: str, name: str):
    st = State()
    items: dict[str, dict] = {}
    turns: list[dict] = []
    for line in legacy(name).read_text().splitlines():
        its, tcs = project(kind, json.loads(line), st)
        for it in its:
            prev = items.get(it["id"], {})
            items[it["id"]] = {**prev, **it, "tool": {**prev.get("tool", {}), **it.get("tool", {})}} if it["kind"] == "tool" else {**prev, **it}
        turns += tcs
    return list(items.values()), turns, st


def test_claude_log_marks_where_each_message_came_from():
    items, turns, st = replay("claude", "claude-log.jsonl")
    users = [i for i in items if i["kind"] == "user"]
    assert [u["source"] for u in users] == ["agora", "terminal", "agora", "agora"]
    assert users[0]["text"] == "把 Redis 改名为「Redis 集群」，别的不动。"  # footer stripped
    assert MARKER not in "".join(u["text"] for u in users)
    assert users[1]["text"].startswith("终端里问一句")
    tools = [i for i in items if i["kind"] == "tool"]
    assert any(t["tool"]["name"] == "Bash" and "agora canvas read" in t["tool"]["input"] and t["tool"].get("output") for t in tools)
    ends = [t for t in turns if t["turn"] == "end"]
    assert len(ends) == len(users) and not st.busy
    assert "9" in ends[1]["text"]  # the terminal question's answer


def test_pi_log_tool_results_merge_into_their_call():
    items, turns, st = replay("pi", "pi-log.jsonl")
    tools = [i for i in items if i["kind"] == "tool"]
    assert len(tools) == 3 and all("output" in t["tool"] and "input" in t["tool"] for t in tools)
    assert any('"status": "applied"' in t["tool"]["output"] for t in tools)
    assert [t["turn"] for t in turns] == ["start", "end"] and "备份 S3" in turns[-1]["text"]
    assert items[0]["source"] == "agora"


def test_codex_log_turns_and_commands():
    items, turns, st = replay("codex", "codex-log.jsonl")
    assert [t["turn"] for t in turns] == ["start", "end", "start", "end"]
    assert "冒泡排序" in turns[1]["text"]
    cmds = [i for i in items if i["kind"] == "tool"]
    assert any("agora canvas anim" in c["tool"]["input"] for c in cmds)
    users = [i for i in items if i["kind"] == "user"]
    assert users[1]["text"].startswith("画布评论 #1") and users[1]["source"] == "agora"


def test_split_agora():
    assert split_agora(f"hi\n\n{MARKER} ctx") == ("hi", True)
    assert split_agora("typed in a terminal") == ("typed in a terminal", False)


def test_tail_keeps_partial_lines_and_notices_replacement(tmp_path):
    log = tmp_path / "s.jsonl"
    tail = Tail(log)
    assert tail.read() == []  # not there yet
    log.write_bytes(b'{"a": 1}\n{"b": ')
    assert tail.read() == [{"a": 1}]
    with open(log, "ab") as fh:
        fh.write(b'2}\nnot json\n{"c": 3}\n')
    assert tail.read() == [{"b": 2}, {"c": 3}]
    assert tail.read() == []
    log.unlink()
    log.write_bytes(b'{"d": 4}\n')  # replaced (new inode, shorter): start over
    assert tail.read() == [{"d": 4}]


def test_claude_paste_wrapper_is_not_shown():
    st = State()
    text = f'\n\n<pasted_content id="4fbc">\n画布评论 #1：\n- Ann：改一下\n\n{MARKER} 来自 Agora\n</pasted_content id="4fbc">\n'
    items, turns = project("claude", {"type": "user", "uuid": "u", "timestamp": "2026-09-28T00:00:00Z", "message": {"role": "user", "content": text}}, st)
    assert items[0]["text"] == "画布评论 #1：\n- Ann：改一下" and items[0]["source"] == "agora"


def test_pi_log_of_a_terminal_session_with_forks_compactions_and_extension_entries_projects_whole():
    """IM1: a Pi session imported by hand (forked from one used in a terminal): the header with parentSession, a model change, the system
    prompt as a message, `custom` entries, a bash execution and compactions between turns — none of it may drop or hide the turns."""
    def msg(role, **k):
        return {"type": "message", "id": f"m{len(rows)}", "timestamp": f"2026-09-30T11:0{len(rows) % 10}:00.000Z", "message": {"role": role, **k}}

    rows: list[dict] = [
        {"type": "session", "version": 3, "id": "01a0f2a3", "timestamp": "2026-09-30T11:00:00.000Z", "cwd": "/p", "parentSession": "/x/old.jsonl"},
        {"type": "model_change", "id": "mc", "provider": "magpie", "modelId": "group/sonnet"},
        {"type": "thinking_level_change", "id": "tl", "thinkingLevel": "high"},
    ]
    rows.append(msg("system", content="", sections={"preamble": "你是 Pi Agent。"}))
    rows.append(msg("user", content=[{"type": "text", "text": "先了解一下这个项目"}], timestamp=1790766343339))
    rows.append(msg("assistant", content=[{"type": "text", "text": "好的，我先看看。"}, {"type": "toolCall", "id": "tc1", "name": "bash", "arguments": {"command": "ls"}}], usage={"input": 1, "output": 2}, stopReason="toolUse", timestamp=1790766343349))
    rows.append(msg("toolResult", toolCallId="tc1", toolName="bash", content=[{"type": "text", "text": "a b"}], isError=False, timestamp=1790766349138))
    rows.append(msg("assistant", content=[{"type": "text", "text": "看完了。"}], usage={"input": 1, "output": 2}, stopReason="stop", timestamp=1790766350000))
    rows.append({"type": "custom", "customType": "butler-run-summary", "id": "cu", "data": {"elapsedMs": 5}})
    rows.append(msg("bashExecution", command="git status", output="clean", exitCode=0, timestamp=1790766351000))
    rows.append({"type": "compaction", "id": "co", "summary": "## Goal\n…", "firstKeptEntryId": "m4", "tokensBefore": 1000, "systemMessage": {"role": "system", "content": ""}})
    rows.append(msg("user", content=[{"type": "text", "text": "第二个问题"}], timestamp=1790766360000))
    rows.append(msg("assistant", content=[{"type": "text", "text": "答复"}], usage={"input": 1, "output": 2}, stopReason="stop", timestamp=1790766361000))
    st = State()
    items: list[dict] = []
    turns: list[dict] = []
    for r in rows:
        its, tcs = project("pi", r, st)
        items += its
        turns += tcs
    users = [i for i in items if i["kind"] == "user"]
    assert [u["text"] for u in users] == ["先了解一下这个项目", "第二个问题"]
    assert all(u["source"] == "terminal" for u in users)
    assert [i["text"] for i in items if i["kind"] == "assistant"] == ["好的，我先看看。", "看完了。", "答复"]
    assert any(i["kind"] == "tool" and i["tool"]["name"] == "bash" for i in items)
    assert len([t for t in turns if t["turn"] == "end"]) >= 2
