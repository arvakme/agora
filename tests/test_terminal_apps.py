"""「在终端打开」picks a terminal (server/canvas/terminal_apps.py) and opens a window in it.

Nothing here opens a window: the machine is a ``Probe`` of fake paths under a temporary HOME, and the launch
goes through a recording stand-in for ``subprocess.run``."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from server.canvas import terminal
from server.canvas.terminal import Terminals
from server.canvas.terminal_apps import APPS, ENV_VAR, Probe, candidates, chosen

GHOSTTY = "/Applications/Ghostty.app"
KITTY_APP = "/Applications/kitty.app"


def machine(tmp_path: Path, *, dirs: tuple[str, ...] = (), commands: dict[str, str] | None = None) -> Probe:
    return Probe(which=lambda c: (commands or {}).get(c), is_dir=lambda p: p in dirs, home=tmp_path)


def keys(env: dict[str, str], probe: Probe) -> list[str]:
    return [a.key for a, _ in candidates(env, probe)]


ALL = {"kitty": "/opt/homebrew/bin/kitty", "osascript": "/usr/bin/osascript"}


# ——— detection order ———
def test_ghostty_comes_before_kitty_before_terminal(tmp_path):
    p = machine(tmp_path, dirs=(GHOSTTY,), commands=ALL)
    assert keys({}, p) == ["ghostty", "kitty", "terminal"]
    assert chosen({}, p).name == "Ghostty"


def test_each_terminal_is_found_only_where_it_is_installed(tmp_path):
    assert keys({}, machine(tmp_path, commands=ALL)) == ["kitty", "terminal"]
    assert keys({}, machine(tmp_path, dirs=(KITTY_APP,), commands={"osascript": "/usr/bin/osascript"})) == ["kitty", "terminal"]
    assert keys({}, machine(tmp_path, commands={"osascript": "/usr/bin/osascript"})) == ["terminal"]
    assert keys({}, machine(tmp_path)) == [] and chosen({}, machine(tmp_path)) is None


def test_ghostty_in_the_users_own_applications_folder_counts(tmp_path):
    p = machine(tmp_path, dirs=(str(tmp_path / "Applications" / "Ghostty.app"),))
    assert candidates({}, p) == [(APPS["ghostty"], str(tmp_path / "Applications" / "Ghostty.app"))]


# ——— the explicit choice ———
@pytest.mark.parametrize("value, first", [("kitty", "kitty"), ("KITTY", "kitty"), (" terminal ", "terminal"), ("ghostty", "ghostty")])
def test_a_named_terminal_goes_first_and_the_rest_keep_their_order(tmp_path, value, first):
    p = machine(tmp_path, dirs=(GHOSTTY,), commands=ALL)
    got = keys({ENV_VAR: value}, p)
    assert got[0] == first and sorted(got) == ["ghostty", "kitty", "terminal"]
    assert got[1:] == [k for k in ("ghostty", "kitty", "terminal") if k != first]


@pytest.mark.parametrize("value", ["", "auto", "AUTO", "warp", "  "])
def test_auto_and_names_the_table_does_not_have_mean_the_automatic_order(tmp_path, value):
    assert keys({ENV_VAR: value}, machine(tmp_path, dirs=(GHOSTTY,), commands=ALL)) == ["ghostty", "kitty", "terminal"]


def test_a_named_terminal_that_is_not_installed_falls_back_to_the_automatic_order(tmp_path):
    assert keys({ENV_VAR: "ghostty"}, machine(tmp_path, commands=ALL)) == ["kitty", "terminal"]


# ——— the window's command line ———
ODD_CWD = '/Users/me/项目 (副本)/it\'s "quoted" & $HOME'
ODD_ATTACH = "'/opt/my tmux/tmux' -L agora-abc attach -t agora-s_1"


def test_ghostty_opens_its_own_instance_and_runs_the_attach_command_as_given():
    argv = APPS["ghostty"].argv(GHOSTTY, "Agora · Claude 中文", ODD_CWD, ODD_ATTACH)
    assert argv[:4] == ["open", "-na", GHOSTTY, "--args"]
    # every option is one argument, whatever is in it: no shell sees this line
    assert "--title=Agora · Claude 中文" in argv and f"--working-directory={ODD_CWD}" in argv
    assert "--confirm-close-surface=false" in argv
    # `-e` takes everything after it, so it is last: the command, unexpanded
    assert argv[-4:] == ["-e", "sh", "-c", ODD_ATTACH]


def test_kitty_gets_its_own_process_that_quits_with_its_window():
    argv = APPS["kitty"].argv("/opt/homebrew/bin/kitty", "Agora · Pi", ODD_CWD, ODD_ATTACH)
    assert argv == ["/opt/homebrew/bin/kitty", "--detach", "-o", "macos_quit_when_last_window_closed=yes", "--title", "Agora · Pi", "--directory", ODD_CWD, "sh", "-c", ODD_ATTACH]


def test_terminal_escapes_the_command_for_applescript():
    argv = APPS["terminal"].argv("/usr/bin/osascript", "t", ODD_CWD, 'echo "a\\b" 中文')
    assert argv[:2] == ["/usr/bin/osascript", "-e"]
    assert argv[2].splitlines()[0] == 'tell application "Terminal" to do script "echo \\"a\\\\b\\" 中文"'
    assert argv[2].splitlines()[1] == 'tell application "Terminal" to activate'


# ——— launching ———
class Runs:
    """Stands in for subprocess.run: records each command line, fails the ones whose program is in ``fail``."""

    def __init__(self, fail: tuple[str, ...] = (), raises: dict[str, Exception] | None = None) -> None:
        self.calls: list[tuple[list[str], dict]] = []
        self.fail, self.raises = fail, raises or {}

    def __call__(self, argv, **kw):
        self.calls.append((argv, kw))
        if argv[0] in self.raises:
            raise self.raises[argv[0]]
        return subprocess.CompletedProcess(argv, 1 if argv[0] in self.fail else 0, b"", b"")


@pytest.fixture
def terms(tmp_path):
    root = tmp_path / "项目 root"
    root.mkdir()
    return Terminals(root, root / ".agora" / "run", tmux="/opt/my tmux/tmux", socket="agora-test")


def test_launch_opens_ghostty_first_with_the_attach_command_and_the_project_directory(terms, tmp_path, monkeypatch):
    runs = Runs()
    monkeypatch.setattr(terminal.subprocess, "run", runs)
    assert terms.launch("s-1", "Agora · Claude", env={}, probe=machine(tmp_path, dirs=(GHOSTTY,), commands=ALL)) == "ghostty"
    (argv, _), = runs.calls
    assert argv[0] == "open" and GHOSTTY in argv  # the window's own command line is test_ghostty_opens_its_own_instance…
    assert f"--working-directory={terms.root}" in argv
    assert "'/opt/my tmux/tmux' -L agora-test attach -t agora-s-1" == argv[-1] == terms.attach_command("s-1")


def test_launch_hands_the_terminal_no_seedmux_or_tmux_variables(terms, tmp_path, monkeypatch):
    monkeypatch.setenv("SEEDMUX_PANE_ID", "abc")
    monkeypatch.setenv("TMUX", "/tmp/x,1,0")
    runs = Runs()
    monkeypatch.setattr(terminal.subprocess, "run", runs)
    terms.launch("s-1", "t", env={}, probe=machine(tmp_path, dirs=(GHOSTTY,)))
    env = runs.calls[0][1]["env"]
    assert not [k for k in env if k.startswith("SEEDMUX_")] and "TMUX" not in env


def test_launch_uses_the_named_terminal(terms, tmp_path, monkeypatch):
    runs = Runs()
    monkeypatch.setattr(terminal.subprocess, "run", runs)
    assert terms.launch("s-1", "t", env={ENV_VAR: "kitty"}, probe=machine(tmp_path, dirs=(GHOSTTY,), commands=ALL)) == "kitty"
    assert [c[0][0] for c in runs.calls] == ["/opt/homebrew/bin/kitty"]


def test_launch_tries_the_next_terminal_when_one_does_not_open(terms, tmp_path, monkeypatch):
    runs = Runs(fail=("open",), raises={"/opt/homebrew/bin/kitty": OSError("gone")})
    monkeypatch.setattr(terminal.subprocess, "run", runs)
    assert terms.launch("s-1", "t", env={}, probe=machine(tmp_path, dirs=(GHOSTTY,), commands=ALL)) == "terminal"
    assert [c[0][0] for c in runs.calls] == ["open", "/opt/homebrew/bin/kitty", "/usr/bin/osascript"]


def test_launch_says_none_when_nothing_opens_or_nothing_is_installed(terms, tmp_path, monkeypatch):
    runs = Runs(fail=("open", "/usr/bin/osascript"), raises={"/opt/homebrew/bin/kitty": subprocess.TimeoutExpired("kitty", 10)})
    monkeypatch.setattr(terminal.subprocess, "run", runs)
    assert terms.launch("s-1", "t", env={}, probe=machine(tmp_path, dirs=(GHOSTTY,), commands=ALL)) is None
    assert len(runs.calls) == 3
    runs.calls.clear()
    assert terms.launch("s-1", "t", env={}, probe=machine(tmp_path)) is None and runs.calls == []
