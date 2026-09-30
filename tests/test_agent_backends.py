"""server/canvas/agents.py — the Pi / Claude Code / Codex headless backends.

Event mapping is checked against real CLI output recorded on 2026-09-28 (sanitized, in
tests/fixtures/agents/<kind>/<version>/); launches go through tests/fake_agent_cli.py so no model runs."""

import json
import sys
from pathlib import Path

import pytest

from server.canvas import agents
from server.canvas.agents import ClaudeCodeBackend, ClaudeStream, CodexBackend, CodexStream, PiBackend, PiStream, interactive_argv
from server.canvas.runner import ExecOptions, RunRequest, make_backend

from tests.agent_fixtures import legacy

FAKE = Path(__file__).parent / "fake_agent_cli.py"


def records(name: str) -> list[dict]:
    return [json.loads(line) for line in legacy(name).read_text().splitlines() if line.strip()]


def feed(mapper, name: str) -> list[dict]:
    out = []
    for i, rec in enumerate(records(name)):
        out += mapper.feed(rec, 1000 + i)
    return out


def test_claude_stream_mapping():
    m = ClaudeStream("sonnet", "00000000-0000-0000-0000-000000000001")
    evs = feed(m, "claude-stream.jsonl")
    assert [e["t"] for e in evs] == ["tool_use", "usage", "tool_result", "text", "usage"]
    assert evs[0]["name"] == "Bash" and evs[0]["input"]["command"] == "echo hi"
    assert evs[2] == {"t": "tool_result", "at": 1002, "id": evs[0]["id"], "text": "hi", "isError": False}
    assert m.done and m.error is None and m.text == "done"
    assert m.session == "c5f2efdb-1102-498e-9d76-70ea178d26f2"  # from the stream, not the guess
    u = m.final_usage(1234)
    assert u["model"] == "claude-sonnet-5" and u["costUsd"] == pytest.approx(0.1018058) and u["durationMs"] == 1234
    assert u["cacheReadTokens"] == 57239


def test_pi_stream_mapping():
    m = PiStream("magpie/group/fable-5-1", None)
    evs = feed(m, "pi-stream.jsonl")
    kinds = [e["t"] for e in evs]
    assert kinds == ["text", "tool_use", "usage", "tool_result", "text", "usage"]
    assert evs[1]["name"] == "bash" and evs[1]["input"] == {"command": "echo hi"}
    assert evs[3]["text"] == "hi\n" and evs[3]["isError"] is False
    assert m.done and m.error is None and m.text == "done"
    assert m.session == "3848dfff-ed77-4b25-b572-39918ef0b06a" and m.model == "magpie/group/fable-5-1"
    u = m.final_usage(10)
    assert u["inputTokens"] == 14034 + 132 and u["cacheReadTokens"] == 14032  # summed over both messages


def test_codex_stream_mapping():
    m = CodexStream(None, None)
    evs = feed(m, "codex-stream.jsonl")
    # The thread id is announced as it starts (the host follows the log from the first record), then the turn.
    assert [e["t"] for e in evs] == ["session", "text", "tool_use", "tool_result", "text", "usage"]
    assert evs[0]["session"] == "01a0e399-4195-7881-a4a7-b23674d0aa40"
    evs = evs[1:]
    assert evs[1]["name"] == "shell" and "echo hi" in evs[1]["input"]["command"]
    assert evs[2]["text"] == "hi\n" and evs[2]["isError"] is False
    assert m.session == "01a0e399-4195-7881-a4a7-b23674d0aa40" and m.text == "done" and m.done
    u = evs[-1]["usage"]
    assert u == {"model": None, "inputTokens": 36774 - 24320, "outputTokens": 46, "cacheReadTokens": 24320, "cacheWriteTokens": 0, "durationMs": None, "costUsd": None}
    # Config warnings ("error" items) are not turn failures.
    assert m.error is None


def test_codex_turn_failure_is_an_error():
    m = CodexStream(None, None)
    m.feed({"type": "turn.failed", "error": {"message": "quota"}}, 1)
    assert m.error == "codex: quota" and m.done


def test_claude_args_new_then_resume(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    sid = "11111111-2222-3333-4444-555555555555"
    req = RunRequest(schema=None, system=None, prompt="p", options=ExecOptions(backend="claude", model="sonnet", effort="high", session=sid, new_session=True))
    args = ClaudeCodeBackend().args(req)
    assert args[:7] == ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
    assert ["--session-id", sid] == args[11:13] and "--resume" not in args
    assert "--effort" in args and "Bash(agora canvas *)" in args
    log = tmp_path / ".claude" / "projects" / "-work-project" / f"{sid}.jsonl"
    log.parent.mkdir(parents=True)
    log.write_text("{}\n")
    assert ["--resume", sid] == ClaudeCodeBackend().args(req)[11:13]
    # A session that already ran is always resumed, even when its log is gone: the CLI then fails
    # ("No conversation found") instead of silently starting a new conversation under the same id.
    log.unlink()
    old = RunRequest(schema=None, system=None, prompt="p", options=ExecOptions(backend="claude", model="sonnet", session=sid))
    assert ["--resume", sid] == ClaudeCodeBackend().args(old)[11:13]


def test_pi_and_codex_args():
    pi = PiBackend().args(RunRequest(schema=None, system=None, prompt="改一下", options=ExecOptions(backend="pi", model="magpie/group/opus-5-5", effort="low", session="abc")))
    assert pi[:4] == ["pi", "-p", "--mode", "json"]
    assert pi[pi.index("--session-id") + 1] == "abc" and pi[pi.index("--thinking") + 1] == "low"
    assert pi[pi.index("--skill") + 1] == str(agents.SKILL_DIR) and pi[-2:] == ["--", "改一下"]
    new = CodexBackend().args(RunRequest(schema=None, system=None, prompt="p", options=ExecOptions(backend="codex", model="gpt-6-sol", effort="low", session=None)))
    assert new == ["codex", "exec", "--json", "--skip-git-repo-check", "-m", "gpt-6-sol", "-c", 'model_reasoning_effort="low"', "-"]
    resumed = CodexBackend().args(RunRequest(schema=None, system=None, prompt="p", options=ExecOptions(backend="codex", model="", session="t-1")))
    assert resumed[:4] == ["codex", "exec", "resume", "t-1"] and resumed[-1] == "-"


@pytest.mark.parametrize(
    ("cls", "fixture", "final", "session"),
    [
        (ClaudeCodeBackend, "claude-stream.jsonl", "done", "c5f2efdb-1102-498e-9d76-70ea178d26f2"),
        (PiBackend, "pi-stream.jsonl", "done", "3848dfff-ed77-4b25-b572-39918ef0b06a"),
        (CodexBackend, "codex-stream.jsonl", "done", "01a0e399-4195-7881-a4a7-b23674d0aa40"),
    ],
)
async def test_run_in_project_dir_with_agora_env(tmp_path, monkeypatch, cls, fixture, final, session):
    monkeypatch.setenv("CLAUDECODE", "1")  # the server may itself run inside an agent
    monkeypatch.setenv("CLAUDE_CODE_CHILD_SESSION", "1")
    probe = tmp_path / "probe.json"
    project = tmp_path / "proj"
    project.mkdir()
    backend = cls([sys.executable, str(FAKE), str(legacy(fixture))], env={"FAKE_AGENT_PROBE": str(probe)})
    req = RunRequest(schema=None, system=None, prompt="把 Redis 改成集群", options=ExecOptions(backend=cls.name, model="m", session="s-native"), cwd=str(project), env={"AGORA_SESSION": "s-1", "AGORA_PROJECT": str(project)})
    evs = [e async for e in backend.run(req)]
    assert evs[0]["t"] == "start" and evs[-1]["t"] == "result"
    res = evs[-1]
    assert "error" not in res, res.get("error")
    assert res["raw"] == final and res["session"] == session and res["backend"] == cls.name
    assert res["usage"]["durationMs"] >= 0
    p = json.loads(probe.read_text())
    assert Path(p["cwd"]).resolve() == project.resolve()  # the project's own agent, not a neutral dir
    assert p["env"]["AGORA_SESSION"] == "s-1"
    assert p["env"]["PATH"].split(":")[0] == str(agents.AGENT_BIN)
    assert "CLAUDECODE" not in p["env"] and "CLAUDE_CODE_CHILD_SESSION" not in p["env"]
    if cls is PiBackend:
        assert p["argv"][-1] == "把 Redis 改成集群" and p["stdin"] == ""
    elif cls is ClaudeCodeBackend:
        assert json.loads(p["stdin"]) == {"type": "user", "message": {"role": "user", "content": "把 Redis 改成集群"}}
    else:
        assert p["stdin"] == "把 Redis 改成集群"


async def test_nonzero_exit_and_missing_binary_are_explicit(tmp_path):
    b = CodexBackend([sys.executable, str(FAKE), str(legacy("codex-stream.jsonl"))], env={"FAKE_AGENT_EXIT": "3"})
    req = RunRequest(schema=None, system=None, prompt="p", options=ExecOptions(backend="codex", model=""), cwd=str(tmp_path))
    res = [e async for e in b.run(req)][-1]
    assert res["error"].startswith("exit 3")
    gone = PiBackend(["/definitely/not/pi"])
    res = [e async for e in gone.run(req)][-1]
    assert res["error"].startswith("spawn:")


def test_registry_and_interactive_commands(tmp_path, monkeypatch):
    for name in ("pi", "claude", "codex", "claude-cli"):
        assert make_backend(name).name == name
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert interactive_argv("claude", "u-1", "sonnet", "high", new=True) == ["claude", "--session-id", "u-1", "--model", "sonnet", "--effort", "high"]
    assert interactive_argv("claude", "u-1", "sonnet", "") == ["claude", "--resume", "u-1", "--model", "sonnet"]  # started: never --session-id
    pi = interactive_argv("pi", "u-2", "magpie/group/opus-5-5", "medium")
    assert pi[:3] == ["pi", "--session-id", "u-2"] and pi[pi.index("--models") + 1] == "magpie/group/opus-5-5"
    assert interactive_argv("codex", "t-9", "gpt-6-sol", "") == ["codex", "resume", "t-9", "-m", "gpt-6-sol"]
    assert interactive_argv("codex", None, "", "") == ["codex"]


def test_install_skill_links_into_project_only(tmp_path):
    _git("init", "-q", cwd=tmp_path)
    done = agents.install_skill(tmp_path, ["claude", "pi", "codex"])
    assert (tmp_path / ".claude" / "skills" / "agora").resolve() == agents.SKILL_DIR.resolve()
    assert (tmp_path / ".agents" / "skills" / "agora" / "SKILL.md").exists()
    assert any(d["for"] == "pi" and "--skill" in d["state"] for d in done)
    exclude = (tmp_path / ".git" / "info" / "exclude").read_text()
    assert "/.claude/skills/agora" in exclude and "/.agents/skills/agora" in exclude
    again = agents.install_skill(tmp_path, ["claude", "codex"])
    assert {d["state"] for d in again} == {"exists"}
    assert (tmp_path / ".git" / "info" / "exclude").read_text() == exclude  # idempotent


def test_install_skill_drops_the_old_agora_canvas_link(tmp_path):
    _git("init", "-q", cwd=tmp_path)
    old = tmp_path / ".claude" / "skills" / "agora-canvas"
    old.parent.mkdir(parents=True)
    old.symlink_to(agents.REPO / "skills" / "agora-canvas")  # dangling: the skill was renamed
    (tmp_path / ".git" / "info" / "exclude").write_text("/.claude/skills/agora-canvas\n")
    mine = tmp_path / ".agents" / "skills" / "agora-canvas"  # a folder the person made is not ours
    mine.mkdir(parents=True)
    agents.install_skill(tmp_path, ["claude", "codex"])
    assert not old.is_symlink() and (tmp_path / ".claude" / "skills" / "agora").is_symlink()
    assert mine.is_dir()
    exclude = (tmp_path / ".git" / "info" / "exclude").read_text().splitlines()
    assert "/.claude/skills/agora-canvas" not in exclude and "/.claude/skills/agora" in exclude


def _git(*a, cwd):
    import subprocess

    subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, env={**__import__("os").environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def test_install_skill_in_a_git_worktree_writes_the_shared_exclude(tmp_path):
    main = tmp_path / "main"
    main.mkdir()
    _git("init", "-q", cwd=main)
    _git("commit", "-q", "--allow-empty", "-m", "x", cwd=main)
    wt = tmp_path / "wt"
    _git("worktree", "add", "-q", str(wt), "-b", "b", cwd=main)
    assert (wt / ".git").is_file()  # a worktree's .git is a file, not a directory
    agents.install_skill(wt, ["claude"])
    exclude = (main / ".git" / "info" / "exclude").read_text().splitlines()
    assert "/.claude/skills/agora" in exclude
    status = __import__("subprocess").run(["git", "status", "--short"], cwd=wt, capture_output=True, text=True).stdout
    assert ".claude" not in status


def test_install_skill_without_git_skips_the_ignore_list(tmp_path):
    done = agents.install_skill(tmp_path, ["claude"])
    assert (tmp_path / ".claude" / "skills" / "agora").is_symlink() and done


def test_install_skill_drops_old_links_into_another_checkout_or_nowhere(tmp_path):
    other = tmp_path / "other-checkout" / "skills" / "agora-canvas"
    other.mkdir(parents=True)  # exists: another Agora checkout's own copy
    (tmp_path / "p" / ".claude" / "skills").mkdir(parents=True)
    (tmp_path / "p" / ".agents" / "skills").mkdir(parents=True)
    a = tmp_path / "p" / ".claude" / "skills" / "agora-canvas"
    a.symlink_to(other)
    b = tmp_path / "p" / ".agents" / "skills" / "agora-canvas"
    b.symlink_to(tmp_path / "gone")  # target no longer exists
    agents.install_skill(tmp_path / "p", ["claude", "codex"])
    assert not a.is_symlink() and not b.is_symlink()
    assert other.is_dir()  # only the link goes
    stray = tmp_path / "q" / ".claude" / "skills" / "agora-canvas"
    stray.parent.mkdir(parents=True)
    stray.symlink_to(tmp_path)  # a link to something that is not an Agora skill stays
    agents.install_skill(tmp_path / "q", ["claude"])
    assert stray.is_symlink()


async def test_stopping_a_running_turn_kills_its_process_group(tmp_path, monkeypatch):
    monkeypatch.setattr(agents, "KILL_GRACE_S", 0.5)
    child_pid = tmp_path / "child.pid"
    script = tmp_path / "hang.py"
    script.write_text(
        "import subprocess, sys, time\n"
        f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])\n"
        f"open({str(child_pid)!r}, 'w').write(str(p.pid))\n"
        "print('{\"type\": \"thread.started\", \"thread_id\": \"t\"}', flush=True)\n"
        "time.sleep(600)\n"
    )
    b = CodexBackend([sys.executable, str(script)], timeout_s=1.5)
    req = RunRequest(schema=None, system=None, prompt="p", options=ExecOptions(backend="codex", model=""), cwd=str(tmp_path))
    res = [e async for e in b.run(req)][-1]
    assert res["error"].startswith("timeout")
    import os
    import time

    pid = int(child_pid.read_text())
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.1)
    pytest.fail("the turn's child process survived")


def test_codex_terminal_first_rollout_discovery(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    day = tmp_path / "codex" / "sessions" / "2026" / "09" / "28"
    day.mkdir(parents=True)
    project, other = tmp_path / "proj", tmp_path / "other"
    project.mkdir(), other.mkdir()

    def rollout(tid: str, cwd: Path) -> Path:
        p = day / f"rollout-2026-09-28T00-00-00-{tid}.jsonl"
        p.write_text(json.dumps({"type": "session_meta", "payload": {"id": tid, "cwd": str(cwd)}}) + "\n")
        return p

    import os
    import time

    old = rollout("t-old", project)
    os.utime(old, (time.time() - 3600, time.time() - 3600))  # before the terminal opened
    since = time.time()
    rollout("t-elsewhere", other)
    mine = rollout("t-mine", project)
    assert agents.codex_rollouts_since(project, since) == [("t-mine", mine)]
    assert agents.codex_log("t-mine") == mine
