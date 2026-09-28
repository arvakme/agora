"""Phase 2 of the session / canvas lifecycle plan: deleting moves a canvas or a session into
``.agora/trash/`` — restorable after a reload or a restart for 30 days, byte for byte, with its
comments, code paths, binding and usage; shares end first; the native log is never touched."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.local import Local
from server.canvas.project import NotFound, ProjectStore
from server.canvas.project_router import create_project_app
from server.canvas.sessions import AgentHub
from server.canvas.trash import Trash

NID = "65b04644-6b78-49c7-b0df-b94f9d79a2fc"
DAY = 24 * 3600


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setattr(Path, "home", lambda: h)
    return h


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "A"}, {"id": "c2", "kind": "canvas", "title": "B"}], "root": {}, "focused": "c1"}, base=None)
    s.write("canvas", "c1", {"elements": [{"id": "box1", "type": "rectangle"}]}, base=None)
    s.write("canvas", "c2", {"elements": [{"id": "redis", "type": "rectangle", "customData": {"codePaths": ["server/cache/**"]}}]}, base=None)
    s.write("threads", "c2", {"seq": 1, "threads": [{"id": "t1", "n": 1, "messages": [{"id": "m1", "author": "human", "text": "换集群版？"}]}]}, base=None)
    s.append_session("s-1", [{"t": "session", "session": {"id": "s-1", "canvasId": "c2", "createdAt": 1, "turnIds": ["t-1"]}}, {"t": "turn", "turn": {"id": "t-1", "status": "applied"}}], base=None)
    s.bind("s-1", agent="claude", model="haiku", native_id=NID, started=True)
    (s.run_dir / "usage").mkdir(parents=True, exist_ok=True)
    (s.run_dir / "usage" / "s-1.jsonl").write_text('{"id":"run-m-1","kind":"run","usage":{"costUsd":0.03}}\n')
    return s


def client(store: ProjectStore, **kw) -> TestClient:
    return TestClient(create_project_app(store.root, canvas_router=APIRouter(), **kw))


def files(store: ProjectStore) -> dict[str, bytes]:
    return {str(p.relative_to(store.dir)): p.read_bytes() for p in store.dir.rglob("*") if p.is_file() and "trash" not in p.parts and "local" not in p.parts and p.name not in ("write.lock",) and "tmux.conf" not in p.name}


def test_canvas_to_trash_and_back_after_a_restart_byte_for_byte(store):
    before = files(store)
    c = client(store)
    entry = {"id": "c2", "kind": "canvas", "title": "B"}
    m = c.post("/api/project/trash/canvas/c2", json={"entry": entry, "place": {"groupId": "g1", "index": 1, "docIndex": 1}, "title": "B"}).json()
    assert m["kind"] == "canvas" and m["linked"] == ["s-1"] and m["daysLeft"] == 30
    assert not (store.dir / "canvases" / "c2.excalidraw").exists() and not (store.dir / "threads" / "c2.json").exists()
    assert (store.dir / "sessions" / "s-1.jsonl").exists()  # its session stays
    assert (store.dir / "trash" / ".gitignore").read_text().strip().endswith("*")

    c2 = client(ProjectStore(store.root))  # a reload, a restart: the trash is on disk
    items = c2.get("/api/project/trash").json()["items"]
    assert [x["trashId"] for x in items] == [m["trashId"]]
    r = c2.post(f"/api/project/trash/{m['trashId']}/restore").json()
    assert r["id"] == "c2" and r["item"]["entry"] == entry and r["item"]["place"]["groupId"] == "g1"
    assert r["canvas"]["scene"]["elements"][0]["customData"]["codePaths"] == ["server/cache/**"]  # the pointer's code paths
    assert r["canvas"]["threads"]["data"]["threads"][0]["messages"][0]["text"] == "换集群版？"
    assert files(store) == before
    assert c2.get("/api/project/trash").json()["items"] == []


def test_session_to_trash_and_back_keeps_binding_record_and_usage_and_resumes_the_same_native(store, home):
    before = files(store)
    log = home / ".claude" / "projects" / agents.claude_dir_name(store.root) / f"{NID}.jsonl"
    log.parent.mkdir(parents=True)
    log.write_text('{"type":"user"}\n')
    store.set_log("s-1", str(log))
    before = files(store)
    c = client(store)
    m = c.post("/api/project/trash/session/s-1", json={"title": "Claude Code · 加 Kafka"}).json()
    assert m["native"] == {"agent": "claude", "nativeId": NID, "logPath": str(log)}
    assert store.read_binding("s-1") is None and not (store.run_dir / "usage" / "s-1.jsonl").exists()
    assert log.exists()  # the native conversation is never Agora's to delete
    r = c.post(f"/api/project/trash/{m['trashId']}/restore").json()
    assert r["binding"]["nativeId"] == NID and r["binding"]["started"] is True
    assert r["session"]["state"]["turns"]["t-1"]["status"] == "applied"
    assert files(store) == before
    # resumed, never re-created: the same native id, --resume
    from server.canvas.agents import ClaudeCodeBackend
    from server.canvas.runner import ExecOptions, RunRequest

    b = store.read_binding("s-1")
    req = RunRequest(schema=None, system=None, prompt="x", options=ExecOptions(backend="claude", session=b["nativeId"], new_session=not b["started"]), cwd=str(store.root))
    assert ClaudeCodeBackend().args(req)[5:7] == ["--resume", NID]
    purge = c.post("/api/project/trash/session/s-1", json={}).json()
    assert c.delete(f"/api/project/trash/{purge['trashId']}").json()["native"]["nativeId"] == NID
    assert log.exists() and not (store.dir / "trash" / purge["trashId"]).exists()


def test_restoring_over_an_id_that_came_back_meanwhile_uses_a_free_id(store):
    t = Trash(store)
    m = t.put("canvas", "c1", entry={"id": "c1", "kind": "canvas", "title": "A"})
    store.write("canvas", "c1", {"elements": [{"id": "from-git"}]}, base=None)  # git checkout brought c1 back
    r = t.restore(m["trashId"])
    assert r["id"] == "c1-r1" and r["originalId"] == "c1" and r["entry"]["id"] == "c1-r1"
    assert json.loads((store.dir / "canvases" / "c1.excalidraw").read_text())["elements"][0]["id"] == "from-git"
    assert json.loads((store.dir / "canvases" / "c1-r1.excalidraw").read_text())["elements"][0]["id"] == "box1"


def test_items_past_30_days_are_swept_newer_ones_stay(store):
    now = [1_800_000_000.0]
    t = Trash(store, clock=lambda: now[0])
    old = t.put("canvas", "c1")
    now[0] += 20 * DAY
    young = t.put("canvas", "c2")
    now[0] += 10 * DAY + 1  # the first is 30 days and a second old, the second 10 days
    assert [m["trashId"] for m in t.sweep()] == [old["trashId"]]
    assert [m["trashId"] for m in t.list()] == [young["trashId"]] and t.list()[0]["daysLeft"] == 20


def test_a_half_moved_item_can_still_be_restored(store, monkeypatch):
    """The manifest is written before anything moves: a crash between two renames loses nothing."""
    import os

    real = os.rename
    calls = []

    def crash_on_second(a, b):
        calls.append(a)
        if len(calls) == 2:
            raise OSError("power cut")
        return real(a, b)

    monkeypatch.setattr("server.canvas.trash.os.rename", crash_on_second)
    t = Trash(store)
    with pytest.raises(OSError):
        t.put("canvas", "c2")
    monkeypatch.undo()
    [m] = t.list()
    t.restore(m["trashId"])
    assert (store.dir / "canvases" / "c2.excalidraw").exists() and (store.dir / "threads" / "c2.json").exists()


def test_trashing_a_canvas_whose_shares_cannot_be_ended_leaves_it_in_place(store, monkeypatch):
    """Review P2-6: shares end first; if that fails the canvas is still there (before, it was already deleted)."""
    from server.canvas.share import ShareManager

    def boom(self, cid, reason="canvas-deleted"):
        raise OSError("disk full")

    monkeypatch.setattr(ShareManager, "end_for_canvas", boom)
    r = client(store).post("/api/project/trash/canvas/c2", json={})
    assert r.status_code >= 500
    assert (store.dir / "canvases" / "c2.excalidraw").exists() and Trash(store).list() == []


def test_guests_cannot_grow_threads_for_a_trashed_canvas(store):
    Trash(store).put("canvas", "c2")
    with pytest.raises(NotFound):
        store.thread_op("c2", {"op": "create", "thread": {"id": "t9", "messages": []}})
    assert not (store.dir / "threads" / "c2.json").exists()


def test_trash_restore_purge_are_in_the_registry(store):
    c = client(store)
    m = c.post("/api/project/trash/canvas/c2", json={"title": "B"}).json()
    c.post(f"/api/project/trash/{m['trashId']}/restore")
    m2 = c.post("/api/project/trash/session/s-1", json={}).json()
    c.delete(f"/api/project/trash/{m2['trashId']}")
    loc = Local(store)
    kinds = [(e["t"], e.get("kind")) for e in loc.registry.events(loc.project_id(), ("trash", "restore", "purge"))]
    assert kinds == [("trash", "canvas"), ("restore", "canvas"), ("trash", "session"), ("purge", "session")]


async def test_trashing_a_session_stops_its_turn_and_restoring_follows_it_again(store, home):
    gate = asyncio.Event()

    class Slow:
        async def run(self, req):
            yield {"t": "start", "at": 0}
            await gate.wait()
            yield {"t": "result", "at": 1, "raw": "late", "usage": {"costUsd": 0.5}, "session": NID}

    log = home / ".claude" / "projects" / agents.claude_dir_name(store.root) / f"{NID}.jsonl"
    log.parent.mkdir(parents=True)
    log.write_text(json.dumps({"type": "user", "uuid": "u1", "timestamp": "2026-09-28T05:00:00Z", "message": {"content": "暗号 PAPAYA-7"}}) + "\n")
    hub = AgentHub(store, backend_factory=lambda kind: Slow())
    sub = hub.subscribe(executor=False)
    try:
        hub.send("s-1", "long")
        await asyncio.sleep(0.2)
        from server.canvas.project_router import create_project_router

        router_app = __import__("fastapi").FastAPI()
        router_app.include_router(create_project_router(store, hub=hub), prefix="/api/project")
        import httpx

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=router_app), base_url="http://t") as c:
            m = (await c.post("/api/project/trash/session/s-1", json={})).json()
            gate.set()
            await asyncio.sleep(0.2)
            usage = (store.dir / "trash" / m["trashId"] / "run__usage__s-1.jsonl").read_text()
            assert "0.5" not in usage  # the stopped turn wrote nothing after the move
            while not sub.q.empty():
                sub.q.get_nowait()
            await c.post(f"/api/project/trash/{m['trashId']}/restore")
        evs = [sub.q.get_nowait() for _ in range(sub.q.qsize())]
        reset = [e for e in evs if e.get("t") == "transcript" and e.get("reset")]
        assert reset and any(i.get("text") == "暗号 PAPAYA-7" for i in reset[-1]["items"])
    finally:
        await hub.close()
