"""Server-side tool facts (web/docs/cli-adapters.md §3): every tool item says its ``activity``, the
files it ``reads``, whether it ``waitsUser`` and whether it ``spawn``s an agent — so the page no
longer needs to know any CLI's tool names."""

import pytest

from server.canvas.adapters.tools import activity_of, shell_reads, spawn_in_output
from server.canvas.transcript import State, project

ROOT = "/work/p"


def tool_items(kind, recs, root=ROOT):
    st = State(root=root)
    items = {}
    for r in recs:
        for it in project(kind, r, st)[0]:
            if it["kind"] == "tool":
                prev = items.get(it["id"], {})
                items[it["id"]] = {**prev, **it, "tool": {**prev.get("tool", {}), **it["tool"]}}
    return list(items.values())


@pytest.mark.parametrize(
    "cmd,want",
    [
        ("cat src/a.py", ("read", ["src/a.py"])),
        ("sed -n '1,72p' src/telegram/butler.js", ("read", ["src/telegram/butler.js"])),
        ("rtk read /work/p/docs/x.md", ("read", ["docs/x.md"])),
        ("nl -ba server/x.py | sed -n 1,40p", ("read", ["server/x.py"])),
        ("head -n 20 README.md | tail -5", ("read", ["README.md"])),
        ("rg -n 'a|b' src/x.ts docs", ("search", ["src/x.ts"])),
        ("cd web && cat package.json", ("read", ["web/package.json"])),
        ("cat a.py && npm test", ("commands", ["a.py"])),
        ("sed -i s/a/b/ f.txt", ("commands", [])),
        ("python3 - <<'PY'\ncat = 1\nPY\ncat z.txt", ("commands", ["z.txt"])),
        ("ls -la", ("search", [])),
        ("", (None, [])),
    ],
)
def test_shell_reads(cmd, want):
    assert shell_reads(cmd, ROOT, ROOT) == want


def test_seedmux_dispatch_in_output():
    out = "ok\ntask=T-5ee5fa pane=a5d548ff-0d58-4406-bdd0-bd1f40810cb3\n"
    assert spawn_in_output(out, "~/.local/bin/smx-team spawn --agent devin") == {"taskId": "T-5ee5fa", "pane": "A5D548FF-0D58-4406-BDD0-BD1F40810CB3", "via": "seedmux"}
    assert spawn_in_output(out, ["/bin/zsh", "-lc", "smx-team assign --to X"])["taskId"] == "T-5ee5fa"
    # The same line printed by something else (a grep of old logs) is not a dispatch.
    assert spawn_in_output(out, "rg task= ~/.claude/projects") is None and spawn_in_output(out) is None
    assert spawn_in_output("task=T-1 pane=nope", "smx-team spawn") is None


def test_activity_fallback_covers_every_cli_name():
    assert activity_of("apply_patch") == activity_of("search_replace") == "edit"
    assert activity_of("run_terminal_command") == activity_of("exec_command") == "commands"
    assert activity_of("spawn_subagent") == activity_of("Agent") == "subagents"
    assert activity_of("AskUserQuestion") == activity_of("request_user_input") == "questions"
    assert activity_of("some_mcp_tool") == "tools"


def claude_use(tid, name, inp, cwd=ROOT):
    return {"type": "assistant", "uuid": f"u-{tid}", "cwd": cwd, "timestamp": "2026-09-28T01:00:00Z", "message": {"id": f"m-{tid}", "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def claude_result(tid, text, extra=None):
    return {"type": "user", "uuid": f"r-{tid}", "timestamp": "2026-09-28T01:00:01Z", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": text}]}, **(extra or {})}


def test_claude_tool_facts():
    items = tool_items("claude", [
        claude_use("t1", "Read", {"file_path": "/work/p/src/a.py"}),
        claude_use("t2", "Bash", {"command": "sed -n 1,20p server/x.py"}),
        claude_use("t3", "AskUserQuestion", {"questions": []}),
        claude_use("t4", "Agent", {"subagent_type": "general-purpose", "prompt": "x"}),
        claude_result("t4", "launched", {"toolUseResult": {"isAsync": True, "status": "async_launched", "agentId": "a8e4"}}),
        claude_use("t5", "Bash", {"command": "smx-team spawn --agent devin"}),
        claude_result("t5", "task=T-19c9ab pane=FDC89E5E-61FD-454D-A822-C01693AE47F2"),
        claude_use("t6", "Edit", {"file_path": "/work/p/b.py"}),
    ])
    by = {i["id"]: i["tool"] for i in items}
    assert by["t1"]["activity"] == "read" and by["t1"]["reads"] == ["src/a.py"]
    assert by["t2"]["activity"] == "read" and by["t2"]["reads"] == ["server/x.py"]
    assert by["t3"]["activity"] == "questions" and by["t3"]["waitsUser"] is True
    assert by["t4"]["activity"] == "subagents" and by["t4"]["spawn"] == {"childKind": "claude", "childId": "a8e4", "via": "native", "state": "async_launched"}
    assert by["t5"]["spawn"]["taskId"] == "T-19c9ab" and by["t5"]["activity"] == "commands"
    assert by["t6"]["activity"] == "edit" and by["t6"]["files"] == [{"path": "b.py", "op": "edit"}]


def test_codex_reads_through_the_shell():
    def cmd(iid, command, parsed, out=""):
        return {"type": "event_msg", "timestamp": "2026-09-28T01:00:00Z", "payload": {"type": "item_completed", "item": {"type": "CommandExecution", "id": iid, "command": ["/bin/zsh", "-lc", command], "cwd": "file:///work/p", "parsed_cmd": parsed, "exit_code": 0, "aggregated_output": out}}}

    items = tool_items("codex", [
        cmd("c1", "sed -n '1,72p' src/telegram/butler.js", [{"type": "read", "cmd": "sed -n '1,72p' src/telegram/butler.js", "name": "butler.js", "path": "src/telegram/butler.js"}]),
        cmd("c2", "rtk read /work/p/docs/a.md", [{"type": "unknown", "cmd": "rtk read /work/p/docs/a.md"}]),
        cmd("c3", "rg foo src", [{"type": "search", "cmd": "rg foo src", "query": "foo", "path": "src"}]),
        cmd("c4", "cat x.py", []),
        cmd("c5", "smx-team spawn --agent devin --cwd .", [{"type": "unknown", "cmd": "smx-team spawn --agent devin --cwd ."}], out="task=T-aaaaaa pane=FDC89E5E-61FD-454D-A822-C01693AE47F2"),
        cmd("c6", "cat old.log", [{"type": "read", "cmd": "cat old.log", "name": "old.log", "path": "old.log"}], out="task=T-bbbbbb pane=FDC89E5E-61FD-454D-A822-C01693AE47F2"),
    ])
    by = {i["id"]: i["tool"] for i in items}
    assert (by["c1"]["activity"], by["c1"]["reads"]) == ("read", ["src/telegram/butler.js"])
    assert (by["c2"]["activity"], by["c2"]["reads"]) == ("read", ["docs/a.md"])
    assert by["c3"]["activity"] == "search" and "reads" not in by["c3"]
    assert (by["c4"]["activity"], by["c4"]["reads"]) == ("read", ["x.py"])
    assert by["c5"]["activity"] == "commands" and by["c5"]["spawn"]["taskId"] == "T-aaaaaa"
    assert "spawn" not in by["c6"]  # printing an old dispatch line is not a dispatch


def test_pi_tool_facts():
    rec = {"type": "message", "id": "m1", "timestamp": "2026-09-28T01:00:00Z", "message": {"role": "assistant", "content": [
        {"type": "toolCall", "id": "p1", "name": "read", "arguments": {"path": "src/a.ts"}},
        {"type": "toolCall", "id": "p2", "name": "bash", "arguments": {"command": "cat /work/p/b.md"}},
        {"type": "toolCall", "id": "p3", "name": "edit", "arguments": {"path": "c.ts"}},
    ]}}
    by = {i["id"]: i["tool"] for i in tool_items("pi", [rec])}
    assert (by["p1"]["activity"], by["p1"]["reads"]) == ("read", ["src/a.ts"])
    assert (by["p2"]["activity"], by["p2"]["reads"]) == ("read", ["b.md"])
    assert by["p3"]["activity"] == "edit" and by["p3"]["files"] == [{"path": "c.ts", "op": "edit"}]
