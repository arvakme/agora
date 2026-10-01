"""Which terminal「在终端打开」uses, and the command line that opens a window in it.

One small adapter per terminal (``argv``: the window's command line) in the ``APPS`` table, in the
order they are tried by themselves: Ghostty, Kitty, macOS Terminal. ``AGORA_TERMINAL=ghostty|kitty|terminal``
picks one; ``auto`` (or nothing, or a name this table does not have) tries them in that order. A named
terminal that is not installed falls back to the automatic order, so the button still opens something.
Nothing here reads a terminal's own configuration.

The window runs ``attach`` (the shell command of ``Terminals.attach_command``). Closing the window
only detaches that tmux client; the pane and the CLI in it keep running.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

ENV_VAR = "AGORA_TERMINAL"


@dataclass(frozen=True)
class Probe:
    """What the machine offers: ``which`` (a command on PATH) and ``is_dir`` (an app bundle), swappable in tests."""

    which: Callable[[str], str | None] = shutil.which
    is_dir: Callable[[str], bool] = lambda p: Path(p).is_dir()
    home: Path = Path.home()


@dataclass(frozen=True)
class TerminalApp:
    key: str
    name: str
    find: Callable[[Probe], str | None]  # what to launch (an app bundle or a program), None when it is not installed
    argv: Callable[[str, str, str, str], list[str]]  # (found, title, cwd, attach) → the command that opens the window


# ——— Ghostty: `open -na` starts a separate instance (the app's own binary cannot be started from a shell on macOS,
# and a Ghostty the person already has open stays untouched); `-e` runs the command as given, no shell expansion,
# and makes the instance quit with its last window. Closing the window is confirmed by nobody: it only detaches. ———
def _ghostty_find(p: Probe) -> str | None:
    return next((d for d in ("/Applications/Ghostty.app", str(p.home / "Applications" / "Ghostty.app")) if p.is_dir(d)), None)


def _ghostty_argv(app: str, title: str, cwd: str, attach: str) -> list[str]:
    return ["open", "-na", app, "--args", f"--title={title}", f"--working-directory={cwd}", "--confirm-close-surface=false", "-e", "sh", "-c", attach]


# ——— Kitty: its own kitty process (not the person's instance); on macOS an app outlives its last window by default,
# so this one quits when the attach window closes. ———
def _kitty_find(p: Probe) -> str | None:
    return p.which("kitty") or ("/Applications/kitty.app/Contents/MacOS/kitty" if p.is_dir("/Applications/kitty.app") else None)


def _kitty_argv(kitty: str, title: str, cwd: str, attach: str) -> list[str]:
    return [kitty, "--detach", "-o", "macos_quit_when_last_window_closed=yes", "--title", title, "--directory", cwd, "sh", "-c", attach]


# ——— macOS Terminal: AppleScript; no way to set the directory or title from here, the command itself is all it needs. ———
def _terminal_find(p: Probe) -> str | None:
    return p.which("osascript")


def _applescript_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _terminal_argv(osascript: str, title: str, cwd: str, attach: str) -> list[str]:
    script = f'tell application "Terminal" to do script {_applescript_str(attach)}\ntell application "Terminal" to activate'
    return [osascript, "-e", script]


APPS: dict[str, TerminalApp] = {
    a.key: a
    for a in (
        TerminalApp("ghostty", "Ghostty", _ghostty_find, _ghostty_argv),
        TerminalApp("kitty", "Kitty", _kitty_find, _kitty_argv),
        TerminalApp("terminal", "Terminal", _terminal_find, _terminal_argv),
    )
}


def candidates(env: Mapping[str, str] | None = None, probe: Probe | None = None) -> list[tuple[TerminalApp, str]]:
    """The installed terminals in the order to try them: the named one first (when installed), then the rest in table order."""
    env = os.environ if env is None else env
    probe = probe or Probe()
    found = [(a, f) for a in APPS.values() if (f := a.find(probe))]
    wanted = (env.get(ENV_VAR) or "").strip().lower()
    return sorted(found, key=lambda af: af[0].key != wanted)  # stable: False (the named one) sorts first


def chosen(env: Mapping[str, str] | None = None, probe: Probe | None = None) -> TerminalApp | None:
    """The terminal a launch tries first, None when none is installed."""
    c = candidates(env, probe)
    return c[0][0] if c else None
