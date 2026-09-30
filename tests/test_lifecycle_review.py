"""Regressions for the review of lifecycle phases 1–3 (merged HEAD fd2275f): doctor must not bind
another copy's sessions, trash manifests cannot write outside ``.agora/``, backups never resurrect
trashed sessions, in-place upgrades are the same copy, panes on the old path-hash tmux socket are
still seen, plain ``agora doctor`` writes nothing, and local history / backups stay bounded."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from server.canvas import agents, backup
from server.canvas.backup import Backups, FileHistory
from server.canvas.local import Local, legacy_socket
from server.canvas.project import ProjectStore
from server.canvas.sessions import AgentHub
from server.canvas.terminal import Terminals
from server.canvas.trash import Trash, TrashError

REPO = Path(__file__).resolve().parents[1]
NID = "65b04644-6b78-49c7-b0df-b94f9d79a2fc"


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setattr(Path, "home", lambda: h)
    monkeypatch.setenv("HOME", str(h))
    return h


def project(root: Path, sessions: list[str] = ()) -> ProjectStore:
    s = ProjectStore(root)
    s.init()
    docs = [{"id": "c1", "kind": "canvas", "title": "A"}] + [{"id": f"p-{x}", "kind": "session", "sessionId": x, "title": "", "agent": "claude"} for x in sessions]
    s.write("workspace", None, {"v": 2, "docs": docs, "root": {}, "focused": "c1"}, base=None)
    s.write("canvas", "c1", {"elements": [{"id": "box1"}]}, base=None)
    return s


def bound(s: ProjectStore, sid: str, nid: str) -> None:
    s.append_session(sid, [{"t": "session", "session": {"id": sid, "canvasId": "c1"}}], base=None)
    s.bind(sid, agent="claude", model="haiku", native_id=nid, started=True)
    AgentHub(s).note_bind(sid, "bind")


def agora(*args: str, cwd: Path, home: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(REPO), "HOME": str(home)}
    return subprocess.run([sys.executable, "-m", "agora_cli", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=90)


# ——— P1-3 ———
def test_doctor_fix_never_binds_another_copy_s_session_here(tmp_path, home):
    a = project(tmp_path / "a", ["s-1"])
    Local(a).reconcile()
    bound(a, "s-1", NID)
    b_root = tmp_path / "b"  # a second clone of the same project listing the same session, bound nowhere here
    (b_root / ".agora").mkdir(parents=True)
    for f in ("config.toml", "workspace.json", ".gitignore"):
        shutil.copy(a.dir / f, b_root / ".agora" / f)
    b = ProjectStore(b_root)
    b.init()
    Local(b).reconcile()
    r = agora("doctor", "--fix", cwd=b.root, home=home)
    assert b.read_binding("s-1") is None, r.stdout  # before: B got A's Claude native id
    assert "另一份副本" in r.stdout and "分叉" in r.stdout


# ——— P1-4 ———
def plant(store: ProjectStore, rel: str, name: str) -> str:
    tid = f"{int(time.time() * 1000)}-canvas-c9"
    d = store.dir / "trash" / tid
    d.mkdir(parents=True)
    (d / name).write_text("planted")
    (d / "manifest.json").write_text(json.dumps({"trashId": tid, "kind": "canvas", "id": "c9", "at": int(tid.split("-")[0]), "files": [{"rel": rel, "name": name}]}))
    return tid


def test_a_planted_manifest_cannot_write_outside_agora(tmp_path):
    s = project(tmp_path / "p")
    tid = plant(s, "../../outside/planted.txt", "x")
    t = Trash(s)
    assert t.list() == []  # not an item this code could have written
    with pytest.raises(KeyError):
        t.restore(tid)
    assert not (tmp_path / "outside").exists()


def test_symlinks_in_a_trash_item_are_not_followed(tmp_path):
    s = project(tmp_path / "p")
    secret = tmp_path / "secret.txt"
    secret.write_text("not yours")
    tid = f"{int(time.time() * 1000)}-canvas-c9"
    d = s.dir / "trash" / tid
    d.mkdir(parents=True)
    (d / "canvases__c9.excalidraw").symlink_to(secret)
    (d / "manifest.json").write_text(json.dumps({"trashId": tid, "kind": "canvas", "id": "c9", "at": int(tid.split("-")[0]), "files": [{"rel": "canvases/c9.excalidraw", "name": "canvases__c9.excalidraw"}]}))
    Trash(s).restore(tid)
    assert not (s.dir / "canvases" / "c9.excalidraw").exists() and secret.read_text() == "not yours"


def test_trash_that_came_through_git_is_ignored_and_reported(tmp_path, home):
    s = project(tmp_path / "p")
    subprocess.run(["git", "init", "-q"], cwd=s.root, check=True)
    m = Trash(s).put("canvas", "c1", title="A")  # a real item …
    subprocess.run(["git", "add", "-f", ".agora/trash"], cwd=s.root, check=True)  # … shipped through git
    t = Trash(s)
    assert t.committed() == {m["trashId"]} and t.list() == []
    with pytest.raises(TrashError):
        t.restore(m["trashId"])
    assert "被 git 跟踪" in agora("doctor", cwd=s.root, home=home).stdout


# ——— P1-5 ———
def test_a_backup_never_brings_back_a_session_trashed_after_it(tmp_path, home):
    s = project(tmp_path / "p", ["s-1", "s-2"])
    Local(s).reconcile()
    bound(s, "s-1", "n-1")
    bound(s, "s-2", "n-2")
    assert Backups(s, Local(s)).make(force=True)
    time.sleep(0.01)
    from fastapi import APIRouter
    from fastapi.testclient import TestClient

    from server.canvas.project_router import create_project_app

    c = TestClient(create_project_app(s.root, canvas_router=APIRouter()))
    trashed = c.post("/api/project/trash/session/s-2", json={}).json()
    (s.dir / "sessions" / "s-1.jsonl").unlink()  # something else is missing: --fix restores it
    r = agora("doctor", "--fix", cwd=s.root, home=home)
    assert (s.dir / "sessions" / "s-1.jsonl").exists(), r.stdout
    assert not (s.dir / "sessions" / "s-2.jsonl").exists() and s.read_binding("s-2") is None  # still in the trash only
    back = c.post(f"/api/project/trash/{trashed['trashId']}/restore").json()
    assert back["id"] == "s-2"  # not s-2-r1: one Agora session per native session
    natives = [b["nativeId"] for b in s.bindings().values()]
    assert sorted(natives) == ["n-1", "n-2"]
    # restored after the backup: a later restore of that backup does not duplicate it either
    (s.dir / "sessions" / "s-2.jsonl").unlink()
    assert "sessions/s-2.jsonl" not in Backups(s, Local(s)).restore()


# ——— P2 ———
def test_history_is_bounded_and_pruned(tmp_path, monkeypatch):
    s = project(tmp_path / "p")
    Local(s).reconcile()
    now = [1_800_000_000.0]
    h = FileHistory(Local(s), clock=lambda: now[0])
    monkeypatch.setattr(backup, "HISTORY_MAX_BYTES", 2500)
    for i in range(6):
        now[0] += 601
        h.keep("canvases/c1.excalidraw", b"x" * 1000)
    total = sum(f.stat().st_size for f in h.dir.rglob("*") if f.is_file())
    assert total <= 2500 and len(h.versions("canvases/c1.excalidraw")) == 2  # the newest two
    h.keep("canvases/gone.excalidraw", b"old")
    old_inst = h.dir.parent / "an-old-instance"
    old_inst.mkdir()
    (old_inst / "x").write_text("x")
    os.utime(old_inst / "x", (0, 0))
    now[0] += 31 * 86400
    gone = h.prune({"canvases/c1.excalidraw", "workspace.json"})
    assert "canvases/gone.excalidraw" in gone and "an-old-instance" in gone
    assert h.versions("canvases/c1.excalidraw")  # a file that exists keeps its versions


def test_backups_leave_big_snapshots_out_and_stay_under_the_cap(tmp_path, monkeypatch):
    s = project(tmp_path / "p")
    Local(s).reconcile()
    snaps = s.dir / "sessions" / "snapshots"
    snaps.mkdir(parents=True)
    (snaps / "s-big.jsonl").write_bytes(os.urandom(4000))
    (s.dir / "sessions" / "s-big.jsonl").write_text("{}\n")
    monkeypatch.setattr(backup, "BACKUP_SOURCE_MAX", 1000)
    made = Backups(s, Local(s)).make(force=True)
    assert made["skipped"] == ["sessions/snapshots/s-big.jsonl"]
    monkeypatch.setattr(backup, "BACKUPS_MAX_BYTES", made["size"] + 1)
    now = [time.time() + 10]
    b = Backups(s, Local(s), clock=lambda: now[0])
    for _ in range(3):
        now[0] += 86400
        b.make()
    assert len(b.list()) == 1  # over the size cap: only the newest stays


def test_an_old_project_upgraded_in_place_is_the_same_copy_not_a_fresh_clone(tmp_path, home):
    s = project(tmp_path / "p", ["s-1"])
    s.bind("s-1", agent="claude", native_id=NID, started=True)  # bound before instance ids existed
    loc = Local(s)
    assert loc.classify()["kind"] == "upgraded"
    change = loc.reconcile()
    assert change["kind"] == "upgraded" and loc.change() is None  # no "not on this machine" notice
    assert loc.registry.binds(loc.project_id(), loc.instance_id())["s-1"]["nativeId"] == NID


@pytest.mark.skipif(shutil.which("tmux") is None, reason="needs tmux")
def test_a_pane_on_the_old_path_hash_socket_is_still_seen_and_closed(tmp_path):
    s = project(tmp_path / "p")
    old = legacy_socket(s.root)
    old_terms = Terminals(s.root, s.run_dir, socket=old)
    try:
        old_terms.open("s-1", ["sleep", "300"], cwd=s.root, env={})
        Local(s).reconcile()
        loc = Local(s)
        terms = Terminals(s.root, s.run_dir, socket=loc.socket(), legacy=loc.legacy_sockets())
        assert terms.socket != old and terms.alive("s-1")  # before: invisible after the upgrade
        assert old in terms.attach_command("s-1")
        # a Pi log in use is not moved, a headless turn does not start beside it: both ask alive()
        terms.kill("s-1")
        assert not old_terms.alive("s-1")
    finally:
        old_terms.kill_server()


def test_plain_doctor_writes_nothing(tmp_path, home):
    s = project(tmp_path / "p", ["s-1"])
    shutil.rmtree(s.dir / "local", ignore_errors=True)
    before = sorted(str(p.relative_to(s.dir)) for p in s.dir.rglob("*"))
    r = agora("doctor", cwd=s.root, home=home)
    after = sorted(str(p.relative_to(s.dir)) for p in s.dir.rglob("*"))
    assert after == before, r.stdout  # no instance.json, no server.json, no skill links
    assert "还没对账" in r.stdout or "新 clone" in r.stdout


def test_history_log_stats_are_cached_until_the_log_changes(tmp_path, monkeypatch):
    from server.canvas import discover
    from server.canvas.discover import log_stats

    log = tmp_path / "x.jsonl"
    log.write_text('{"type":"user","uuid":"u1","timestamp":"2026-09-28T00:00:00Z","message":{"content":"hi"}}\n')
    calls = []
    real = discover.scan_log
    monkeypatch.setattr(discover, "scan_log", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    assert log_stats("claude", log)["turns"] == 1
    assert log_stats("claude", log)["turns"] == 1 and len(calls) == 1
    with open(log, "a") as fh:
        fh.write('{"type":"user","uuid":"u2","timestamp":"2026-09-28T00:01:00Z","message":{"content":"again"}}\n')
    assert log_stats("claude", log)["turns"] == 2 and len(calls) == 2
