"""`agora up / status / down` with real server processes: reuse, per-project ports, clean stop."""

import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _state_dir(tmp_path, monkeypatch):
    """The per-machine server records go to a temporary directory, not ~/.local/state/agora."""
    monkeypatch.setenv("AGORA_STATE_DIR", str(tmp_path / "agora-state"))


def agora(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(REPO)}
    return subprocess.run([sys.executable, "-m", "agora_cli", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=90)


def get(url: str):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())


def test_up_reuse_isolation_down(tmp_path):
    a, b = tmp_path / "alpha", tmp_path / "beta"
    a.mkdir(), b.mkdir()
    try:
        r1 = agora("up", cwd=a)
        assert r1.returncode == 0, r1.stderr
        assert "started" in r1.stdout
        sa = json.loads((a / ".agora" / "run" / "server.json").read_text())
        assert (a / ".agora" / "config.toml").exists() and (a / ".agora" / ".gitignore").exists()

        r2 = agora("up", "--project", str(a), cwd=tmp_path)  # same project → same instance
        assert r2.returncode == 0 and "already running" in r2.stdout
        assert json.loads((a / ".agora" / "run" / "server.json").read_text())["pid"] == sa["pid"]

        assert agora("up", cwd=b).returncode == 0
        sb = json.loads((b / ".agora" / "run" / "server.json").read_text())
        assert sb["port"] != sa["port"] and sb["pid"] != sa["pid"]

        ha, hb = get(f"http://127.0.0.1:{sa['port']}/api/project"), get(f"http://127.0.0.1:{sb['port']}/api/project")
        assert (ha["name"], hb["name"]) == ("alpha", "beta") and ha["root"] == str(a.resolve())

        req = urllib.request.Request(
            f"http://127.0.0.1:{sa['port']}/api/project/workspace",
            data=json.dumps({"data": {"from": "alpha"}, "base": None}).encode(),
            headers={"content-type": "application/json"},
            method="PUT",
        )
        urllib.request.urlopen(req, timeout=5).read()
        assert (a / ".agora" / "workspace.json").exists() and not (b / ".agora" / "workspace.json").exists()

        assert agora("status", cwd=a).returncode == 0
    finally:
        da, db = agora("down", cwd=a), agora("down", cwd=b)
    assert da.returncode == 0 and "released" in da.stdout, da.stdout
    assert db.returncode == 0 and "released" in db.stdout, db.stdout
    assert agora("status", cwd=a).returncode == 1
    assert not (a / ".agora" / "run" / "server.json").exists()


def test_losing_run_dir_never_starts_a_second_server_and_down_still_stops_it(tmp_path):
    """B5: `git clean -fdx` removed .agora/run/ while the server ran; the next `up` started a
    second server on the same .agora/ and `down` said "not running"."""
    from agora_cli.main import alive, free_port
    from server.canvas.terminal import Terminals

    from server.canvas.local import Local
    from server.canvas.project import ProjectStore

    proj = tmp_path / "proj"
    proj.mkdir()
    root = proj.resolve()
    terms = None
    try:
        assert agora("up", cwd=proj).returncode == 0
        terms = Terminals(root, root / ".agora" / "run", socket=Local(ProjectStore(root)).socket())  # the instance's socket
        first = json.loads((proj / ".agora" / "run" / "server.json").read_text())
        terms.open("s-x", ["sleep", "300"], cwd=root, env={})  # a session's pane on this project's tmux server
        assert "agora-s-x" in terms.sessions()

        shutil.rmtree(proj / ".agora" / "run")  # what `git clean -fdx` does to it
        again = agora("up", cwd=proj)
        assert again.returncode == 0 and "already running" in again.stdout, again.stdout + again.stderr
        assert json.loads((proj / ".agora" / "run" / "server.json").read_text())["pid"] == first["pid"]  # written back

        # Even without any record, a second server for this directory refuses to start (the lock).
        second = agora("serve", "--project", str(proj), "--port", str(free_port()), cwd=tmp_path)
        assert second.returncode == 3 and "already running" in second.stderr

        shutil.rmtree(proj / ".agora" / "run")
        down = agora("down", cwd=proj)
        assert down.returncode == 0 and "released" in down.stdout, down.stdout + down.stderr
        assert not alive(first["pid"])
        assert terms.sessions() == []  # the project's tmux server is gone too
    finally:
        agora("down", cwd=proj)
        if terms is not None:
            terms.kill_server()


def test_down_stops_a_hung_server_whose_run_dir_and_record_are_gone(tmp_path):
    """Review P2-3: a server that no longer answers, with run/ and its record gone: `up` said "run
    `agora down`", `down` said "not running" and left it holding the lock. The pid it wrote into its
    lock file finds it; its command line is checked before it is stopped."""
    import signal

    from agora_cli.main import Project, alive

    proj = tmp_path / "proj"
    proj.mkdir()
    assert agora("up", cwd=proj).returncode == 0
    pid = json.loads((proj / ".agora" / "run" / "server.json").read_text())["pid"]
    p = Project(str(proj))
    try:
        os.kill(pid, signal.SIGSTOP)  # hung: holds the lock, answers nothing
        shutil.rmtree(proj / ".agora" / "run")
        p.record.unlink()
        up = agora("up", cwd=proj)
        assert up.returncode == 2 and "agora down" in up.stderr
        down = agora("down", cwd=proj)
        assert down.returncode == 0 and "stopped" in down.stdout, down.stdout + down.stderr
        assert not alive(pid)
    finally:
        if alive(pid):
            os.kill(pid, signal.SIGKILL)


def test_moving_a_running_project_stops_the_old_server_and_down_clears_old_sockets(tmp_path):
    """B6 with instance ids: the server left behind at the old path (refusing writes) is stopped by
    `up` at the new path; `down` also stops tmux servers under the old path-hash names."""
    import subprocess as sp

    from agora_cli.main import alive
    from server.canvas.local import legacy_socket

    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    old_sock = legacy_socket(a.resolve())
    try:
        assert agora("up", cwd=a).returncode == 0
        first = json.loads((a / ".agora" / "run" / "server.json").read_text())
        sp.run(["tmux", "-L", old_sock, "-f", "/dev/null", "new-session", "-d", "-s", "agora-s-old", "sleep", "300"], check=True)
        a.rename(b)
        up = agora("up", cwd=b)
        assert up.returncode == 0 and "started" in up.stdout and "移到了" in up.stdout, up.stdout + up.stderr
        assert not alive(first["pid"])
        down = agora("down", cwd=b)
        assert down.returncode == 0 and f"stopped tmux server {old_sock}" in down.stdout, down.stdout
        assert sp.run(["tmux", "-L", old_sock, "list-sessions"], capture_output=True).returncode != 0
    finally:
        agora("down", cwd=b)
        sp.run(["tmux", "-L", old_sock, "kill-server"], capture_output=True)


def test_up_in_a_copy_of_a_running_project_leaves_the_original_server_alone(tmp_path):
    """cp -r of a running project copies its run/server.json; `up` in the copy took that server for
    a crashed leftover of its own and stopped it."""
    from agora_cli.main import alive

    a = tmp_path / "orig"
    a.mkdir()
    assert agora("up", cwd=a).returncode == 0
    orig = json.loads((a / ".agora" / "run" / "server.json").read_text())
    b = tmp_path / "copy"
    try:
        shutil.copytree(a, b, ignore=shutil.ignore_patterns("*.lock"))
        up = agora("up", cwd=b)
        assert up.returncode == 0 and "副本" in up.stdout, up.stdout + up.stderr
        assert alive(orig["pid"]) and agora("status", cwd=a).returncode == 0
        mine = json.loads((b / ".agora" / "run" / "server.json").read_text())
        assert mine["pid"] != orig["pid"]
    finally:
        agora("down", cwd=b)
        agora("down", cwd=a)

