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
    monkeypatch.setenv("AGORA_EXPERIMENTAL", "seedmux-receipts")  # v2 feature, off by default
    monkeypatch.setattr(receipts, "_panes", None)
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
    assert w["parent"] == {"runId": f"claude:{P}", "via": "seedmux", "toolCallId": "toolu_S", "taskId": "T-aaa111", "evidence": f"父会话日志里 smx-team 打印的 task=T-aaa111 pane={PANE_W}"}
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


def test_receipts_are_off_by_default(env, monkeypatch):
    home, s, tasks = env
    monkeypatch.delenv("AGORA_EXPERIMENTAL")
    ticket(tasks, "T-ggg777", {"from_pane": "", "agent": "codex", "cwd": str(s.root), "created_at": time.time(), "status": "dispatched"})
    d = home / ".claude" / "projects" / agents.claude_dir_name(str(s.root))
    log = jl(d / f"{P}.jsonl", [{"type": "user", "uuid": "u1", "timestamp": iso(time.time() - 5), "cwd": str(s.root), "message": {"content": "hi"}}])
    tree = runs.build(NativeRef("claude", P, log, str(s.root)), root=str(s.root), store=s)
    assert [r["id"] for r in tree["runs"]] == [f"claude:{P}"]


def test_reads_only_core_files(env):
    home, s, tasks = env
    d = ticket(tasks, "T-fff666", {"agent": "grok", "cwd": str(s.root), "created_at": 1.0, "status": "replied:done"}, {"state": "replied:done", "sid": "g-1"}, "ok")
    t = receipts.read_ticket(d)
    assert set(t["meta"]) <= set(receipts.META_KEYS) and "noise" not in t["meta"]
    assert "prompt" not in json.dumps(t)
    assert [x["meta"]["task"] for x in receipts.tickets(str(s.root))] == ["T-fff666"]
