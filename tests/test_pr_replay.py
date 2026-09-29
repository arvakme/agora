"""PR replays (web/docs/pr-replay.md): ``agora replay import-pr`` turns a merged PR into
``.agora/replays/pr-<N>.json`` (its commits in time order and the files each one touched), from GitHub via
``gh`` when it works, else from the squash commit on the project's history; ``/api/project/replays`` serves them.
``gh`` is stubbed with local samples: nothing here touches the network."""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.canvas import replays
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app

PR_VIEW = {
    "number": 7,
    "headRefName": "gone-fix2",
    "title": "云电脑没了，派活暂停随之收口（#6）",
    "author": {"login": "arvak", "name": "Arvak"},
    "url": "https://github.com/acme/app/pull/7",
    "mergedAt": "2026-09-28T08:07:00Z",
    # deliberately not in time order: the file must be
    "commits": [
        {"oid": "bbb2222", "messageHeadline": "第二步：删旧文件并改名", "committedDate": "2026-09-28T07:50:00Z"},
        {"oid": "aaa1111", "messageHeadline": "第一步：加新文件", "committedDate": "2026-09-28T07:40:00Z"},
        {"oid": "ccc3333", "messageHeadline": "Merge remote-tracking branch 'origin/main'", "committedDate": "2026-09-28T07:55:00Z"},
    ],
}
COMMIT_FILES = {
    # a merge of main into the branch: the other PRs' files are not this PR's work
    "ccc3333": {"parents": [{"sha": "p1"}, {"sha": "p2"}], "files": [{"filename": "other/x.go", "status": "modified", "additions": 50, "deletions": 5}]},
    "aaa1111": {"files": [
        {"filename": "server/new.py", "status": "added", "additions": 12, "deletions": 0},
        {"filename": "server/app.py", "status": "modified", "additions": 3, "deletions": 1},
    ]},
    "bbb2222": {"files": [
        {"filename": "server/old.py", "status": "removed", "additions": 0, "deletions": 9},
        {"filename": "web/b.ts", "previous_filename": "web/a.ts", "status": "renamed", "additions": 0, "deletions": 0},
    ]},
}


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.name=Arvak", "-c", "user.email=a@x", *args], check=True, capture_output=True, text=True).stdout


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    """No test reads the real ~/.claude, ~/.codex or ~/.pi."""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    return h


@pytest.fixture()
def project(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    git(root, "init", "-q")
    git(root, "remote", "add", "origin", "git@github.com:acme/app.git")
    (root / "server").mkdir()
    (root / "web").mkdir()
    (root / "server" / "app.py").write_text("a = 1\n")
    (root / "server" / "old.py").write_text("x\n" * 9)
    (root / "web" / "a.ts").write_text("export const a = 1;\n" * 5)
    git(root, "add", ".")
    git(root, "commit", "-qm", "init")
    ProjectStore(root).init()
    (root / ".git" / "info" / "exclude").write_text(".agora/\n")
    return root


def gh_stub(calls: list):
    def run(argv, cwd):
        calls.append(argv)
        if argv[:3] == ["gh", "pr", "view"]:
            return json.dumps(PR_VIEW)
        if argv[:2] == ["gh", "api"]:
            return json.dumps(COMMIT_FILES[argv[2].rsplit("/", 1)[1]])
        return subprocess.run(argv, cwd=cwd, check=True, capture_output=True, text=True).stdout

    return run


def broken_gh(argv, cwd):
    if argv[0] == "gh":
        raise FileNotFoundError("gh")
    return subprocess.run(argv, cwd=cwd, check=True, capture_output=True, text=True).stdout


def test_github_import_keeps_commits_in_time_order_with_ops(project):
    calls: list = []
    out = replays.import_pr(project, 7, run=gh_stub(calls))
    got = json.loads((project / ".agora" / "replays" / "pr-7.json").read_text())
    assert out["source"] == "github" and (out["commits"], out["files"]) == (2, 4)
    assert got["id"] == "pr-7" and got["kind"] == "pr" and got["number"] == 7 and got["source"] == "github"
    assert got["author"] == "Arvak" and got["url"] == "https://github.com/acme/app/pull/7" and got["mergedAt"] == "2026-09-28T08:07:00Z"
    assert [c["sha"] for c in got["commits"]] == ["aaa1111", "bbb2222"]
    assert [c["title"] for c in got["commits"]] == ["第一步：加新文件", "第二步：删旧文件并改名"]
    assert got["commits"][0]["at"] == "2026-09-28T07:40:00Z"
    assert got["commits"][0]["files"] == [{"path": "server/new.py", "op": "add", "additions": 12, "deletions": 0}, {"path": "server/app.py", "op": "edit", "additions": 3, "deletions": 1}]
    assert got["commits"][1]["files"] == [{"path": "server/old.py", "op": "delete", "additions": 0, "deletions": 9}, {"path": "web/b.ts", "op": "rename", "additions": 0, "deletions": 0}]
    # the repository is read off the origin remote; gh does the login
    assert ["gh", "pr", "view", "7", "--repo", "acme/app"] == next(c for c in calls if c[0] == "gh")[:6]
    assert any(c[:3] == ["gh", "api", "repos/acme/app/commits/aaa1111"] for c in calls)
    assert replays.import_pr(project, 7, run=gh_stub([]))["commits"] == 2  # importing again overwrites


def test_merge_commits_are_left_out(project):
    replays.import_pr(project, 7, run=gh_stub([]))
    got = json.loads((project / ".agora" / "replays" / "pr-7.json").read_text())
    assert "ccc3333" not in [c["sha"] for c in got["commits"]] and all(f["path"] != "other/x.go" for c in got["commits"] for f in c["files"])


def test_repo_option_wins_over_the_remote(project):
    calls: list = []
    replays.import_pr(project, 7, repo="other/thing", run=gh_stub(calls))
    assert next(c for c in calls if c[0] == "gh")[4:6] == ["--repo", "other/thing"]


def squash(project: Path) -> None:
    (project / "server" / "app.py").write_text("a = 2\nb = 3\n")
    (project / "server" / "old.py").unlink()
    (project / "server" / "new.py").write_text("n\n" * 4)
    git(project, "mv", "web/a.ts", "web/b.ts")
    git(project, "add", "-A")
    git(project, "commit", "-qm", "云电脑收口 (#42)")


@pytest.mark.parametrize("run", [broken_gh, None])
def test_squash_fallback_when_gh_is_missing_or_fails(project, run):
    squash(project)

    def failing(argv, cwd):
        if argv[0] == "gh":
            raise subprocess.CalledProcessError(1, argv, stderr="not logged in")
        return subprocess.run(argv, cwd=cwd, check=True, capture_output=True, text=True).stdout

    out = replays.import_pr(project, 42, run=run or failing)
    got = json.loads((project / ".agora" / "replays" / "pr-42.json").read_text())
    assert out["source"] == "squash" and (out["commits"], out["files"]) == (1, 4)
    assert got["source"] == "squash" and got["number"] == 42 and got["title"] == "云电脑收口 (#42)" and got["author"] == "Arvak"
    (c,) = got["commits"]
    files = {f["path"]: f for f in c["files"]}
    assert files["server/new.py"]["op"] == "add" and files["server/new.py"]["additions"] == 4
    assert files["server/app.py"]["op"] == "edit" and (files["server/app.py"]["additions"], files["server/app.py"]["deletions"]) == (2, 1)
    assert files["server/old.py"]["op"] == "delete" and files["server/old.py"]["deletions"] == 9
    assert files["web/b.ts"]["op"] == "rename" and "web/a.ts" not in files


def test_unknown_pr_is_an_error_and_writes_nothing(project):
    with pytest.raises(replays.ReplayError):
        replays.import_pr(project, 999, run=broken_gh)
    assert not (project / ".agora" / "replays").exists()


def test_cli_prints_one_summary_line(project, capsys, monkeypatch):
    from agora_cli.main import main

    monkeypatch.setattr(replays, "run_cmd", gh_stub([]))
    assert main(["replay", "import-pr", "7", "--project", str(project)]) == 0
    line = capsys.readouterr().out.strip()
    assert line.count("\n") == 0 and "#7" in line and "2 个提交" in line and "4 个文件" in line and "github" in line


def client(project) -> TestClient:
    return TestClient(create_project_app(project))


def test_list_and_read_endpoints(project):
    replays.import_pr(project, 7, run=gh_stub([]))
    squash(project)
    replays.import_pr(project, 42, run=broken_gh)
    c = client(project)
    rows = c.get("/api/project/replays").json()
    assert [r["id"] for r in rows] == ["pr-42", "pr-7"]  # newest number first
    assert rows[1] == {"id": "pr-7", "kind": "pr", "number": 7, "title": PR_VIEW["title"], "author": "Arvak", "mergedAt": "2026-09-28T08:07:00Z", "source": "github", "agent": {"kind": "unknown", "source": "none"}, "commits": 2, "files": 4}
    assert rows[0]["source"] == "squash" and rows[0]["commits"] == 1
    full = c.get("/api/project/replays/pr-7").json()
    assert full["id"] == "pr-7" and len(full["commits"]) == 2 and full["commits"][0]["files"][0]["path"] == "server/new.py"


def test_list_is_empty_without_replays(project):
    assert client(project).get("/api/project/replays").json() == []


@pytest.mark.parametrize("bad", ["..%2F..%2Fconfig.toml", "pr-abc", "pr-", "pr-7x", "PR-7", "pr-7.json", "pr-12345678901234"])
def test_ids_are_validated(project, bad):
    replays.import_pr(project, 7, run=gh_stub([]))
    assert client(project).get(f"/api/project/replays/{bad}").status_code in (400, 404)
    assert not replays.valid_id(bad.replace("%2F", "/"))


def test_a_missing_replay_is_a_404_and_a_valid_id_reads(project):
    assert client(project).get("/api/project/replays/pr-5").status_code == 404
    assert replays.valid_id("pr-4315")


# ——— which agent made it ———
T0 = "2026-09-28T07:40:00Z"  # the sample PR's first commit; merged 08:07
EPOCH = time.mktime(time.strptime("2026-09-28T07:50:00", "%Y-%m-%dT%H:%M:%S")) - time.timezone  # 07:50 UTC


def log(path: Path, text: str, *, at: float = EPOCH) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    os.utime(path, (at, at))
    return path


def agent_of(project) -> dict:
    replays.import_pr(project, 7, run=gh_stub([]))
    return json.loads((project / ".agora" / "replays" / "pr-7.json").read_text())["agent"]


def test_agent_flag_wins_and_is_checked(project):
    replays.import_pr(project, 7, agent="codex", run=gh_stub([]))
    assert json.loads((project / ".agora" / "replays" / "pr-7.json").read_text())["agent"] == {"kind": "codex", "source": "flag"}
    with pytest.raises(replays.ReplayError):
        replays.import_pr(project, 7, agent="gpt", run=gh_stub([]))


def test_agent_is_read_off_a_claude_sub_agent_log_that_names_the_worktree(project, home):
    d = home / ".claude" / "projects" / "-Users-x-yuanzhuoai-dev"
    log(d / "0aa1" / "subagents" / "agent-a1.jsonl", '{"cwd": "/Users/x/intern/wt-gone-fix2", "x": "cd wt-gone-fix2 && git status"}\n' * 3)
    log(d / "0aa1.jsonl", "nothing about it\n")
    log(d / "0bb2" / "subagents" / "agent-b1.jsonl", "wt-gone-fix22 gone-fix2000\n")  # another branch that merely starts the same
    assert agent_of(project) == {"kind": "claude", "source": "session", "session": "0aa1"}


def test_only_logs_written_between_two_hours_before_the_first_commit_and_one_after_the_merge_count(project, home):
    d = home / ".claude" / "projects" / "-p"
    log(d / "old.jsonl", "wt-gone-fix2\n", at=EPOCH - 3 * 3600)  # 04:50, first commit 07:40 − 2 h = 05:40
    log(d / "late.jsonl", "wt-gone-fix2\n", at=EPOCH + 3 * 3600)  # 10:50, merge 08:07 + 1 h = 09:07
    assert agent_of(project) == {"kind": "unknown", "source": "none"}
    log(d / "edge.jsonl", "wt-gone-fix2\n", at=EPOCH - 3600)
    assert agent_of(project) == {"kind": "claude", "source": "session", "session": "edge"}


def test_a_session_that_ran_on_past_the_merge_still_counts_when_it_began_before_it(project, home):
    d = home / ".claude" / "projects" / "-p"
    text = '{"timestamp": "2026-09-28T07:14:33.000Z", "cwd": "/x/wt-gone-fix2"}\n'
    log(d / "0cc3" / "subagents" / "agent-c1.jsonl", text, at=EPOCH + 2 * 3600)  # written until 09:50, merge 08:07 + 1 h = 09:07
    log(d / "later.jsonl", text.replace("07:14", "09:30"), at=EPOCH + 2 * 3600)  # began after the window
    assert agent_of(project) == {"kind": "claude", "source": "session", "session": "0cc3"}


def test_codex_and_pi_sessions_are_found_and_the_stronger_mention_wins(project, home):
    log(home / ".codex" / "sessions" / "2026" / "09" / "28" / "rollout-2026-09-28T15-40-00-01a0e64e-f6b9-7252-8bc5-cfb23dd92b40.jsonl", "gone-fix2 gone-fix2\n")
    assert agent_of(project) == {"kind": "codex", "source": "session", "session": "01a0e64e-f6b9-7252-8bc5-cfb23dd92b40"}
    log(home / ".pi" / "agent" / "sessions" / "--Users-x--" / "2026-09-28T07-45-00-000Z_01a0e260-75ee-7675-8b71-aeec2788c55f.jsonl", "wt-gone-fix2 wt-gone-fix2 wt-gone-fix2\n")
    assert agent_of(project) == {"kind": "pi", "source": "session", "session": "01a0e260-75ee-7675-8b71-aeec2788c55f"}


def test_a_squash_import_has_no_branch_to_look_for(project, home):
    squash(project)
    log(home / ".claude" / "projects" / "-p" / "s1.jsonl", "#42 wt-gone-fix2\n")
    replays.import_pr(project, 42, run=broken_gh)
    assert json.loads((project / ".agora" / "replays" / "pr-42.json").read_text())["agent"] == {"kind": "unknown", "source": "none"}


def test_cli_agent_flag(project, capsys, monkeypatch):
    from agora_cli.main import main

    monkeypatch.setattr(replays, "run_cmd", gh_stub([]))
    assert main(["replay", "import-pr", "7", "--agent", "grok", "--project", str(project)]) == 0
    assert json.loads((project / ".agora" / "replays" / "pr-7.json").read_text())["agent"] == {"kind": "grok", "source": "flag"}
    assert "grok" in capsys.readouterr().out


# ——— review round 3 ———
@pytest.mark.parametrize("bad", ["pr-1\n", "pr-1 ", " pr-1", "pr-01", "pr-0", "pr--1", "pr-1\r\n"])
def test_valid_id_is_a_full_match_without_leading_zeros(bad):
    assert not replays.valid_id(bad)  # a trailing newline used to pass ($ matches before it); 01 would name no file the importer writes
    assert replays.valid_id("pr-1") and replays.valid_id("pr-4315") and replays.valid_id("pr-999999999")


def test_a_newline_id_is_refused_over_http(project):
    assert client(project).get("/api/project/replays/pr-1%0A").status_code == 400


def test_the_branch_is_found_across_read_blocks_and_in_big_files(project, home, monkeypatch):
    monkeypatch.setattr(replays, "CHUNK", 64)
    monkeypatch.setattr(replays, "MAX_SCAN", 2048)  # a log over this is read at its two ends only
    monkeypatch.setattr(replays, "EDGE", 512)
    d = home / ".claude" / "projects" / "-p"
    log(d / "straddle.jsonl", "x" * 59 + " wt-gone-fix2 " + "y" * 100 + "\\n")  # the name crosses a 64-byte block boundary
    assert agent_of(project)["session"] == "straddle"
    (d / "straddle.jsonl").unlink()
    big = "a" * 4000 + "\\n"
    log(d / "tail.jsonl", big * 10 + "wt-gone-fix2\\n")  # far past the limit, but inside the last EDGE bytes
    assert agent_of(project)["session"] == "tail"
    (d / "tail.jsonl").unlink()
    log(d / "middle.jsonl", "a" * 5000 + " wt-gone-fix2 " + "a" * 20000)  # in the unread middle of a big log: not looked for
    assert agent_of(project) == {"kind": "unknown", "source": "none"}


def test_a_log_is_never_read_whole(project, home, monkeypatch):
    seen = []
    real = Path.read_bytes
    monkeypatch.setattr(Path, "read_bytes", lambda self: (seen.append(self), real(self))[1])
    log(home / ".claude" / "projects" / "-p" / "s.jsonl", "wt-gone-fix2\\n")
    assert agent_of(project)["session"] == "s" and not any(p.suffix == ".jsonl" for p in seen)


def test_a_commit_id_is_checked_before_git_sees_it(project):
    with pytest.raises(replays.ReplayError):
        replays.squash_files(project, "--stat", broken_gh)
    with pytest.raises(replays.ReplayError):
        replays.squash_files(project, "HEAD; rm", broken_gh)
    seen = []
    replays.squash_files(project, git(project, "rev-parse", "HEAD").strip(), lambda argv, cwd: (seen.append(argv), broken_gh(argv, cwd))[1])
    assert all(a[-1] == "--" for a in seen)  # and git is told nothing after the id is a path
