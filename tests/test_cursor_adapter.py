"""Cursor (``cursor-agent``) as an observed agent (T2): its agent-transcripts are found by chat id or by
workspace, projected with inferred times (the transcript has no timestamps, ids or tool results),
classified into reads / writes / commands and Task sub-agents linked by their prompt
(web/docs/cli-adapters.md)."""

import json
import os
from datetime import datetime, timezone

import pytest

from server.canvas import adapters
from server.canvas.adapters import runs
from server.canvas.adapters.base import NativeRef
from server.canvas.adapters.common import State
from server.canvas.adapters.cursor import slug, user_time
from server.canvas.transcript import project
from tests.native_logs import cursor_end, cursor_says, cursor_subagent, cursor_text, cursor_tool, cursor_transcript, cursor_user

ROOT = "/work/p"
CHAT = "c76566fc-7d6c-4ae7-b714-868be82512cb"


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    monkeypatch.delenv("CURSOR_DATA_DIR", raising=False)
    return h


def cursor():
    return adapters.need("cursor")


def test_cursor_is_observed_only():
    a = cursor()
    assert adapters.implemented_tier(a) == "T2" and a.max_tier == "T2" and "cursor" not in adapters.session_kinds()
    assert a.times_inferred is True


def test_workspace_folder_name_is_the_clis_slug():
    # cursor-agent utils/dist/workspace-paths.js: every non-alphanumeric run → "-", trimmed.
    assert slug("/Users/zhijie/Job/agora-wt-workbench") == "Users-zhijie-Job-agora-wt-workbench"
    assert slug("/Users/z/.config/team/B-guide") == "Users-z-config-team-B-guide"
    assert slug("/private/tmp/claude-501/-Users-x/scratchpad") == "private-tmp-claude-501-Users-x-scratchpad"


def test_user_timestamp():
    at = user_time("<timestamp>Monday, Sep 28, 2026, 4:22 PM (UTC+8)</timestamp>\n<user_query>\nhi\n</user_query>")
    assert at == int(datetime(2026, 9, 28, 8, 22, tzinfo=timezone.utc).timestamp() * 1000)
    assert user_time("<timestamp>Thursday, Sep 10, 2026, 12:05 AM (UTC-5)</timestamp>") == int(datetime(2026, 9, 10, 5, 5, tzinfo=timezone.utc).timestamp() * 1000)
    assert user_time("no timestamp here") is None


@pytest.mark.parametrize(
    "name,args,want",
    [
        ("Read", {"path": "/work/p/server/app.py", "limit": 40}, ("read", ["server/app.py"], [])),
        ("ReadFile", {"path": "src/a.ts"}, ("read", ["src/a.ts"], [])),
        ("Write", {"path": "/work/p/server/cache/note.py", "contents": "x"}, ("write", [], [{"path": "server/cache/note.py", "op": "write"}])),
        ("StrReplace", {"path": "/work/p/a.py", "old_string": "a", "new_string": "b"}, ("edit", [], [{"path": "a.py", "op": "edit"}])),
        ("Delete", {"path": "/work/p/old.py"}, ("edit", [], [{"path": "old.py", "op": "delete"}])),
        ("EditNotebook", {"target_notebook": "/work/p/n.ipynb", "cell_idx": 0}, ("edit", [], [{"path": "n.ipynb", "op": "edit"}])),
        # Codex-family models write through ApplyPatch, whose input is the patch text itself.
        ("ApplyPatch", "*** Begin Patch\n*** Add File: /work/p/hello.txt\n+hi\n*** Update File: /work/p/a.py\n@@\n-x\n+y\n*** Delete File: /work/p/b.py\n*** End Patch\n",
         ("edit", [], [{"path": "hello.txt", "op": "add"}, {"path": "a.py", "op": "edit"}, {"path": "b.py", "op": "delete"}])),
        ("Shell", {"command": "sed -n 1,40p server/app.py", "working_directory": "/work/p", "description": "x"}, ("read", ["server/app.py"], [])),
        ("Shell", {"command": "cat app.py", "working_directory": "/work/p/server"}, ("read", ["server/app.py"], [])),
        ("Shell", {"command": "npm test"}, ("commands", [], [])),
        ("Bash", {"command": "cat a.py | head -5"}, ("read", ["a.py"], [])),
        ("Grep", {"pattern": "x", "path": "/work/p/server"}, ("search", [], [])),
        ("Grep", {"pattern": "x", "path": "/work/p/server/app.py"}, ("search", ["server/app.py"], [])),
        ("Glob", {"glob_pattern": "*.py", "target_directory": "/work/p"}, ("search", [], [])),
        ("TodoWrite", {"todos": []}, ("plan", [], [])),
        ("WebFetch", {"url": "https://example.com"}, ("webFetch", [], [])),
        ("WebSearch", {"search_term": "x"}, ("webSearch", [], [])),
        ("CallDynamicTool", {"toolName": "x", "arguments": {}}, ("tools", [], [])),
    ],
)
def test_tool_vocabulary(name, args, want):
    facts = cursor().classify(name, args, ROOT)
    assert (facts["activity"], facts.get("reads", []), facts.get("files", [])) == want


def test_questions_and_subagents():
    a = cursor()
    q = a.classify("AskQuestion", {"questions": [{"prompt": "ok?"}]}, ROOT)
    assert q["activity"] == "questions" and q["waitsUser"] is True
    t = a.classify("Task", {"description": "审 server", "prompt": "…", "subagent_type": "generalPurpose"}, ROOT)
    assert t["activity"] == "subagents" and t["spawn"] == {"childKind": "cursor", "via": "native", "role": "generalPurpose"}


def run_turns(home):
    return cursor_transcript(home, ROOT, CHAT, [
        cursor_user("Read alpha.txt and beta.txt, write gamma.txt"),
        cursor_says(cursor_text("reading"), cursor_tool("Read", {"path": f"{ROOT}/alpha.txt"}), cursor_tool("Shell", {"command": "cat beta.txt", "working_directory": ROOT})),
        cursor_says(cursor_tool("Write", {"path": f"{ROOT}/gamma.txt", "contents": "alpha beta"})),
        cursor_says(cursor_text("done")),
        cursor_end(),
        {"role": "user", "message": {"content": [{"type": "text", "text": "<available_subagent_types>\nexplore\n</available_subagent_types>"}]}},
        cursor_user("again", ts="Monday, Sep 28, 2026, 4:30 PM (UTC+8)"),
        cursor_says(cursor_tool("Read", {"path": f"{ROOT}/gamma.txt"})),
        cursor_end("error", "rate limited"),
    ])


def test_projection_with_inferred_times(home):
    log = run_turns(home)
    t1 = int(datetime(2026, 9, 28, 8, 22, tzinfo=timezone.utc).timestamp())
    os.utime(log, (t1 + 600, t1 + 600))  # last written 10 minutes later
    recs = cursor().read_records(log)
    ats = [r["_at"] for r in recs]
    assert ats == sorted(ats) and ats[0] == t1 * 1000 and ats[-1] <= (t1 + 600) * 1000
    st = State(root=ROOT)
    items: dict[str, dict] = {}
    turns = []
    for r in recs:
        its, tcs = project("cursor", r, st)
        turns += tcs
        for it in its:
            items[it["id"]] = {**items.get(it["id"], {}), **it}
    kinds = [i["kind"] for i in items.values()]
    assert kinds.count("user") == 2  # the context block is not a turn
    tools = [i for i in items.values() if i["kind"] == "tool"]
    assert [(t["tool"]["activity"], t["tool"].get("reads"), t["tool"].get("files")) for t in tools] == [
        ("read", ["alpha.txt"], None),
        ("read", ["beta.txt"], None),
        ("write", None, [{"path": "gamma.txt", "op": "write"}]),
        ("read", ["gamma.txt"], None),
    ]
    assert all(t["endAt"] >= t["at"] for t in tools)
    ends = [i for i in items.values() if i["kind"] == "end"]
    assert len(ends) == 2 and "error" not in ends[0] and ends[1]["error"] == "rate limited"
    second = [i for i in items.values() if i["kind"] == "user"][1]
    assert second["at"] == int(datetime(2026, 9, 28, 8, 30, tzinfo=timezone.utc).timestamp() * 1000) and second["text"] == "again"
    tl = runs.timeline("cursor", log, ROOT)
    assert tl["timesInferred"] is True
    assert [(s["kind"], s.get("path")) for s in tl["segments"]] == [("read", "alpha.txt"), ("read", "beta.txt"), ("write", "gamma.txt"), ("read", "gamma.txt")]


def test_drift_counts_unknown_block_types():
    a = cursor()
    assert a.record_type(cursor_says(cursor_text("x"), cursor_tool("Read", {}))) == "assistant"
    assert a.record_type(cursor_end()) == "turn_ended"
    assert a.record_type(cursor_says({"type": "thinking", "thinking": "…"})) == "assistant/thinking"
    assert "assistant/thinking" not in a.known_types


def test_locate_by_chat_id(home, tmp_path):
    a = cursor()
    other = str(tmp_path / "elsewhere")
    mine = cursor_transcript(home, ROOT, CHAT, [cursor_user("hi")])
    cursor_transcript(home, other, CHAT, [cursor_user("resumed in another directory: an empty copy")])
    assert a.locate(CHAT, ROOT, home).path == mine  # the workspace's own copy
    assert a.locate(CHAT, None, home).state == "ambiguous"
    sdk = cursor_transcript(home, ROOT, "agent-5033b7d3-8411-4794-8519-cd15a49f38e7", [cursor_user("sdk agent")])
    assert a.locate("agent-5033b7d3-8411-4794-8519-cd15a49f38e7", None, home).path == sdk
    for bad in ("../x", "*", "", None, "a/b"):
        assert a.locate(bad, ROOT, home).state == "missing"
    rows = a.sessions_for([ROOT], home)
    assert sorted(r["nativeId"] for r in rows) == sorted([CHAT, "agent-5033b7d3-8411-4794-8519-cd15a49f38e7"]) and all(r["agent"] == "cursor" and r["cwd"] == ROOT for r in rows)


def test_log_cwd_comes_from_the_workspace_trust_record(home):
    a = cursor()
    log = cursor_transcript(home, ROOT, CHAT, [cursor_user("hi")])
    assert a.log_cwd(log) is None  # the folder name alone is lossy
    (log.parents[2] / ".workspace-trusted").write_text(json.dumps({"trustedAt": "2026-09-28T08:22:00Z", "workspacePath": ROOT}))
    assert a.log_cwd(log) == ROOT


def test_task_subagents_are_linked_by_their_prompt(home):
    log = cursor_transcript(home, ROOT, CHAT, [
        cursor_user("two reviews"),
        cursor_says(cursor_tool("Task", {"description": "审 server", "prompt": "Review server/", "subagent_type": "explore", "run_in_background": True}),
                    cursor_tool("Task", {"description": "审 web", "prompt": "Review web/", "subagent_type": "generalPurpose"})),
        cursor_says(cursor_text("both done")),
        cursor_end(),
    ])
    # Children are listed in file order, not call order: the prompt decides which call started which.
    cursor_subagent(log, "aaa-web", [cursor_user("Review web/"), cursor_says(cursor_tool("Read", {"path": f"{ROOT}/web/app.ts"})), cursor_end()])
    cursor_subagent(log, "bbb-server", [cursor_user("Review server/"), cursor_says(cursor_tool("Read", {"path": f"{ROOT}/server/app.py"}))])
    a = cursor()
    kids = {k.native_id: k for k in a.children(NativeRef("cursor", CHAT, log, ROOT), home)}
    assert set(kids) == {"aaa-web", "bbb-server"}
    ids = [i["id"] for i in runs.timeline("cursor", log, ROOT)["items"] if i["kind"] == "tool"]
    assert kids["aaa-web"].parent.tool_call_id == ids[1] and kids["bbb-server"].parent.tool_call_id == ids[0]
    assert kids["aaa-web"].parent.via == "native" and "subagents/" in kids["aaa-web"].parent.evidence
    assert kids["aaa-web"].label == "审 web" and kids["aaa-web"].meta["role"] == "generalPurpose" and kids["aaa-web"].meta["state"] == "done"
    assert kids["bbb-server"].meta["state"] is None  # no turn_ended yet
    tree = runs.build(NativeRef("cursor", CHAT, log, ROOT), root=ROOT, home=home)
    r = {x["id"]: x for x in tree["runs"]}
    assert r["cursor:aaa-web"]["depth"] == 1 and [(s["kind"], s.get("path")) for s in r["cursor:aaa-web"]["timeline"]["segments"]] == [("read", "web/app.ts")]
    assert {(m["kind"], m["childRunId"]) for m in r[f"cursor:{CHAT}"]["timeline"]["moments"]} >= {("dispatch", "cursor:aaa-web"), ("dispatch", "cursor:bbb-server")}
