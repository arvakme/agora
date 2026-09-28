"""A session run in another work tree of the project's repository writes absolute paths under that work
tree (``/…/wt-fix/server/app.py``); the pointer must land them on the same diagram node as the project's
own ``server/app.py``. Work trees already deleted after their merge still count when they sat beside a
live one and the rest of the path starts at a top-level entry of the project. Anything else stays outside."""

import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.adapters import runs
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app

SID = "22222222-0000-0000-0000-000000000002"


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True, capture_output=True)


@pytest.fixture()
def repo(tmp_path):
    """A repository with a project checkout and one linked work tree beside it."""
    main = tmp_path / "work" / "main"
    (main / "server").mkdir(parents=True)
    (main / "server" / "app.py").write_text("x = 1\n")
    git(main.parent, "init", "-q", str(main))
    git(main, "add", ".")
    git(main, "commit", "-qm", "init")
    linked = tmp_path / "work" / "wt-fix"
    git(main, "worktree", "add", "-q", "--detach", str(linked))
    return main, linked


def test_paths_in_another_worktree_are_relative_to_that_worktree(repo):
    main, linked = repo
    root = str(main)
    assert runs.repo_relative(f"{linked}/server/app.py", root) == "server/app.py"
    assert runs.repo_relative(f"{main}/server/app.py", root) == "server/app.py"
    assert runs.repo_relative(f"{linked}", root) == ""
    # a work tree deleted after its merge: a sibling of a live one, the rest starts at a top-level entry
    assert runs.repo_relative(f"{main.parent}/wt-gone/server/app.py", root) == "server/app.py"
    # not inside the repository: unchanged (and so outside the diagram)
    assert runs.repo_relative("/etc/hosts", root) == "/etc/hosts"
    assert runs.repo_relative(f"{main.parent}/wt-gone/other/app.py", root) == f"{main.parent}/wt-gone/other/app.py"
    assert runs.repo_relative(f"{main.parent}/wt-fix2", root) == f"{main.parent}/wt-fix2"
    assert runs.repo_relative("server/app.py", root) == "server/app.py"


def test_runs_place_edits_from_other_worktrees_on_their_nodes(repo, tmp_path, monkeypatch):
    main, linked = repo
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)
    s = ProjectStore(main)
    s.init()
    d = home / ".claude" / "projects" / agents.claude_dir_name(str(main))
    d.mkdir(parents=True)
    paths = [f"{linked}/server/app.py", f"{main.parent}/wt-gone/server/app.py", "/etc/hosts"]
    recs = [{"type": "user", "uuid": "u", "timestamp": "2026-09-28T01:00:00Z", "cwd": str(main), "message": {"content": "改一下"}}]
    for i, p in enumerate(paths):
        recs.append({"type": "assistant", "uuid": f"a{i}", "timestamp": f"2026-09-28T01:00:{i * 2 + 1:02d}Z", "message": {"id": f"m{i}", "content": [{"type": "tool_use", "id": f"t{i}", "name": "Edit", "input": {"file_path": p, "old_string": "a", "new_string": "b"}}]}})
        recs.append({"type": "user", "uuid": f"r{i}", "timestamp": f"2026-09-28T01:00:{i * 2 + 2:02d}Z", "message": {"content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": "ok"}]}})
    (d / f"{SID}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in recs))
    s.bind("s-1", agent="claude", model="haiku", native_id=SID, started=True)
    s.write("canvas", "c1", {"elements": [{"id": "api", "type": "rectangle", "customData": {"codePaths": ["server/**"]}}]}, base=None)
    got = TestClient(create_project_app(s.root)).get("/api/agent/runs", params={"session": "s-1", "canvas": "c1", "receipts": 0}).json()
    segs = [x for x in got["runs"][0]["timeline"]["segments"] if x["kind"] == "write"]
    assert [x.get("node") for x in segs] == ["api", "api", None]
