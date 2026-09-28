"""Seedmux tickets as receipts (T3): read-only, only this project's tickets, the unified state
mapping, and the parent links (the parent's own ``task=T-xx pane=…`` output, then
``meta.from_pane``, then cwd + time window)."""

import json
import time
from pathlib import Path

import pytest

from server.canvas import agents
from server.canvas.adapters import receipts, runs
from server.canvas.adapters.base import NativeRef
from server.canvas.project import ProjectStore
from server.canvas.terminal import Terminals

P = "22222222-0000-0000-0000-000000000001"
W = "33333333-0000-0000-0000-000000000009"
PANE_W = "FDC89E5E-61FD-454D-A822-C01693AE47F2"
PANE_ME = "A5D548FF-0D58-4406-BDD0-BD1F40810CB3"


@pytest.mark.parametrize(
    "status,state,extra,want",
    [
        ("replied:done", "reply_unconfirmed", {}, "done"),
        ("replied:blocked", None, {}, "blocked"),
        ("replied:unknown", None, {}, "unknown"),
        ("dispatched", "awaiting_ack", {}, "dispatched"),
        ("dispatched", "ack_overdue", {}, "dispatched"),
        ("dispatched", "running_observed", {}, "running"),
        ("dispatched", "waiting", {}, "waiting"),
        ("dispatched", "idle_without_reply", {}, "idle_no_reply"),
        ("dispatched", "exited_without_reply", {}, "exited"),
        ("dispatched", "session_changed", {}, "session_changed"),
        ("dispatched", "unknown", {}, "unknown"),
        ("dispatched", "reply_unconfirmed", {}, "unknown"),
        ("dispatched", "", {"ack_at": 1.0}, "acknowledged"),
        ("dispatched", None, {}, "unknown"),  # old, no delivery record: never guessed as running
    ],
)
def test_unified_state(status, state, extra, want):
    delivery = None if state is None else {"state": state, **extra}
    assert receipts.unified_state({"status": status, "created_at": time.time() - 3600}, delivery) == want


def test_fresh_dispatch_without_delivery_record_is_dispatched():
    assert receipts.unified_state({"status": "dispatched", "created_at": time.time() - 5}, None) == "dispatched"


def ticket(base: Path, tid: str, meta: dict, delivery: dict | None = None, reply: str | None = None) -> Path:
    d = base / tid
    d.mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps({"task": tid, **meta, "noise": {"hosts": "add keys"}}))
    (d / "prompt.md").write_text("private prompt: not read")
    if delivery is not None:
        (d / "delivery.json").write_text(json.dumps(delivery))
    if reply is not None:
        (d / "reply.md").write_text(reply)
    return d


def jl(path: Path, recs: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in recs))
    return path


@pytest.fixture()
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("AGORA_SEEDMUX_PANES", "0")  # never talk to a real Seedmux in tests
    monkeypatch.setattr(receipts, "_panes", None)
    monkeypatch.setattr(receipts, "_workers", {})
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)
    s = ProjectStore(tmp_path / "proj")
    s.init()
    tasks = home / ".seedmux" / "team" / "tasks"
    monkeypatch.setenv("AGORA_SEEDMUX_TASKS", str(tasks))
    return home, s, tasks


def iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + "Z"


def test_workers_link_to_the_session_that_dispatched_them(env):
    home, s, tasks = env
    root = str(s.root)
    t0 = time.time() - 600
    d = home / ".claude" / "projects" / agents.claude_dir_name(root)
    jl(d / f"{P}.jsonl", [
        {"type": "user", "uuid": "u1", "timestamp": iso(t0), "cwd": root, "message": {"content": "派两个 worker"}},
        {"type": "assistant", "uuid": "a1", "timestamp": iso(t0 + 1), "cwd": root, "message": {"id": "m1", "content": [{"type": "tool_use", "id": "toolu_S", "name": "Bash", "input": {"command": "smx-team spawn --agent claude --cwd ."}}]}},
        {"type": "user", "uuid": "r1", "timestamp": iso(t0 + 2), "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_S", "content": f"task=T-aaa111 pane={PANE_W}"}]}},
        {"type": "assistant", "uuid": "a2", "timestamp": iso(t0 + 300), "message": {"id": "m2", "stop_reason": "end_turn", "content": [{"type": "text", "text": "派好了"}]}},
    ])
    # The worker (a Claude session Seedmux knows the sid of) wrote a file.
    jl(d / f"{W}.jsonl", [
        {"type": "user", "uuid": "wu", "timestamp": iso(t0 + 5), "cwd": root, "message": {"content": "[team-task from=claude@A5D5 task=T-aaa111] 新任务"}},
        {"type": "assistant", "uuid": "wa", "timestamp": iso(t0 + 6), "cwd": root, "message": {"id": "wm", "content": [{"type": "tool_use", "id": "wt", "name": "Edit", "input": {"file_path": f"{root}/server/app.py"}}]}},
    ])
    s.bind("s-1", agent="claude", model="haiku", native_id=P, started=True)
    (s.run_dir / "seedmux").mkdir(parents=True, exist_ok=True)
    (s.run_dir / "seedmux" / f"{Terminals.name('s-1')}.json").write_text(json.dumps({"paneId": PANE_ME, "at": t0}))
    ticket(tasks, "T-aaa111", {"from_pane": PANE_ME, "to_pane": PANE_W, "agent": "claude", "cwd": root, "created_at": t0 + 2, "status": "replied:done", "replied_at": t0 + 200, "verify": {"accept": "ok", "changed": ["server/app.py"]}},
           {"state": "reply_unconfirmed", "sid": W, "native": {"agent": "claude", "sid": W}}, "改好了 server/app.py\n细节…")
    ticket(tasks, "T-bbb222", {"from_pane": PANE_ME, "to_pane": "B" * 8 + "-0000-0000-0000-000000000000", "agent": "devin", "cwd": f"{root}/web", "created_at": t0 + 30, "status": "dispatched"},
           {"state": "running_observed", "native": {"agent": "", "sid": ""}})
    ticket(tasks, "T-ccc333", {"from_pane": "", "agent": "codex", "cwd": root, "created_at": t0 + 60, "status": "replied:failed", "replied_at": t0 + 90})
    ticket(tasks, "T-ddd444", {"from_pane": PANE_ME, "agent": "claude", "cwd": "/somewhere/else", "created_at": t0 + 10, "status": "replied:done"})
    ticket(tasks, "T-eee555", {"from_pane": "", "agent": "codex", "cwd": root, "created_at": t0 - 86400, "status": "replied:done"})  # long before: not this session's

    look = agents.locate_log("claude", P, root)
    tree = runs.build(NativeRef("claude", P, look.path, root), root=root, session_id="s-1", store=s, depth=1)
    r = {x["id"]: x for x in tree["runs"]}

    w = r[f"claude:{W}"]  # 1. the parent's own dispatch output, and the worker's log via the sid
    assert w["parent"] == {"runId": f"claude:{P}", "via": "seedmux", "toolCallId": "toolu_S", "taskId": "T-aaa111", "evidence": f"父会话日志里 smx-team 打印的 task=T-aaa111 pane={PANE_W}；worker 会话 33333333 来自 delivery.json"}
    assert w["state"] == "done" and w["receipt"]["accept"] == "ok" and w["receipt"]["changed"] == ["server/app.py"] and w["receipt"]["replyPreview"] == "改好了 server/app.py"
    assert [(x["kind"], x.get("path")) for x in w["timeline"]["segments"]] == [("write", "server/app.py")]

    dv = r["smx:T-bbb222"]  # 2. from_pane is the pane holding the session; no sid → receipts only
    assert dv["tier"] == "T3" and dv["kind"] == "devin" and dv["state"] == "running" and dv["parent"]["via"] == "seedmux" and "from_pane" in dv["parent"]["evidence"]
    assert dv["worktree"] == f"{root}/web"

    cx = r["smx:T-ccc333"]  # 3. only cwd + time window
    assert cx["parent"]["via"] == "inferred" and cx["state"] == "failed"
    assert "smx:T-ddd444" not in r and "smx:T-eee555" not in r

    moments = r[f"claude:{P}"]["timeline"]["moments"]
    assert {(m["kind"], m.get("taskId")) for m in moments} >= {("dispatch", "T-aaa111"), ("handoff", "T-aaa111"), ("dispatch", "T-bbb222"), ("dispatch", "T-ccc333")}


def test_receipts_can_be_left_out(env):
    home, s, tasks = env
    ticket(tasks, "T-ggg777", {"from_pane": "", "agent": "codex", "cwd": str(s.root), "created_at": time.time(), "status": "dispatched"})
    d = home / ".claude" / "projects" / agents.claude_dir_name(str(s.root))
    log = jl(d / f"{P}.jsonl", [{"type": "user", "uuid": "u1", "timestamp": iso(time.time() - 5), "cwd": str(s.root), "message": {"content": "hi"}}])
    with_ = runs.build(NativeRef("claude", P, log, str(s.root)), root=str(s.root), store=s)
    assert [r["id"] for r in with_["runs"]] == [f"claude:{P}", "smx:T-ggg777"] and with_["runs"][1]["state"] == "dispatched"
    without = runs.build(NativeRef("claude", P, log, str(s.root)), root=str(s.root), store=s, receipts=False)
    assert [r["id"] for r in without["runs"]] == [f"claude:{P}"]


def test_workers_of_workers_and_their_sub_agents(env):
    """The main session dispatches a Codex worker (sid known); the worker spawns a native sub-agent
    and dispatches a Grok worker from its own pane: all of it is one tree (the Grok worker's session
    is not on this machine → receipt only)."""
    home, s, tasks = env
    root = str(s.root)
    t0 = time.time() - 900
    d = home / ".claude" / "projects" / agents.claude_dir_name(root)
    main = jl(d / f"{P}.jsonl", [
        {"type": "user", "uuid": "u1", "timestamp": iso(t0), "cwd": root, "message": {"content": "派一个 codex"}},
        {"type": "assistant", "uuid": "a1", "timestamp": iso(t0 + 1), "cwd": root, "message": {"id": "m1", "content": [{"type": "tool_use", "id": "toolu_S", "name": "Bash", "input": {"command": "smx-team spawn --agent codex"}}]}},
        {"type": "user", "uuid": "r1", "timestamp": iso(t0 + 2), "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_S", "content": f"task=T-c0dex1 pane={PANE_W}"}]}},
    ])
    cx = home / ".codex" / "sessions" / "2026" / "09" / "28"
    ms = lambda s_: int((t0 + s_) * 1000)  # noqa: E731
    jl(cx / "rollout-2026-09-28T01-00-00-cx-worker.jsonl", [
        {"type": "session_meta", "timestamp": iso(t0 + 3), "payload": {"id": "cx-worker", "cwd": root, "cli_version": "0.157.1", "source": "cli"}},
        {"type": "event_msg", "timestamp": iso(t0 + 4), "payload": {"type": "task_started", "turn_id": "t1"}},
        {"type": "event_msg", "timestamp": iso(t0 + 5), "payload": {"type": "item_completed", "completed_at_ms": ms(5), "item": {"type": "CollabAgentToolCall", "id": "exec-spawn", "tool": "spawn_agent", "status": "completed", "receiver_thread_ids": ["cx-sub"], "receiver_agents": [{"thread_id": "cx-sub", "agent_nickname": "Parfit"}], "prompt": "写 a.py", "agents_states": {"cx-sub": "pending_init"}}}},
        {"type": "event_msg", "timestamp": iso(t0 + 9), "payload": {"type": "item_completed", "completed_at_ms": ms(9), "item": {"type": "CollabAgentToolCall", "id": "exec-wait", "tool": "wait", "status": "completed", "receiver_thread_ids": ["cx-sub"], "agents_states": {"cx-sub": {"completed": "done"}}}}},
    ])
    jl(cx / "rollout-2026-09-28T01-00-05-cx-sub.jsonl", [
        {"type": "session_meta", "timestamp": iso(t0 + 5), "payload": {"id": "cx-sub", "cwd": root, "source": {"subagent": {"thread_spawn": {"parent_thread_id": "cx-worker", "depth": 1, "agent_nickname": "Parfit"}}}}},
        {"type": "event_msg", "timestamp": iso(t0 + 6), "payload": {"type": "item_completed", "completed_at_ms": ms(6), "item": {"type": "FileChange", "id": "fc1", "status": "completed", "changes": {f"{root}/a.py": {"type": "add", "content": "x"}}}}},
    ])
    ticket(tasks, "T-c0dex1", {"from_pane": PANE_ME, "to_pane": PANE_W, "agent": "codex", "cwd": root, "created_at": t0 + 2, "status": "replied:done", "replied_at": t0 + 100}, {"state": "replied:done", "sid": "cx-worker"})
    ticket(tasks, "T-9r0k01", {"from_pane": PANE_W, "to_pane": "C" * 8 + "-0000-0000-0000-000000000000", "agent": "grok", "cwd": root, "created_at": t0 + 20, "status": "dispatched"}, {"state": "waiting", "sid": "grok-sid-1"})
    tree = runs.build(NativeRef("claude", P, main, root), root=root, store=s)
    r = {x["id"]: x for x in tree["runs"]}
    w, sub, g = r["codex:cx-worker"], r["codex:cx-sub"], r["smx:T-9r0k01"]
    assert w["parent"]["runId"] == f"claude:{P}" and w["receipt"]["taskId"] == "T-c0dex1" and w["depth"] == 1
    assert sub["parent"] == {"runId": "codex:cx-worker", "via": "native", "toolCallId": "exec-spawn", "evidence": sub["parent"]["evidence"]} and sub["depth"] == 2
    assert [(x["kind"], x.get("path")) for x in sub["timeline"]["segments"]] == [("write", "a.py")]
    assert g["parent"]["runId"] == "codex:cx-worker" and "to_pane" in g["parent"]["evidence"]
    assert g["tier"] == "T3" and g["kind"] == "grok" and g["state"] == "waiting"  # no log for its sid: receipt only
    assert r[f"claude:{P}"]["descendants"] == 3 and w["descendants"] == 2 and w["childCount"] == 2
    assert {(m["kind"], m.get("childRunId")) for m in w["timeline"]["moments"]} >= {("dispatch", "codex:cx-sub"), ("handoff", "codex:cx-sub"), ("dispatch", "smx:T-9r0k01")}


def test_reads_only_core_files(env):
    home, s, tasks = env
    d = ticket(tasks, "T-fff666", {"agent": "grok", "cwd": str(s.root), "created_at": 1.0, "status": "replied:done"}, {"state": "replied:done", "sid": "g-1"}, "ok")
    t = receipts.read_ticket(d)
    assert set(t["meta"]) <= set(receipts.META_KEYS) and "noise" not in t["meta"]
    assert "prompt" not in json.dumps(t)
    assert [x["meta"]["task"] for x in receipts.tickets(str(s.root))] == ["T-fff666"]


# ——— review P1-1: Seedmux reuses panes ———
def main_log(home, root, t0, extra=()):
    d = home / ".claude" / "projects" / agents.claude_dir_name(root)
    return jl(d / f"{P}.jsonl", [
        {"type": "user", "uuid": "u1", "timestamp": iso(t0), "cwd": root, "message": {"content": "编排"}},
        *extra,
        {"type": "assistant", "uuid": "a9", "timestamp": iso(t0 + 600), "message": {"id": "m9", "stop_reason": "end_turn", "content": [{"type": "text", "text": "ok"}]}},
    ])


def dispatch(tid, pane, at, tu):
    return [
        {"type": "assistant", "uuid": f"a-{tu}", "timestamp": iso(at), "message": {"id": f"m-{tu}", "content": [{"type": "tool_use", "id": tu, "name": "Bash", "input": {"command": "smx-team spawn --agent claude"}}]}},
        {"type": "user", "uuid": f"r-{tu}", "timestamp": iso(at + 1), "message": {"content": [{"type": "tool_result", "tool_use_id": tu, "content": f"task={tid} pane={pane}"}]}},
    ]


def test_pane_sid_is_used_only_for_the_panes_latest_unreplied_ticket_and_only_inside_the_project(env, monkeypatch):
    home, s, tasks = env
    root = str(s.root)
    t0 = time.time() - 3600
    other_sid = "66666666-0000-0000-0000-000000000001"
    # The pane's current session belongs to ANOTHER project.
    d = home / ".claude" / "projects" / agents.claude_dir_name("/other/project")
    jl(d / f"{other_sid}.jsonl", [{"type": "user", "uuid": "o", "timestamp": iso(t0), "cwd": "/other/project", "message": {"content": "other project's secret"}}])
    monkeypatch.setattr(receipts, "panes", lambda: {PANE_W: {"sid": other_sid, "agent": "claude"}})
    log = main_log(home, root, t0, [*dispatch("T-old001", PANE_W, t0 + 10, "tu1"), *dispatch("T-new002", PANE_W, t0 + 100, "tu2")])
    # Old ticket on the pane (replied, no sid in delivery) and the latest one (not replied, no sid).
    ticket(tasks, "T-old001", {"from_pane": "", "to_pane": PANE_W, "agent": "claude", "cwd": root, "created_at": t0 + 10, "status": "replied:done", "replied_at": t0 + 50}, {"state": "replied:done"})
    ticket(tasks, "T-new002", {"from_pane": "", "to_pane": PANE_W, "agent": "claude", "cwd": root, "created_at": t0 + 100, "status": "dispatched"}, {"state": "running_observed"})
    tree = runs.build(NativeRef("claude", P, log, root), root=root, store=s, with_items=True)
    r = {x["id"]: x for x in tree["runs"]}
    assert f"claude:{other_sid}" not in r and "secret" not in json.dumps(tree)
    assert "smx:T-old001" in r  # replied: never takes the pane's current sid
    assert "smx:T-new002" in r and "不在这个项目里" in r["smx:T-new002"]["parent"]["evidence"]
    # A later ticket on the same pane from another project makes T-new002 no longer the latest: no /panes lookup at all.
    ticket(tasks, "T-else03", {"to_pane": PANE_W, "agent": "claude", "cwd": "/other/project", "created_at": t0 + 200, "status": "dispatched"})
    scan = receipts.Scan(root)
    assert not scan.latest_on_pane(receipts.receipt(receipts.read_ticket(tasks / "T-new002")))


def test_from_pane_links_only_while_that_worker_held_the_pane(env):
    home, s, tasks = env
    root = str(s.root)
    t0 = time.time() - 3600
    log = main_log(home, root, t0, dispatch("T-w00001", PANE_W, t0 + 10, "tu1"))
    ticket(tasks, "T-w00001", {"to_pane": PANE_W, "agent": "devin", "cwd": root, "created_at": t0 + 10, "status": "replied:done", "replied_at": t0 + 100})
    # Dispatched from that pane while the worker held it → its child; long after it replied → not.
    ticket(tasks, "T-in0002", {"from_pane": PANE_W, "to_pane": PANE_ME, "agent": "codex", "cwd": root, "created_at": t0 + 50, "status": "dispatched"})
    ticket(tasks, "T-late03", {"from_pane": PANE_W, "agent": "codex", "cwd": root, "created_at": t0 + 3000, "status": "dispatched"})
    r = {x["id"]: x for x in runs.build(NativeRef("claude", P, log, root), root=root, store=s)["runs"]}
    assert r["smx:T-in0002"]["parent"]["runId"] == "smx:T-w00001"
    assert "smx:T-late03" not in r


def test_one_worker_session_serving_several_tickets_keeps_every_receipt(env):
    home, s, tasks = env
    root = str(s.root)
    t0 = time.time() - 3600
    log = main_log(home, root, t0, [*dispatch("T-one001", PANE_W, t0 + 10, "tu1"), *dispatch("T-two002", PANE_W, t0 + 200, "tu2")])
    d = home / ".claude" / "projects" / agents.claude_dir_name(root)
    jl(d / f"{W}.jsonl", [{"type": "user", "uuid": "wu", "timestamp": iso(t0 + 11), "cwd": root, "message": {"content": "T-one001"}}])
    ticket(tasks, "T-one001", {"to_pane": PANE_W, "agent": "claude", "cwd": root, "created_at": t0 + 10, "status": "replied:done", "replied_at": t0 + 100}, {"sid": W})
    ticket(tasks, "T-two002", {"to_pane": PANE_W, "agent": "claude", "cwd": root, "created_at": t0 + 200, "status": "replied:blocked", "replied_at": t0 + 300, "resume_session": W}, {"sid": W})
    r = {x["id"]: x for x in runs.build(NativeRef("claude", P, log, root), root=root, store=s)["runs"]}
    w = r[f"claude:{W}"]
    assert [x["taskId"] for x in w["receipts"]] == ["T-one001", "T-two002"] and w["receipt"]["taskId"] == "T-two002" and w["state"] == "blocked"
    ms = [(m["kind"], m.get("taskId")) for m in r[f"claude:{P}"]["timeline"]["moments"]]
    assert ("dispatch", "T-one001") in ms and ("dispatch", "T-two002") in ms and ("handoff", "T-two002") in ms


def test_symlinked_or_oversized_ticket_files_are_skipped(env, tmp_path):
    home, s, tasks = env
    root = str(s.root)
    real = ticket(tmp_path / "elsewhere", "T-real01", {"agent": "codex", "cwd": root, "created_at": 1.0, "status": "replied:done"})
    tasks.mkdir(parents=True, exist_ok=True)
    (tasks / "T-link01").symlink_to(real)
    d = tasks / "T-big001"
    d.mkdir()
    (d / "meta.json").write_text(json.dumps({"task": "T-big001", "cwd": root, "pad": "x" * (receipts.MAX_JSON + 10)}))
    d2 = tasks / "T-lnkf01"
    d2.mkdir()
    (d2 / "meta.json").symlink_to(real / "meta.json")
    assert receipts.tickets(root) == []


# ——— observed CLIs (T2): Grok by its sid, Devin and Cursor by the ticket their session was given ———
def test_grok_devin_and_cursor_workers_get_their_trajectories(env):
    """Seedmux knows a Grok worker's sid but never a Devin or Cursor worker's (they have no hooks):
    those are found in their CLI's own store — a session in the ticket's cwd, active after the
    dispatch, that was given this ticket. Each becomes a T2 run with its reads and writes."""
    from server.canvas.adapters.grok import enc_cwd
    from tests.native_logs import DevinSession, cursor_end, cursor_says, cursor_tool, cursor_transcript, cursor_user

    home, s, tasks = env
    root = str(s.root)
    t0 = time.time() - 900
    panes = {"grok": "A" * 8 + "-0000-0000-0000-000000000001", "devin": "A" * 8 + "-0000-0000-0000-000000000002", "cursor-agent": "A" * 8 + "-0000-0000-0000-000000000003"}
    log = main_log(home, root, t0, [*dispatch("T-9r0k02", panes["grok"], t0 + 10, "tu1"), *dispatch("T-dev001", panes["devin"], t0 + 20, "tu2"), *dispatch("T-cur001", panes["cursor-agent"], t0 + 30, "tu3")])
    # Grok: delivery.json has the sid; the session folder is the URL-encoded cwd.
    g = home / ".grok" / "sessions" / enc_cwd(root) / "01a0e788-0000-7000-8000-000000000001"
    jl(g / "updates.jsonl", [
        {"timestamp": t0 + 12, "method": "session/update", "params": {"sessionId": "g", "update": {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "T-9r0k02"}, "_meta": {"promptIndex": 0}}, "_meta": {"eventId": "g-1", "agentTimestampMs": int((t0 + 12) * 1000)}}},
        {"timestamp": t0 + 13, "method": "session/update", "params": {"sessionId": "g", "update": {"sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "read_file", "rawInput": {"target_file": f"{root}/server/app.py"}, "_meta": {"x.ai/tool": {"name": "read_file", "kind": "read"}}}, "_meta": {"eventId": "g-2", "agentTimestampMs": int((t0 + 13) * 1000)}}},
    ])
    (g / "summary.json").write_text(json.dumps({"info": {"id": g.name, "cwd": root}, "chat_format_version": 1}))
    ticket(tasks, "T-9r0k02", {"to_pane": panes["grok"], "agent": "grok", "cwd": root, "created_at": t0 + 10, "status": "replied:done", "replied_at": t0 + 100}, {"state": "replied:done", "sid": g.name})
    # Devin: no sid anywhere; its session in the ticket's cwd was given the ticket.
    d = DevinSession(home, "brisk-otter", root, int((t0 + 21) * 1000))
    d.user(0, "u", "你是 Seedmux agent team 的 worker,任务 T-dev001。先读 prompt.md")
    d.call(1, "a", [("c1", "write", {"file_path": f"{root}/server/cache/note.py", "content": "# note"})])
    d.result(1.2, "t", "c1", "ok")
    d.reply(2, "a2", "done")
    d.save(last_s=30)
    other = DevinSession(home, "quiet-bystander", root, int((t0 + 22) * 1000))  # same cwd and time, another task
    other.user(0, "u", "an unrelated prompt")
    other.save(last_s=30)
    ticket(tasks, "T-dev001", {"to_pane": panes["devin"], "agent": "devin", "cwd": root, "created_at": t0 + 20, "status": "replied:done", "replied_at": t0 + 120}, {"state": "replied:done", "native": {"agent": "", "sid": ""}})
    # Cursor: the same, from its agent-transcripts.
    c = cursor_transcript(home, root, "c76566fc-7d6c-4ae7-b714-868be82512cb", [
        cursor_user("你是 Seedmux agent team 的 worker,任务 T-cur001。先读 prompt.md"),
        cursor_says(cursor_tool("Read", {"path": f"{root}/server/app.py"})),
        cursor_end(),
    ])
    import os

    os.utime(c, (t0 + 60, t0 + 60))
    ticket(tasks, "T-cur001", {"to_pane": panes["cursor-agent"], "agent": "cursor-agent", "cwd": root, "created_at": t0 + 30, "status": "replied:done", "replied_at": t0 + 90}, {"state": "replied:done"})
    tree = runs.build(NativeRef("claude", P, log, root), root=root, store=s, with_items=True)
    r = {x["id"]: x for x in tree["runs"]}
    gr, dv, cu = r[f"grok:{g.name}"], r["devin:brisk-otter"], r["cursor:c76566fc-7d6c-4ae7-b714-868be82512cb"]
    assert "smx:T-9r0k02" not in r and "smx:T-dev001" not in r and "smx:T-cur001" not in r and "devin:quiet-bystander" not in r
    assert [x["tier"] for x in (gr, dv, cu)] == ["T2", "T2", "T2"]
    assert [(x["kind"], x.get("path")) for x in gr["timeline"]["segments"]] == [("read", "server/app.py")]
    assert [(x["kind"], x.get("path")) for x in dv["timeline"]["segments"]] == [("write", "server/cache/note.py")]
    assert [(x["kind"], x.get("path")) for x in cu["timeline"]["segments"]] == [("read", "server/app.py")] and cu["timeline"]["timesInferred"] is True
    assert dv["items"] and cu["items"] and dv["receipt"]["taskId"] == "T-dev001" and dv["state"] == "done"
    assert "T-dev001" in dv["parent"]["evidence"] and dv["parent"]["via"] == "seedmux" and dv["parent"]["taskId"] == "T-dev001"
    assert dv["logPath"].endswith("sessions.db/brisk-otter")


def test_one_dispatch_call_can_start_several_workers(env):
    """One ``smx-team spawn`` call that starts three workers prints three ``task=… pane=…`` lines:
    every one of them links its worker to that call (found on a real session: only the first did)."""
    home, s, tasks = env
    root = str(s.root)
    t0 = time.time() - 3600
    panes = [f"{c * 8}-0000-0000-0000-00000000000{i}" for i, c in enumerate("DEF")]
    out = "\n".join(f"task=T-mul00{i} pane={p}" for i, p in enumerate(panes))
    log = main_log(home, root, t0, [
        # As on the real session: a heredoc, then one `smx-team spawn` per line.
        {"type": "assistant", "uuid": "a-m", "timestamp": iso(t0 + 10), "message": {"id": "m-m", "content": [{"type": "tool_use", "id": "tu-multi", "name": "Bash", "input": {"command": "cat > batch.md <<EOF\n| A | 未派发 |\nEOF\nsmx-team spawn --agent devin --cwd . -\nsmx-team spawn --agent cursor-agent --cwd . -\nsmx-team spawn --agent codex --cwd . -"}}]}},
        {"type": "user", "uuid": "r-m", "timestamp": iso(t0 + 11), "message": {"content": [{"type": "tool_result", "tool_use_id": "tu-multi", "content": out}]}},
    ])
    for i, (agent, p) in enumerate(zip(("devin", "cursor-agent", "codex"), panes)):
        ticket(tasks, f"T-mul00{i}", {"to_pane": p, "agent": agent, "cwd": root, "created_at": t0 + 10, "status": "replied:done", "replied_at": t0 + 100})
    r = {x["id"]: x for x in runs.build(NativeRef("claude", P, log, root), root=root, store=s)["runs"]}
    for i in range(3):
        w = r[f"smx:T-mul00{i}"]
        assert w["parent"]["toolCallId"] == "tu-multi" and w["parent"]["via"] == "seedmux", w["parent"]
