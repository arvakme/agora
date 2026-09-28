"""Native sub-agents as runs (web/docs/cli-adapters.md §5): Claude's ``subagents/`` folder and Codex's
``spawn_agent`` threads become child runs of the session, linked by the CLIs' own ids; Codex guardian
threads are hidden; one level is expanded by default, deeper ones are counted."""

import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.adapters import runs
from server.canvas.adapters.base import NativeRef
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app

ROOT = "/work/p"
P = "11111111-0000-0000-0000-000000000001"


def jl(path: Path, recs: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in recs))
    return path


def ts(s: int) -> str:
    return f"2026-09-28T01:00:{s:02d}Z"


def claude_tree(home: Path, root: str = ROOT) -> Path:
    d = home / ".claude" / "projects" / agents.claude_dir_name(root)
    parent = jl(d / f"{P}.jsonl", [
        {"type": "user", "uuid": "u1", "timestamp": ts(0), "cwd": root, "message": {"content": "把两个模块各交给一个子 agent"}},
        {"type": "assistant", "uuid": "a1", "timestamp": ts(1), "cwd": root, "message": {"id": "m1", "content": [
            {"type": "tool_use", "id": "toolu_A", "name": "Agent", "input": {"description": "审 server", "subagent_type": "general-purpose", "prompt": "…"}},
            {"type": "tool_use", "id": "toolu_B", "name": "Agent", "input": {"description": "审 web", "subagent_type": "Explore", "prompt": "…", "run_in_background": True}},
        ]}},
        {"type": "user", "uuid": "r1", "timestamp": ts(9), "toolUseResult": {"status": "completed", "agentId": "aaa"}, "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_A", "content": "done"}]}},
        {"type": "user", "uuid": "r2", "timestamp": ts(2), "toolUseResult": {"isAsync": True, "status": "async_launched", "agentId": "bbb"}, "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_B", "content": "launched"}]}},
        {"type": "queue-operation", "operation": "enqueue", "timestamp": ts(20), "content": "<task-notification>\n<task-id>bbb</task-id>\n<tool-use-id>toolu_B</tool-use-id>\n<status>completed</status>\n</task-notification>"},
        {"type": "assistant", "uuid": "a2", "timestamp": ts(21), "message": {"id": "m2", "stop_reason": "end_turn", "content": [{"type": "text", "text": "都审完了"}]}},
    ])
    sub = d / P / "subagents"
    for aid, tuid, desc, extra in (("aaa", "toolu_A", "审 server", {}), ("bbb", "toolu_B", "审 web", {}), ("ccc", "toolu_C", "审 web 的测试", {"spawnDepth": 2, "parentAgentId": "bbb"})):
        (sub).mkdir(parents=True, exist_ok=True)
        (sub / f"agent-{aid}.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": desc, "toolUseId": tuid, "spawnDepth": 1, **extra}))
        jl(sub / f"agent-{aid}.jsonl", [
            {"type": "user", "uuid": f"{aid}-u", "isSidechain": True, "agentId": aid, "timestamp": ts(3), "cwd": root, "message": {"content": desc}},
            {"type": "assistant", "uuid": f"{aid}-a", "isSidechain": True, "timestamp": ts(4), "cwd": root, "message": {"id": f"{aid}-m", "content": [{"type": "tool_use", "id": f"{aid}-t", "name": "Read", "input": {"file_path": f"{root}/server/app.py"}}]}},
            {"type": "user", "uuid": f"{aid}-r", "isSidechain": True, "timestamp": ts(5), "message": {"content": [{"type": "tool_result", "tool_use_id": f"{aid}-t", "content": "x"}]}},
            {"type": "assistant", "uuid": f"{aid}-e", "isSidechain": True, "timestamp": ts(6), "message": {"id": f"{aid}-m2", "stop_reason": "end_turn", "content": [{"type": "text", "text": "ok"}]}},
        ])
    return parent


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    return h


def by_id(tree):
    return {r["id"]: r for r in tree["runs"]}


def test_claude_subagents_are_child_runs(home):
    parent = claude_tree(home)
    tree = runs.build(NativeRef("claude", P, parent, ROOT), root=ROOT, depth=1)
    r = by_id(tree)
    a, b = r[f"claude:{P}/aaa"], r[f"claude:{P}/bbb"]
    assert a["parent"]["runId"] == f"claude:{P}" and a["parent"]["via"] == "native" and a["parent"]["toolCallId"] == "toolu_A"
    assert "toolUseId" in a["parent"]["evidence"]
    assert a["state"] == "done" and b["state"] == "done"  # sync result / background notification
    assert a["label"] == "审 server" and a["role"] == "general-purpose"
    # The sidechain log projects like a session: a read of server/app.py.
    assert [(s["kind"], s.get("path")) for s in a["timeline"]["segments"]] == [("read", "server/app.py")]
    # One level expanded: the nested agent (spawnDepth 2) is counted on its parent.
    assert f"claude:{P}/ccc" not in r and b["hiddenDescendants"] == 1 and tree["folded"] == {f"claude:{P}/bbb": 1}
    moments = r[f"claude:{P}"]["timeline"]["moments"]
    assert {(m["kind"], m["childRunId"].rsplit("/", 1)[-1]) for m in moments} == {("dispatch", "aaa"), ("dispatch", "bbb"), ("handoff", "aaa"), ("handoff", "bbb")}
    full = by_id(runs.build(NativeRef("claude", P, parent, ROOT), root=ROOT, depth=None))
    assert full[f"claude:{P}/ccc"]["parent"]["runId"] == f"claude:{P}/bbb" and full[f"claude:{P}/ccc"]["depth"] == 2


def codex_rollout(home: Path, tid: str, cwd: str, source, recs: list[dict]) -> Path:
    p = home / ".codex" / "sessions" / "2026" / "09" / "28" / f"rollout-2026-09-28T01-00-00-{tid}.jsonl"
    return jl(p, [{"type": "session_meta", "timestamp": ts(0), "payload": {"id": tid, "cwd": cwd, "cli_version": "0.157.1", "source": source}}, *recs])


def sub_act(kind: str, child: str, at: int, cid: str) -> dict:
    return {"type": "event_msg", "timestamp": ts(at), "payload": {"type": "item_completed", "completed_at_ms": 1790500000000 + at * 1000, "item": {"type": "SubAgentActivity", "id": cid, "kind": kind, "agent_thread_id": child, "agent_path": "/root/audit"}}}


def codex_tree(home: Path) -> Path:
    parent = codex_rollout(home, "cx-p", ROOT, "cli", [
        {"type": "event_msg", "timestamp": ts(1), "payload": {"type": "task_started", "turn_id": "t1"}},
        sub_act("started", "cx-c1", 2, "call_1"),
        sub_act("completed", "cx-c1", 8, "subagent-completed-x"),
        {"type": "event_msg", "timestamp": ts(9), "payload": {"type": "task_complete", "turn_id": "t1", "last_agent_message": "ok"}},
    ])
    spawn = lambda parent_id, nick: {"subagent": {"thread_spawn": {"parent_thread_id": parent_id, "depth": 1, "agent_path": "/root/x", "agent_nickname": nick, "agent_role": "worker"}}}  # noqa: E731
    codex_rollout(home, "cx-c1", ROOT, spawn("cx-p", "Godel"), [sub_act("started", "cx-g1", 3, "call_g")])
    codex_rollout(home, "cx-c2", ROOT, spawn("cx-p", "Noether"), [])
    codex_rollout(home, "cx-g1", ROOT, spawn("cx-c1", "Erdos"), [])
    codex_rollout(home, "cx-guard", ROOT, {"subagent": {"other": "guardian"}}, [])
    db = home / ".codex" / "state_5.sqlite"
    con = sqlite3.connect(db)
    con.execute("create table threads (id text primary key, rollout_path text, cwd text)")
    con.execute("create table thread_spawn_edges (parent_thread_id text, child_thread_id text primary key, status text)")
    con.executemany("insert into thread_spawn_edges values (?,?,?)", [("cx-p", "cx-c1", "closed"), ("cx-p", "cx-c2", "open"), ("cx-p", "cx-guard", "open"), ("cx-c1", "cx-g1", "open")])
    con.commit()
    con.close()
    return parent


def test_codex_spawned_threads_are_child_runs_and_guardians_are_hidden(home):
    parent = codex_tree(home)
    tree = runs.build(NativeRef("codex", "cx-p", parent, ROOT), root=ROOT, depth=1, home=home)
    r = by_id(tree)
    assert set(r) == {"codex:cx-p", "codex:cx-c1", "codex:cx-c2"}  # guardian hidden, grandchild folded
    c1 = r["codex:cx-c1"]
    assert c1["label"] == "Godel" and c1["role"] == "worker" and c1["state"] == "done" and c1["parent"]["toolCallId"] == "call_1"
    assert "thread_spawn_edges" in c1["parent"]["evidence"] and "parent_thread_id" in c1["parent"]["evidence"]
    assert c1["hiddenDescendants"] == 1
    # The parent's spawn is a tool item in its trajectory too.
    assert any(s.get("spawn", {}).get("childId") == "cx-c1" for s in r["codex:cx-p"]["timeline"]["segments"])
    full = by_id(runs.build(NativeRef("codex", "cx-p", parent, ROOT), root=ROOT, depth=None, home=home))
    assert full["codex:cx-g1"]["parent"]["runId"] == "codex:cx-c1"


def test_runs_endpoint(home, tmp_path, monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)
    s = ProjectStore(tmp_path / "proj")
    s.init()
    root = str(s.root)
    claude_tree(home, root)
    s.bind("s-1", agent="claude", model="haiku", native_id=P, started=True)
    s.write("canvas", "c1", {"elements": [{"id": "api", "type": "rectangle", "customData": {"codePaths": ["server/**"]}}]}, base=None)
    c = TestClient(create_project_app(s.root))
    got = c.get("/api/agent/runs", params={"session": "s-1", "canvas": "c1", "receipts": 0}).json()
    r = by_id(got)
    assert got["root"] == f"claude:{P}" and r[f"claude:{P}"]["sessionId"] == "s-1" and r[f"claude:{P}"]["tier"] == "T1"
    assert r[f"claude:{P}/aaa"]["tier"] == "T2"
    assert r[f"claude:{P}/aaa"]["timeline"]["segments"][0]["node"] == "api"
    assert c.get("/api/agent/runs", params={"session": "nope"}).status_code == 404
    assert c.get("/api/agent/runs").status_code == 400
    assert c.get("/api/agent/runs", params={"kind": "claude", "native": P, "depth": "all", "receipts": 0}).json()["folded"] == {}


def test_glob_port_matches_the_page():
    links = [("srv", ["server/**"]), ("canvas", ["server/canvas/**"]), ("readme", ["README.md"]), ("web", ["web/{src,docs}/*.ts"])]
    assert runs.node_for("server/app.py", links) == "srv"
    assert runs.node_for("server/canvas/runner.py", links) == "canvas"
    assert runs.node_for("README.md", links) == "readme" and runs.node_for("docs/README.md", links) is None
    assert runs.node_for("web/src/a.ts", links) == "web" and runs.node_for("web/src/x/a.ts", links) is None
    assert runs.node_for("/abs/server/app.py", links) is None
    # Same as the page (codeLinks.ts specificity): a bare directory counts as a literal, so it outranks a deeper glob.
    assert runs.node_for("server/canvas/runner.py", [("bare", ["server"]), ("deep", ["server/canvas/**"])]) == "bare"


def test_claude_nested_agents_hang_under_their_parent_whatever_the_file_names(home):
    """Review P2-1: children were processed in hex file-name order, so a nested agent whose id sorts
    before its parent's was attached to the session at depth 1."""
    parent = claude_tree(home)
    sub = parent.parent / P / "subagents"
    (sub / "agent-000.meta.json").write_text(json.dumps({"agentType": "Explore", "description": "孙子", "toolUseId": "toolu_Z", "spawnDepth": 2, "parentAgentId": "zzz"}))
    (sub / "agent-000.jsonl").write_text((sub / "agent-aaa.jsonl").read_text())
    (sub / "agent-zzz.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": "儿子", "toolUseId": "toolu_Y", "spawnDepth": 1}))
    (sub / "agent-zzz.jsonl").write_text((sub / "agent-aaa.jsonl").read_text())
    r = by_id(runs.build(NativeRef("claude", P, parent, ROOT), root=ROOT, depth=None))
    assert r[f"claude:{P}/000"]["parent"]["runId"] == f"claude:{P}/zzz" and r[f"claude:{P}/000"]["depth"] == 2
    assert r[f"claude:{P}/zzz"]["depth"] == 1 and r[f"claude:{P}/zzz"]["descendants"] == 1
