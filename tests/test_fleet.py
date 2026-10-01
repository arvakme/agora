"""`agora dev status / gc`: which servers run on this machine, from which code, and clearing the dead ones."""

import json
import subprocess
from pathlib import Path

import pytest

from agora_cli import fleet
from server.canvas import version

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def state(tmp_path, monkeypatch):
    monkeypatch.setenv("AGORA_STATE_DIR", str(tmp_path / "state"))
    (tmp_path / "state" / "servers").mkdir(parents=True)
    return tmp_path / "state" / "servers"


def record(state: Path, iid: str, root: Path, *, pid: int = 4242, port: int = 5000, sha: str | None = "a" * 40) -> Path:
    path = state / f"{iid}.json"
    path.write_text(json.dumps({"pid": pid, "port": port, "root": str(root), "mode": "dist", "startedAt": "2026-10-01T10:00:00+0800", "sha": sha, "dirty": False}))
    state.joinpath(f"{iid}.lock").write_text(str(pid))
    return path


def serving(monkeypatch, pids: set[int], *, ours: bool = True):
    """Only ``pids`` are alive and answering on their port; ``ours``: their command line is an ``agora_cli serve``."""
    monkeypatch.setattr(fleet, "alive", lambda pid: pid in pids)
    monkeypatch.setattr(fleet, "health", lambda port: {"pid": port - 1000} if port - 1000 in pids else None)
    monkeypatch.setattr(fleet, "is_serve", lambda pid, root: ours and pid in pids)
    stopped: list[int] = []
    monkeypatch.setattr(fleet, "stop", lambda pid, timeout=8.0: stopped.append(pid))
    return stopped


def test_status_tells_a_live_server_from_a_dead_one_and_shows_the_code_it_runs(state, tmp_path, monkeypatch):
    live_root, dead_root = tmp_path / "live", tmp_path / "dead"
    live_root.mkdir(), dead_root.mkdir()
    record(state, "iid-live", live_root, pid=4242, port=5242, sha="1234567" + "0" * 33)
    record(state, "iid-dead", dead_root, pid=9999, port=5999)
    serving(monkeypatch, {4242})

    shown = fleet.instances()
    assert [r["alive"] for r in shown] == [True, False]  # answering first, whatever the order of the records
    rows = {r["root"]: r for r in shown}

    assert rows[str(live_root)]["alive"] is True and rows[str(live_root)]["sha"].startswith("1234567")
    assert rows[str(dead_root)]["alive"] is False


def test_status_names_a_server_whose_project_folder_is_gone(state, tmp_path, monkeypatch):
    record(state, "iid-gone", tmp_path / "moved-away", pid=4242, port=5242)
    serving(monkeypatch, {4242})

    (row,) = fleet.instances()

    assert row["alive"] is True and row["rootGone"] is True


def test_gc_clears_the_record_and_lock_of_a_dead_server_and_leaves_a_live_one(state, tmp_path, monkeypatch):
    live_root, dead_root = tmp_path / "live", tmp_path / "dead"
    live_root.mkdir(), dead_root.mkdir()
    record(state, "iid-live", live_root, pid=4242, port=5242)
    record(state, "iid-dead", dead_root, pid=9999, port=5999)
    stopped = serving(monkeypatch, {4242})

    cleared = fleet.gc()

    assert [c["root"] for c in cleared] == [str(dead_root)]
    assert not (state / "iid-dead.json").exists() and not (state / "iid-dead.lock").exists()
    assert (state / "iid-live.json").exists() and (state / "iid-live.lock").exists() and stopped == []
    assert dead_root.exists()  # the project folder is never touched


def test_gc_stops_a_live_server_whose_folder_is_gone_only_when_it_is_really_ours(state, tmp_path, monkeypatch):
    record(state, "iid-gone", tmp_path / "moved-away", pid=4242, port=5242)
    stopped = serving(monkeypatch, {4242}, ours=False)

    assert fleet.gc() == [] and stopped == [] and (state / "iid-gone.json").exists()  # some other process owns that pid

    stopped = serving(monkeypatch, {4242}, ours=True)
    assert [c["root"] for c in fleet.gc()] == [str(tmp_path / "moved-away")] and stopped == [4242]
    assert not (state / "iid-gone.json").exists()


def test_gc_leaves_a_hung_server_for_agora_down_to_find(state, tmp_path, monkeypatch):
    root = tmp_path / "hung"
    root.mkdir()
    record(state, "iid-hung", root, pid=4242, port=9999)  # the process lives, nothing answers on its port
    stopped = serving(monkeypatch, {4242})

    (row,) = fleet.instances()
    assert row["alive"] is True and row["answering"] is False
    assert fleet.gc() == [] and stopped == [] and (state / "iid-hung.json").exists() and (state / "iid-hung.lock").exists()


def test_a_record_that_cannot_be_read_is_reported_not_deleted(state, tmp_path, monkeypatch):
    (state / "broken.json").write_text("{not json")
    serving(monkeypatch, set())

    assert fleet.instances() == [] and fleet.gc() == []
    assert (state / "broken.json").exists()


def test_code_version_is_the_checkout_head_and_flags_uncommitted_changes():
    v = version.code_version(REPO)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    assert v["sha"] == head and isinstance(v["dirty"], bool)


def test_code_version_outside_git_is_unknown_not_invented(tmp_path):
    assert version.code_version(tmp_path) == {"sha": None, "dirty": False}


def test_the_page_is_told_which_code_the_server_runs(tmp_path):
    from fastapi.testclient import TestClient

    from server.canvas.project_router import create_project_app

    with TestClient(create_project_app(tmp_path)) as c:
        snap, health = c.get("/api/project/snapshot").json(), c.get("/api/project/health").json()
    want = version.running_version()
    assert snap["build"] == want and (health["sha"], health["dirty"]) == (want["sha"], want["dirty"])
