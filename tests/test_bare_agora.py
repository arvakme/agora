"""A bare `agora` (no command) is `agora open`, as a bare `claude` or `codex` starts a session."""

from agora_cli import main as cli


def test_bare_agora_opens_this_project(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(cli, "cmd_open", lambda p, a: seen.append(a) or 0)
    monkeypatch.chdir(tmp_path)
    assert cli.main([]) == 0
    assert len(seen) == 1 and seen[0].cmd == "open" and not seen[0].dev and not seen[0].no_browser


def test_a_command_is_still_taken_as_given(monkeypatch, tmp_path):
    seen = []
    monkeypatch.setattr(cli, "cmd_status", lambda p, a: seen.append(a.cmd) or 0)
    monkeypatch.chdir(tmp_path)
    assert cli.main(["status"]) == 0
    assert seen == ["status"]
