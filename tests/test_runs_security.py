"""Review P1-2: ``/api/agent/runs`` never turns a request parameter into a path outside this project's
sessions; the owner app answers only to local Host names (DNS rebinding)."""

import json

import pytest
from fastapi.testclient import TestClient

from server.canvas import adapters, agents
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


def test_writes_from_another_site_are_refused(app):
    """A page on any site can send a simple cross-site POST to 127.0.0.1 (its Host is local):
    the browser's Origin / Sec-Fetch-Site give it away."""
    c, _ = app
    url = "/api/agent/sessions/nope/interrupt"  # no body: a plain <form method=post> could send it
    for headers in (
        {"origin": "https://evil.example"},
        {"origin": "null"},  # sandboxed iframe, file://
        {"origin": "http://127.0.0.1.nip.io:5181"},
        {"sec-fetch-site": "cross-site"},
        {"origin": "http://localhost:5181", "sec-fetch-site": "cross-site"},
    ):
        r = c.post(url, headers=headers)
        assert r.status_code == 403, headers
    r = c.post("/api/canvas/turns", content=b'{"request":"x"}', headers={"origin": "https://evil.example", "content-type": "text/plain"})
    assert r.status_code == 403
    # The page itself (same origin, or the vite dev proxy), the CLI and curl (no Origin) still reach it.
    for headers in ({"origin": "http://localhost:5181"}, {"origin": "http://127.0.0.1:8000", "sec-fetch-site": "same-origin"}, {"origin": "http://[::1]:5181"}, {}):
        assert c.post(url, headers=headers).status_code != 403, headers
    # Reads are not affected (a cross-site page cannot read the answer anyway: no CORS).
    assert c.get("/api/agent/adapters?versions=0", headers={"origin": "https://evil.example"}).status_code == 200


async def test_cross_site_websocket_is_refused():
    reached, sent = [], []

    async def inner(scope, receive, send):
        reached.append(scope["type"])

    async def send(msg):
        sent.append(msg)

    mw = LocalHostOnly(inner)
    await mw({"type": "websocket", "headers": [(b"host", b"127.0.0.1:1"), (b"origin", b"https://evil.example")]}, None, send)
    assert reached == [] and sent == [{"type": "websocket.close", "code": 1008}]
