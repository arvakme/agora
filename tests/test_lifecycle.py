"""Lifecycle stop-gaps (phase 0 of the session / canvas lifecycle plan): no sample over existing
canvases, refused writes are reported, a session whose native log is gone is never silently
restarted under the same id, the log copy that belongs to this project is the one followed, a
moved project refuses writes, deleting a session closes its pane, the Agora footer names the
session and project. Experiments A1/A3/B3/B4/B6/B7 are the scenarios measured on 2026-09-28."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import time
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.agents import NativeMissing, check_native, claude_dir_name, interactive_argv, locate_log, pi_dir_name
from server.canvas.project import Gone, ProjectStore
from server.canvas.project_router import create_project_app
from server.canvas.sessions import AgentHub, agora_prompt, binding_started
from server.canvas.transcript import split_agora

NID = "65b04644-6b78-49c7-b0df-b94f9d79a2fc"


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setattr(Path, "home", lambda: h)
    monkeypatch.delenv("PI_CODING_AGENT_SESSION_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    return h


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "A"}], "root": {}, "focused": "c1"}, base=None)
    s.write("canvas", "c1", {"elements": [{"id": "box1", "type": "rectangle"}]}, base=None)
    return s


def app_client(store: ProjectStore, **kw) -> TestClient:
    return TestClient(create_project_app(store.root, canvas_router=APIRouter(), **kw))


def claude_file(home: Path, root: Path | str, nid: str = NID) -> Path:
    p = home / ".claude" / "projects" / claude_dir_name(root) / f"{nid}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{"type":"user"}\n')
    return p


def pi_file(home: Path, root: Path | str, stamp: str, nid: str = NID) -> Path:
    p = home / ".pi" / "agent" / "sessions" / pi_dir_name(root) / f"{stamp}_{nid}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"type": "session", "id": nid, "cwd": str(root)}) + "\n")
    return p


# ——— 1. no sample over existing canvases (B3) ———
def test_snapshot_is_not_empty_when_canvases_exist_without_workspace(store):
    (store.dir / "workspace.json").unlink()
    snap = app_client(store).get("/api/project/snapshot").json()
    assert snap["empty"] is False and snap["workspace"] is None and set(snap["canvases"]) == {"c1"}


def test_first_run_sample_write_never_overwrites_an_existing_c1(store):
    before = (store.dir / "canvases" / "c1.excalidraw").read_bytes()
    r = app_client(store).put("/api/project/canvases/c1", json={"data": {"elements": [{"id": "sample"}]}, "base": None})
    assert r.status_code == 409 and r.json()["file"] == "canvases/c1.excalidraw"
    assert (store.dir / "canvases" / "c1.excalidraw").read_bytes() == before


def test_fresh_project_is_empty(tmp_path):
    s = ProjectStore(tmp_path / "fresh")
    s.init()
    assert app_client(s).get("/api/project/snapshot").json()["empty"] is True


# ——— 2. refused writes and unreadable files are reported (B4, B7) ———
@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_refused_write_says_which_file_and_why_and_keeps_the_old_file(store):
    c = app_client(store)
    path = store.dir / "canvases" / "c1.excalidraw"
    before = path.read_bytes()
    base = c.get("/api/project/snapshot").json()["canvases"]["c1"]["version"]
    os.chmod(path.parent, stat.S_IRUSR | stat.S_IXUSR)
    try:
        r = c.put("/api/project/canvases/c1", json={"data": {"elements": []}, "base": base})
    finally:
        os.chmod(path.parent, stat.S_IRWXU)
    assert r.status_code == 500
    assert r.json()["error"] == "保存失败：没有写入权限" and r.json()["file"] == "canvases/c1.excalidraw"
    assert path.read_bytes() == before


def test_merge_conflict_is_reported_per_file_not_as_a_500(store):
    store.write("canvas", "c2", {"elements": []}, base=None)
    (store.dir / "workspace.json").write_text('<<<<<<< HEAD\n{}\n=======\n{"docs": []}\n>>>>>>> other\n')
    (store.dir / "threads" / "c2.json").write_text("{not json")
    r = app_client(store).get("/api/project/snapshot")
    assert r.status_code == 200
    snap = r.json()
    errs = {e["file"]: e for e in snap["errors"]}
    assert errs["workspace.json"]["error"] == "merge-conflict" and errs["workspace.json"]["line"] == 1
    assert errs["threads/c2.json"]["error"] == "invalid-json" and errs["threads/c2.json"]["line"] == 1
    assert snap["workspace"] is None and set(snap["canvases"]) == {"c1", "c2"}  # the rest loads
    assert snap["canvases"]["c2"]["threads"] is None


# ——— 3. never a silent new native session (A1, A3) ———
def test_bindings_start_unstarted_and_adopted_ids_count_as_started(store):
    assert store.bind("s-new", agent="claude")["started"] is False
    assert store.bind("s-undo", agent="claude", native_id=NID)["started"] is True  # undo re-binds an existing session
    assert store.mark_started("s-new")["started"] is True
    assert binding_started({"agent": "claude", "nativeId": NID}) is True  # older bindings: assume it ran
    # Undoing the delete of a session that never ran keeps it creatable.
    assert store.bind("s-fresh-undo", agent="claude", native_id=NID, started=False)["started"] is False


def test_undo_rebind_over_http_keeps_started(store):
    c = app_client(store)
    assert c.put("/api/agent/sessions/s-u", json={"agent": "claude", "nativeId": NID, "started": False}).json()["started"] is False
    assert c.put("/api/agent/sessions/s-v", json={"agent": "claude", "nativeId": NID}).json()["started"] is True


def test_check_native_refuses_a_started_session_without_log(home, tmp_path):
    root = tmp_path / "proj"
    with pytest.raises(NativeMissing) as e:
        check_native("claude", NID, True, root)
    assert e.value.public()["state"] == "missing" and "30 天" in str(e.value)
    assert check_native("claude", NID, False, root).state == "missing"  # never ran: may be created
    claude_file(home, root)
    assert check_native("claude", NID, True, root).state == "found"


def test_claude_never_gets_session_id_for_a_started_session(home, tmp_path):
    root = tmp_path / "proj"
    # Terminal pane: --session-id only for a session that never ran.
    assert interactive_argv("claude", NID, "haiku", "", new=True, root=root)[1:3] == ["--session-id", NID]
    assert interactive_argv("claude", NID, "haiku", "", new=False, root=root)[1:3] == ["--resume", NID]
    claude_file(home, root)
    assert interactive_argv("claude", NID, "haiku", "", new=True, root=root)[1:3] == ["--resume", NID]


class Recording:
    name = "claude"

    def __init__(self):
        self.calls = []

    async def run(self, req):
        self.calls.append(req)
        yield {"t": "result", "at": 1, "raw": "ok", "usage": {"costUsd": None}, "session": req.options.session}


async def test_send_to_a_session_whose_log_is_gone_is_refused_not_restarted(store, home):
    backend = Recording()
    hub = AgentHub(store, backend_factory=lambda kind: backend)
    store.bind("s-1", agent="claude", model="haiku", native_id=NID)  # it ran before (adopted id)
    sub = hub.subscribe(executor=False)
    try:
        with pytest.raises(NativeMissing):
            hub.send("s-1", "还记得暗号吗")
        await asyncio.sleep(0.3)
        assert backend.calls == []  # no CLI started, so no new native file under the same id
        st = hub.status("s-1")
        assert st["native"]["state"] == "missing" and st["native"]["blocking"] is True
        with pytest.raises(NativeMissing):
            await asyncio.to_thread(hub.open_terminal, "s-1", launch=False)
        # The HTTP answer names the problem instead of a generic error.
        r = app_client(store).post("/api/agent/sessions/s-1/send", json={"text": "hi"})
        assert r.status_code == 409 and r.json()["nativeMissing"] is True and r.json()["native"]["nativeId"] == NID
    finally:
        await hub.close()
        hub.unsubscribe(sub)


async def test_new_session_is_created_once_then_only_resumed(store, home):
    backend = Recording()
    hub = AgentHub(store, backend_factory=lambda kind: backend)
    store.bind("s-2", agent="claude", model="haiku")
    store.set_native("s-2", NID)
    sub = hub.subscribe(executor=False)
    try:
        hub.send("s-2", "第一句")
        for _ in range(50):
            if store.read_binding("s-2").get("started"):
                break
            await asyncio.sleep(0.05)
        assert backend.calls[0].options.new_session is True
        assert store.read_binding("s-2")["started"] is True
        # Its log is found from now on; without it the next send is refused (never --session-id again).
        claude_file(home, store.root)
        hub.send("s-2", "第二句")
        for _ in range(50):
            if len(backend.calls) > 1:
                break
            await asyncio.sleep(0.05)
        assert backend.calls[1].options.new_session is False
    finally:
        await hub.close()
        hub.unsubscribe(sub)


async def test_pi_session_in_another_directory_is_refused(store, home, tmp_path):
    """A3: after a move Pi's --session-id would silently start an empty session in the new folder."""
    hub = AgentHub(store, backend_factory=lambda kind: Recording())
    store.bind("s-pi", agent="pi", native_id=NID)
    pi_file(home, tmp_path / "old-place", "2026-09-28T05-19-21-739Z")
    try:
        with pytest.raises(NativeMissing) as e:
            hub.send("s-pi", "hi")
        assert e.value.lookup.state == "elsewhere"
    finally:
        await hub.close()


# ——— 4. the copy that belongs to this project is followed; several copies are reported ———
def test_pi_prefers_the_current_project_folder_over_a_later_sorting_old_one(home):
    """A3: sorted(hits)[-1] picked …-orig-… (sorts after …-moved-…) while Pi wrote the new file."""
    old = pi_file(home, "/private/tmp/agora-mv-exp/orig/pi-repo", "2026-09-28T05-19-21-739Z")
    new = pi_file(home, "/private/tmp/agora-mv-exp/moved/pi-repo-new", "2026-09-28T05-19-30-193Z")
    assert sorted([old, new])[-1] == old  # the old bug's pick
    look = locate_log("pi", NID, "/private/tmp/agora-mv-exp/moved/pi-repo-new")
    assert look.state == "found" and look.path == new
    assert set(look.candidates) == {old, new}


def test_claude_prefers_the_current_project_and_reports_ambiguity(home, tmp_path):
    a = claude_file(home, "/private/tmp/agora-mv-exp/orig/claude-repo")
    b = claude_file(home, "/private/tmp/agora-mv-exp/moved/claude-repo-new")
    look = locate_log("claude", NID, "/private/tmp/agora-mv-exp/moved/claude-repo-new")
    assert look.state == "found" and look.path == b and set(look.candidates) == {a, b}
    note = agents.duplicates_note("claude", NID, look)
    assert note["state"] == "duplicates" and note["blocking"] is False and note["candidates"][0] == str(b)
    # Neither copy is this project's: do not pick one.
    other = locate_log("claude", NID, tmp_path / "elsewhere")
    assert other.state == "ambiguous" and other.path is None
    # A single copy anywhere is what `claude --resume` finds: follow it.
    b.unlink()
    assert locate_log("claude", NID, tmp_path / "elsewhere").path == a


def test_dir_names_match_the_clis(tmp_path):
    assert claude_dir_name("/private/tmp/agora-mv-exp/orig/claude-repo") == "-private-tmp-agora-mv-exp-orig-claude-repo"
    assert pi_dir_name("/private/tmp/agora-mv-exp/orig/pi-repo") == "--private-tmp-agora-mv-exp-orig-pi-repo--"


# ——— 5. a moved project refuses writes (B6) ———
def test_writes_after_the_project_moved_are_refused_and_nothing_appears_at_the_old_path(store, tmp_path):
    c = app_client(store)
    old = store.root
    old.rename(tmp_path / "proj-moved")
    r = c.put("/api/project/canvases/c9", json={"data": {"elements": []}, "base": None})
    assert r.status_code == 410 and r.json()["gone"] is True and "agora up" in r.json()["error"]
    assert c.put("/api/project/workspace", json={"data": {}, "base": None}).status_code == 410
    assert c.get("/api/project/health").json()["gone"]
    assert not old.exists()  # no ghost .agora/ grown at the old path
    with pytest.raises(Gone):
        store.append_session("s-1", [{"t": "session", "session": {}}], base=None)
    assert not old.exists()


def test_a_different_directory_at_the_same_path_is_not_the_project(store, tmp_path):
    old = store.root
    old.rename(tmp_path / "proj-moved")
    (old / ".agora").mkdir(parents=True)  # something else now lives at the old path
    with pytest.raises(Gone):
        store.write("canvas", "c1", {"elements": []}, base=None, force=True)
    assert not (old / ".agora" / "canvases").exists()


# ——— 7. deleting a session closes its terminal pane ———
class FakeTerms:
    def __init__(self):
        self.open: set[str] = set()
        self.killed: list[str] = []

    def alive(self, sid):
        return sid in self.open

    def kill(self, sid):
        self.killed.append(sid)
        self.open.discard(sid)

    def attach_command(self, sid):
        return f"tmux attach -t agora-{sid}"

    def holder(self, sid):
        return {"app": "tmux"} if sid in self.open else None

    def clients(self, sid):
        return 0


def test_deleting_a_session_closes_its_pane(store):
    terms = FakeTerms()
    hub = AgentHub(store, terminals=terms)
    store.bind("s-t", agent="claude", native_id=NID)
    store.append_session("s-t", [{"t": "session", "session": {"id": "s-t", "canvasId": "c1"}}], base=None)
    terms.open.add("s-t")
    c = TestClient(create_project_app(store.root, canvas_router=APIRouter(), hub=hub))
    r = c.delete("/api/project/sessions/s-t")
    assert r.json() == {"ok": True, "terminalClosed": True}
    assert terms.killed == ["s-t"] and store.read_binding("s-t") is None
    assert c.delete("/api/project/sessions/s-none").json()["terminalClosed"] is False


# ——— 8. the hidden footer names the Agora session and project ———
def test_footer_carries_session_and_project_ids():
    p = agora_prompt("加一个缓存", canvas_id="c2", canvas_name="架构 B", session_id="s-onc2", project_id="1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901")
    body, from_agora = split_agora(p)
    assert body == "加一个缓存" and from_agora
    assert "(canvas=c2 session=s-onc2 project=1b2c3d4e)" in p


def test_send_route_puts_ids_in_the_footer(store, home):
    backend = Recording()
    hub = AgentHub(store, backend_factory=lambda kind: backend)
    store.bind("s-f", agent="claude")
    store.set_native("s-f", NID)
    c = TestClient(create_project_app(store.root, canvas_router=APIRouter(), hub=hub))
    with c:
        assert c.post("/api/agent/sessions/s-f/send", json={"text": "hi", "canvasId": "c1"}).status_code == 200
        for _ in range(50):
            if backend.calls:
                break
            time.sleep(0.05)
    pid = store.info()["id"].replace("-", "")[:8]
    assert f"session=s-f project={pid}" in backend.calls[0].prompt
