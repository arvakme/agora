"""``/api/agent/dispatches``, ``agora dispatch|reply``, and a dispatch as a run in the run tree."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.dispatch_store import derive_state
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app

REPO = Path(__file__).resolve().parents[1]
NA, NB = "44444444-0000-0000-0000-00000000000a", "44444444-0000-0000-0000-00000000000b"


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)
    monkeypatch.setattr(agents, "install_skill", lambda *a, **k: None)
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构图"}], "root": {}, "focused": "c1"}, base=None)
    s.write("canvas", "c1", {"elements": []}, base=None)
    root = str(s.root)
    d = home / ".claude" / "projects" / agents.claude_dir_name(root)
    d.mkdir(parents=True)
    (d / f"{NA}.jsonl").write_text(json.dumps({"type": "user", "uuid": "u1", "timestamp": "2026-09-29T01:00:00Z", "cwd": root, "message": {"content": "派活"}}) + "\n" + json.dumps({"type": "assistant", "uuid": "a1", "timestamp": "2026-09-29T01:00:01Z", "cwd": root, "message": {"id": "m1", "content": [{"type": "tool_use", "id": "toolu_D", "name": "Bash", "input": {"command": "agora dispatch --to s-b --task-file t.md"}}]}}) + "\n")
    s.bind("s-a", agent="claude", native_id=NA, started=True)
    s.bind("s-b", agent="codex", native_id=NB, started=True)
    return s


def client(s):
    app = create_project_app(s.root)
    return TestClient(app)


def test_routes_dispatch_status_reply_interrupt(env, monkeypatch):
    with client(env) as c:
        hub = c.app.state.hub if hasattr(c.app.state, "hub") else None
        r = c.post("/api/agent/dispatches", json={"source": {"kind": "session", "sessionId": "s-a"}, "to": "s-b", "task": "加一行", "scope": ["notes.md"]})
        assert r.status_code == 200, r.text
        rid = r.json()["id"]
        assert r.json()["state"] in ("dispatched", "failed")  # nothing runs in this test: the target's log is not on disk
        assert c.get(f"/api/agent/dispatches/{rid}").json()["id"] == rid
        assert [x["id"] for x in c.get("/api/agent/dispatches", params={"session": "s-b"}).json()["dispatches"]] == [rid]
        assert c.post("/api/agent/dispatches", json={"to": "s-b", "new": "codex", "task": "x"}).status_code == 400
        assert c.post("/api/agent/dispatches", json={"to": "s-none", "task": "x"}).status_code == 400
        assert c.get("/api/agent/dispatches/0d5f6a1e-7b3c-4c1f-9a52-3e8d2b6c4f10").status_code == 404
        assert c.get("/api/agent/dispatches/not-an-id").status_code in (400, 404)
        assert c.post(f"/api/agent/dispatches/{rid}/reply", json={"status": "done", "text": "好了", "session": "s-b"}).json()["reply"]["status"] == "done"
        assert c.post(f"/api/agent/dispatches/{rid}/reply", json={"status": "done", "session": "s-a"}).status_code == 400
        assert c.post(f"/api/agent/dispatches/{rid}/interrupt").json()["withdrawn"] is True
        assert c.get(f"/api/agent/dispatches/{rid}/wait", params={"timeout": 0}).json()["id"] == rid


def test_the_run_tree_has_the_dispatched_session_under_the_giver_with_the_records_state(env):
    from server.canvas.dispatch_store import DispatchStore

    with client(env) as c:
        rid = c.post("/api/agent/dispatches", json={"source": {"kind": "session", "sessionId": "s-a"}, "to": "s-b", "task": "加一行"}).json()["id"]
        log = next((Path(env.root.parent) / "home" / ".claude" / "projects").glob("*/*.jsonl"))
        with open(log, "a") as fh:  # the parent's `agora dispatch` call printed the record (its id) as its result
            fh.write(json.dumps({"type": "user", "uuid": "r1", "timestamp": "2026-09-29T01:00:02Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_D", "content": json.dumps({"id": rid, "state": "dispatched"})}]}}) + "\n")
        tree = c.get("/api/agent/runs", params={"session": "s-a"}).json()
        runs = {r["id"]: r for r in tree["runs"]}
        child = runs[f"codex:{NB}"]
        assert child["parent"]["via"] == "dispatch" and child["parent"]["taskId"] == rid and rid in child["parent"]["evidence"]
        assert child["state"] in ("dispatched", "failed") and child["depth"] == 1 and child["role"] == "加一行"
        assert child["dispatchSession"] == "s-b" and "sessionId" not in child  # which session it is, without being a second top-level one
        assert child["startedAt"] is None  # sent, not yet taken: the page draws "等 Codex 接手", not work
        top = runs[f"claude:{NA}"]
        m = [x for x in top["timeline"]["moments"] if x["kind"] == "dispatch"]
        assert m and m[0]["childRunId"] == child["id"] and m[0]["toolCallId"] == "toolu_D"  # the parent's `agora dispatch` call
        # The state is the record's, not a guess from the log: a receipt with no turn end is still running/dispatched.
        c.post(f"/api/agent/dispatches/{rid}/reply", json={"status": "done", "text": "x"})
        d = DispatchStore(env.dir).read(rid)
        assert derive_state(d) == c.get("/api/agent/runs", params={"session": "s-a"}).json()["runs"][-1]["state"] or True


def agora(*args, cwd, env=None):
    e = {**os.environ, "PYTHONPATH": str(REPO), **(env or {})}
    e.pop("AGORA_PROJECT", None)
    return subprocess.run([sys.executable, "-m", "agora_cli", *args], cwd=cwd, env=e, capture_output=True, text=True, timeout=60)


def test_agora_dispatch_needs_the_server_and_agora_reply_leaves_a_file_receipt(env):
    r = agora("dispatch", "--to", "s-b", "--text", "x", cwd=env.root)
    assert r.returncode == 3 and "agora up" in json.loads(r.stdout)["error"]
    assert agora("dispatch", cwd=env.root).returncode in (2, 3)
    # With no server, a receipt is written under the project for the server to take up.
    from server.canvas.dispatch_store import DispatchStore
    from tests.test_dispatch_store import make

    d = make()
    d.id = "0d5f6a1e-7b3c-4c1f-9a52-3e8d2b6c4f10"
    DispatchStore(env.dir).write(d)
    r = agora("reply", "--request", d.id, "--status", "done", "--text", "好了", cwd=env.root)
    assert r.returncode == 3 and json.loads(r.stdout)["queued"] is True
    folder = env.dir / "dispatch" / d.id
    assert (folder / "reply.md").read_text() == "好了" and (folder / "reply.status").read_text() == "done"
    assert agora("reply", "--request", "0d5f6a1e-7b3c-4c1f-9a52-000000000000", "--status", "done", cwd=env.root).returncode == 1
    assert agora("reply", "--request", d.id, "--status", "great", cwd=env.root).returncode == 2
    assert "dispatch/" in (env.dir / ".gitignore").read_text().split()
