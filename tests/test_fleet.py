"""`agora dev status / gc`: which servers run on this machine, from which code, and clearing the dead ones."""

import fcntl
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


def serving(monkeypatch, pids: set[int]):
    """Only ``pids`` are alive, and answering on their port."""
    monkeypatch.setattr(fleet, "alive", lambda pid: pid in pids)
    monkeypatch.setattr(fleet, "health", lambda port: {"pid": port - 1000} if port - 1000 in pids else None)


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


def test_status_names_a_server_whose_project_folder_is_gone_and_how_to_stop_it(state, tmp_path, monkeypatch, capsys):
    record(state, "iid-gone", tmp_path / "moved-away", pid=4242, port=5242)
    serving(monkeypatch, {4242})

    (row,) = fleet.instances()
    fleet.cmd_status(None, None)

    assert row["alive"] is True and row["rootGone"] is True
    assert "kill 4242" in capsys.readouterr().out


def test_gc_removes_the_record_of_a_dead_server_and_leaves_a_live_one(state, tmp_path, monkeypatch):
    live_root, dead_root = tmp_path / "live", tmp_path / "dead"
    live_root.mkdir(), dead_root.mkdir()
    record(state, "iid-live", live_root, pid=4242, port=5242)
    record(state, "iid-dead", dead_root, pid=9999, port=5999)
    serving(monkeypatch, {4242})

    cleared = fleet.gc()

    assert [c["root"] for c in cleared] == [str(dead_root)]
    assert not (state / "iid-dead.json").exists() and (state / "iid-dead.lock").exists()  # the lock file is what the next server locks
    assert (state / "iid-live.json").exists() and (state / "iid-live.lock").exists()
    assert dead_root.exists()  # the project folder is never touched


def test_gc_never_ends_a_server_that_runs_even_when_its_project_folder_looks_gone(state, tmp_path, monkeypatch):
    # A folder on a volume that is unmounted for a minute is "gone" to an existence check; the server is still fine.
    record(state, "iid-gone", tmp_path / "moved-away", pid=4242, port=5242)
    serving(monkeypatch, {4242})

    assert fleet.gc() == [] and (state / "iid-gone.json").exists()


def test_gc_leaves_a_hung_server_for_agora_down_to_find(state, tmp_path, monkeypatch):
    root = tmp_path / "hung"
    root.mkdir()
    record(state, "iid-hung", root, pid=4242, port=9999)  # the process lives, nothing answers on its port
    serving(monkeypatch, {4242})

    (row,) = fleet.instances()
    assert row["alive"] is True and row["answering"] is False
    assert fleet.gc() == [] and (state / "iid-hung.json").exists() and (state / "iid-hung.lock").exists()


def test_gc_keeps_the_record_while_a_server_holds_the_instance_lock(state, tmp_path, monkeypatch):
    # A starting server takes the lock before it replaces the record: the old (dead) record is not ours to remove then.
    root = tmp_path / "starting"
    root.mkdir()
    record(state, "iid-new", root, pid=9999, port=5999)
    serving(monkeypatch, set())
    with open(state / "iid-new.lock", "a+") as server:
        fcntl.flock(server, fcntl.LOCK_EX | fcntl.LOCK_NB)

        assert fleet.gc() == [] and (state / "iid-new.json").exists()
    assert [c["root"] for c in fleet.gc()] == [str(root)] and not (state / "iid-new.json").exists()


@pytest.mark.parametrize("content", [b"{not json", b"\xff\xfe not utf-8"])
def test_a_record_that_cannot_be_read_is_skipped_not_deleted_and_does_not_stop_the_rest(state, tmp_path, monkeypatch, content):
    live = tmp_path / "live"
    live.mkdir()
    (state / "broken.json").write_bytes(content)
    record(state, "iid-live", live, pid=4242, port=5242)
    serving(monkeypatch, {4242})

    assert [r["root"] for r in fleet.instances()] == [str(live)] and fleet.gc() == []
    assert (state / "broken.json").exists()


def test_the_commit_is_shown_with_what_is_known_about_uncommitted_changes():
    row = {"sha": "1234567" + "0" * 33}
    assert fleet._sha({**row, "dirty": False}) == "1234567"
    assert fleet._sha({**row, "dirty": True}) == "1234567+dirty"
    assert fleet._sha({**row, "dirty": None}) == "1234567+?"  # git could not say
    assert fleet._sha({"sha": None, "dirty": None}) == "unknown"


def test_code_version_is_the_checkout_head_and_flags_uncommitted_changes(tmp_path):
    def git(*args):
        return subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=tmp_path, capture_output=True, text=True, check=True).stdout.strip()

    git("init", "-q")
    (tmp_path / "a.txt").write_text("one")
    git("add", ".")
    git("commit", "-qm", "init")
    clean = version.code_version(tmp_path)
    assert clean == {"sha": git("rev-parse", "HEAD"), "dirty": False}
    (tmp_path / "a.txt").write_text("two")
    (tmp_path / "untracked.txt").write_text("x")
    assert version.code_version(tmp_path) == {"sha": clean["sha"], "dirty": True}


def test_code_version_outside_git_is_unknown_not_invented(tmp_path):
    assert version.code_version(tmp_path) == {"sha": None, "dirty": None}


def test_a_git_that_cannot_report_status_is_not_called_clean(tmp_path, monkeypatch):
    monkeypatch.setattr(version, "_git", lambda repo, *args: "b" * 40 if args[0] == "rev-parse" else None)
    assert version.code_version(tmp_path) == {"sha": "b" * 40, "dirty": None}


def test_the_page_is_told_which_code_the_server_runs(tmp_path):
    from fastapi.testclient import TestClient

    from server.canvas.project_router import create_project_app

    with TestClient(create_project_app(tmp_path)) as c:
        snap, health = c.get("/api/project/snapshot").json(), c.get("/api/project/health").json()
    want = version.running_version()
    assert snap["build"] == want and (health["sha"], health["dirty"]) == (want["sha"], want["dirty"])
