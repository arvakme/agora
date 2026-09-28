"""Review P1-2: ``/api/agent/runs`` never turns a request parameter into a path outside this project's
sessions; the owner app answers only to local Host names (DNS rebinding)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.canvas import adapters, agents
from server.canvas.adapters import receipts
from server.canvas.adapters.base import valid_id
from server.canvas.project import ProjectStore
from server.canvas.project_router import LocalHostOnly, create_project_app, host_name

NID = "44444444-0000-0000-0000-000000000001"
OTHER = "55555555-0000-0000-0000-000000000001"


@pytest.fixture()
def app(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("AGORA_SEEDMUX_TASKS", str(tmp_path / "no-tasks"))
    s = ProjectStore(tmp_path / "proj")
    s.init()
    for root, nid in ((str(s.root), NID), ("/some/other/project", OTHER)):
        p = home / ".claude" / "projects" / agents.claude_dir_name(root) / f"{nid}.jsonl"
        p.parent.mkdir(parents=True)
        p.write_text(json.dumps({"type": "user", "uuid": "u", "timestamp": "2026-09-28T01:00:00Z", "cwd": root, "message": {"content": "secret of " + root}}) + "\n")
    (tmp_path / "loot.jsonl").write_text(json.dumps({"type": "user", "uuid": "x", "message": {"content": "private"}}) + "\n")
    return TestClient(create_project_app(s.root)), home


@pytest.mark.parametrize("bad", ["../../..", "../loot", "a/b", "*", "x" * 200, ".hidden", "..", "a b"])
def test_ids_that_are_not_ids_never_reach_a_path(bad):
    assert not valid_id(bad)
    for a in adapters.ADAPTERS.values():
        assert a.locate(bad).state == "missing"


def test_native_must_be_a_session_of_this_project(app):
    c, _ = app
    assert c.get("/api/agent/runs", params={"kind": "claude", "native": "../../..", "items": 1}).status_code == 400
    assert c.get("/api/agent/runs", params={"kind": "claude", "native": "../loot", "items": 1}).status_code == 400
    r = c.get("/api/agent/runs", params={"kind": "claude", "native": OTHER, "items": 1})
    assert r.status_code == 404 and "secret" not in r.text  # another project's session on this machine
    ok = c.get("/api/agent/runs", params={"kind": "claude", "native": NID, "items": 1})
    assert ok.status_code == 200 and ok.json()["root"] == f"claude:{NID}"
    assert c.get("/api/agent/runs", params={"kind": "claude", "native": NID, "canvas": "../x"}).status_code == 400


def test_delivery_sid_goes_through_the_id_check():
    t = {"meta": {"task": "T-1", "agent": "claude"}, "delivery": {"sid": "../../x", "native": {"sid": "a/b"}}, "reply": None, "dir": "/tmp/T-1"}
    assert receipts.receipt(t)["sid"] is None
    t["delivery"]["native"]["sid"] = NID
    assert receipts.receipt(t)["sid"] == NID


def test_owner_app_answers_only_to_local_hosts(app):
    c, _ = app
    for h in ("127.0.0.1:5173", "localhost", "[::1]:55331"):
        assert c.get("/api/agent/adapters?versions=0", headers={"host": h}).status_code == 200, h
    for h in ("evil.example", "evil.example:5173", "127.0.0.1.nip.io"):
        r = c.get("/api/agent/adapters?versions=0", headers={"host": h})
        assert r.status_code == 421, h
    assert host_name("[::1]:8000") == "::1" and host_name("LocalHost:1") == "localhost"


async def test_websockets_are_checked_too():
    reached, sent = [], []

    async def inner(scope, receive, send):
        reached.append(scope["type"])

    async def send(msg):
        sent.append(msg)

    mw = LocalHostOnly(inner)
    await mw({"type": "websocket", "headers": [(b"host", b"evil.example")]}, None, send)
    assert reached == [] and sent == [{"type": "websocket.close", "code": 1008}]
    await mw({"type": "websocket", "headers": [(b"host", b"127.0.0.1:1")]}, None, send)
    assert reached == ["websocket"]
