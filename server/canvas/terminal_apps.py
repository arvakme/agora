"""Which terminal「在终端打开」uses, and the command line that opens a window in it.

One small adapter per terminal (``argv``: the window's command line) in the ``APPS`` table, in the
order they are tried by themselves: Ghostty, Kitty, macOS Terminal, then the Linux desktop terminals GNOME Terminal,
Konsole, WezTerm, Alacritty and xterm (found only with a display, ``DISPLAY`` or ``WAYLAND_DISPLAY``).
``AGORA_TERMINAL=ghostty|kitty|terminal|gnome-terminal|konsole|wezterm|alacritty|xterm`` picks one; ``auto`` (or nothing, or a name this table does not have) tries them in that order. A named
terminal that is not installed falls back to the automatic order, so the button still opens something.
Nothing here reads a terminal's own configuration.

The launch waits for the command to exit (``Terminals.launch``), so every command returns at once: the macOS ones
through ``open`` / ``--detach`` / AppleScript, the Linux ones that keep running with their window are started in the
background (``_detached``). The window runs ``attach`` (the shell command of ``Terminals.attach_command``). Closing the window
only detaches that tmux client; the pane and the CLI in it keep running.
"""

from __future__ import annotations

import os
import shlex
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
    display: Callable[[], bool] = lambda: bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


@dataclass(frozen=True)
class TerminalApp:
    key: str
    name: str
    find: Callable[[Probe], str | None]  # what to launch (an app bundle or a program), None when it is not installed
    argv: Callable[[str, str, str, str], list[str]]  # (found, title, cwd, attach) → the command that opens the window


# ——— Ghostty: `open -na` starts a separate instance (the app's own binary cannot be started from a shell on macOS,
# and a Ghostty the person already has open stays untouched); `-e` runs the command as given, no shell expansion,
# and makes the instance quit with its last window. Closing the window is confirmed by nobody: it only detaches. ———
# On Linux it is the `ghostty` program, started in the background. ———
def _ghostty_find(p: Probe) -> str | None:
    app = next((d for d in ("/Applications/Ghostty.app", str(p.home / "Applications" / "Ghostty.app")) if p.is_dir(d)), None)
    return app or _on_desktop(p, "ghostty")


def _ghostty_argv(found: str, title: str, cwd: str, attach: str) -> list[str]:
    args = [f"--title={title}", f"--working-directory={cwd}", "--confirm-close-surface=false", "-e", "sh", "-c", attach]
    return ["open", "-na", found, "--args", *args] if found.endswith(".app") else _detached([found, *args])


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


# ——— Linux desktops. ———
def _on_desktop(p: Probe, program: str) -> str | None:
    """A terminal program on PATH, when there is a display to open its window on."""
    return p.which(program) if p.display() else None


def _detached(argv: list[str]) -> list[str]:
    """Start a program that keeps running with its window in the background: the command itself returns at once."""
    return ["sh", "-c", '"$@" </dev/null >/dev/null 2>&1 &', "sh", *argv]


def _in_dir(cwd: str, attach: str) -> str:
    return f"cd {shlex.quote(cwd)} && {attach}"


# gnome-terminal hands the window to its server and returns; it has no title option any more.
def _gnome_argv(prog: str, title: str, cwd: str, attach: str) -> list[str]:
    return [prog, f"--working-directory={cwd}", "--", "sh", "-c", attach]


def _konsole_argv(prog: str, title: str, cwd: str, attach: str) -> list[str]:
    return _detached([prog, "--workdir", cwd, "-p", f"tabtitle={title}", "-e", "sh", "-c", attach])


def _wezterm_argv(prog: str, title: str, cwd: str, attach: str) -> list[str]:
    return _detached([prog, "start", "--always-new-process", "--cwd", cwd, "--", "sh", "-c", attach])


def _alacritty_argv(prog: str, title: str, cwd: str, attach: str) -> list[str]:
    return _detached([prog, "--title", title, "--working-directory", cwd, "-e", "sh", "-c", attach])


def _xterm_argv(prog: str, title: str, cwd: str, attach: str) -> list[str]:
    return _detached([prog, "-T", title, "-e", "sh", "-c", _in_dir(cwd, attach)])


def _desktop(key: str, name: str, argv: Callable[[str, str, str, str], list[str]], program: str | None = None) -> TerminalApp:
    return TerminalApp(key, name, lambda p: _on_desktop(p, program or key), argv)


APPS: dict[str, TerminalApp] = {
    a.key: a
    for a in (
        TerminalApp("ghostty", "Ghostty", _ghostty_find, _ghostty_argv),
        TerminalApp("kitty", "Kitty", _kitty_find, _kitty_argv),
        TerminalApp("terminal", "Terminal", _terminal_find, _terminal_argv),
        _desktop("gnome-terminal", "GNOME Terminal", _gnome_argv),
        _desktop("konsole", "Konsole", _konsole_argv),
        _desktop("wezterm", "WezTerm", _wezterm_argv),
        _desktop("alacritty", "Alacritty", _alacritty_argv),
        _desktop("xterm", "xterm", _xterm_argv),
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
