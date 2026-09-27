"""Terminal panes for sessions: Agora's own tmux server, one tmux session per Agora session.

Isolation: every project gets its own tmux server (``tmux -L agora-<hash>``, config
``.agora/run/tmux.conf`` instead of the user's ``~/.tmux.conf``), so nothing here can
see or touch the user's own tmux sessions. The pane runs the agent CLI directly (no
shell): the tmux session exists exactly as long as the CLI holds the native session.

Input into a pane is a bracketed paste (``paste-buffer -p``) followed by Enter, the same
way a person pasting and pressing Enter would; ``client_activity`` (last keypress of any
attached client) lets the caller hold a delivery while someone is typing.
"""

from __future__ import annotations

import hashlib
import os
import shlex
import shutil
import subprocess
import time
from pathlib import Path

from server.canvas.agents import _NESTED, child_env

CONF = """\
# Agora's tmux server for this project (not the user's ~/.tmux.conf).
set -g mouse on
set -g history-limit 50000
set -sg escape-time 10
set -g default-terminal "tmux-256color"
set -g status-style "bg=#efece6,fg=#3b3a36"
set -g status-left "[Agora] "
set -g status-left-length 20
set -g status-right "#{session_name}  detach: C-b d "
"""
PASTE_END = b"\x1b[201~"


class TerminalError(RuntimeError):
    pass


class Terminals:
    def __init__(self, root: Path, run_dir: Path, tmux: str | None = None) -> None:
        self.root = root
        self.run_dir = run_dir
        self.tmux = tmux or shutil.which("tmux") or "tmux"
        self.socket = f"agora-{hashlib.sha1(str(root).encode()).hexdigest()[:10]}"
        self.conf = run_dir / "tmux.conf"

    # ——— plumbing ———
    def _run(self, *args: str, input: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess:
        if not self.conf.exists():
            self.run_dir.mkdir(parents=True, exist_ok=True)
            self.conf.write_text(CONF)
        return subprocess.run(
            [self.tmux, "-L", self.socket, "-f", str(self.conf), *args],
            input=input,
            capture_output=True,
            timeout=10,
            check=check,
            env=child_env(),
        )

    @staticmethod
    def name(session_id: str) -> str:
        return "agora-" + "".join(c if c.isalnum() or c in "-_" else "_" for c in session_id)

    def pane(self, session_id: str) -> str:
        """Exact-match target for the session's (only) pane: ``=name:`` (``=name`` alone resolves no pane)."""
        return f"={self.name(session_id)}:"

    def attach_command(self, session_id: str) -> str:
        return f"{shlex.quote(self.tmux)} -L {self.socket} attach -t {self.name(session_id)}"

    # ——— state ———
    def alive(self, session_id: str) -> bool:
        r = self._run("display-message", "-p", "-t", self.pane(session_id), "#{pane_dead}", check=False)
        return r.returncode == 0 and r.stdout.strip() == b"0"

    def sessions(self) -> list[str]:
        r = self._run("list-sessions", "-F", "#{session_name}", check=False)
        return r.stdout.decode().split() if r.returncode == 0 else []

    def clients(self, session_id: str) -> int:
        r = self._run("list-clients", "-t", f"={self.name(session_id)}", "-F", "#{client_activity}", check=False)
        return len(r.stdout.split()) if r.returncode == 0 else 0

    def last_input(self, session_id: str) -> float | None:
        """Epoch seconds of the latest keypress from any client attached to this pane."""
        r = self._run("list-clients", "-t", f"={self.name(session_id)}", "-F", "#{client_activity}", check=False)
        vals = [float(x) for x in r.stdout.decode().split() if x.strip().isdigit()] if r.returncode == 0 else []
        return max(vals) if vals else None

    def capture(self, session_id: str, lines: int = 200) -> str:
        r = self._run("capture-pane", "-p", "-J", "-S", f"-{lines}", "-t", self.pane(session_id), check=False)
        return r.stdout.decode("utf-8", "replace")

    # ——— actions ———
    def open(self, session_id: str, argv: list[str], *, cwd: Path, env: dict[str, str]) -> bool:
        """Start the pane unless it already runs. Returns True when it was created."""
        if self.alive(session_id):
            return False
        name = self.name(session_id)
        self._run("kill-session", "-t", f"={name}", check=False)  # a dead leftover
        # `env -u …` drops nesting markers inherited from whoever started the tmux server.
        wrapped = ["env", *[a for k in _NESTED for a in ("-u", k)], *[f"{k}={v}" for k, v in env.items()], *argv]
        r = self._run("new-session", "-d", "-s", name, "-x", "220", "-y", "56", "-c", str(cwd), "--", *wrapped, check=False)
        if r.returncode != 0:
            raise TerminalError(r.stderr.decode(errors="replace").strip() or "tmux new-session failed")
        return True

    def paste(self, session_id: str, text: str, *, settle_s: float = 0.4) -> None:
        """Bracketed paste of ``text`` into the pane, then Enter."""
        data = text.encode()
        if PASTE_END in data:
            raise TerminalError("text contains a bracketed-paste terminator")
        buf = f"agora-{session_id}"
        self._run("load-buffer", "-b", buf, "-", input=data)
        self._run("paste-buffer", "-p", "-d", "-b", buf, "-t", self.pane(session_id))
        time.sleep(settle_s)
        self._run("send-keys", "-t", self.pane(session_id), "Enter")

    def socket_path(self) -> Path:
        """Where tmux puts this server's socket ($TMUX_TMPDIR or /tmp, then tmux-<uid>/<name>)."""
        base = os.environ.get("TMUX_TMPDIR") or "/tmp"
        return Path(os.path.realpath(base)) / f"tmux-{os.getuid()}" / self.socket

    def _drop_dead_socket(self) -> None:
        # tmux can leave the socket file behind when its last session ends or it is killed.
        if self.socket_path().exists() and self._run("list-sessions", check=False).returncode != 0:
            self.socket_path().unlink(missing_ok=True)

    def kill(self, session_id: str) -> None:
        self._run("kill-session", "-t", f"={self.name(session_id)}", check=False)
        self._drop_dead_socket()

    def kill_server(self) -> None:
        """Stop this project's tmux server and remove its socket file."""
        self._run("kill-server", check=False)
        self._drop_dead_socket()

    def launch(self, session_id: str, title: str) -> str | None:
        """Open a terminal window attached to the pane: Kitty, else macOS Terminal. Returns which."""
        attach = self.attach_command(session_id)
        kitty = shutil.which("kitty") or ("/Applications/kitty.app/Contents/MacOS/kitty" if Path("/Applications/kitty.app").exists() else None)
        if kitty:
            try:
                subprocess.Popen(
                    # Its own kitty process (not the user's instance); on macOS an app outlives its last
                    # window by default, so tell this one to quit when the attach window closes.
                    [kitty, "--detach", "-o", "macos_quit_when_last_window_closed=yes", "--title", title, "--directory", str(self.root), "sh", "-c", attach],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                    env=child_env(),
                )
                return "kitty"
            except OSError:
                pass
        if shutil.which("osascript"):
            script = f'tell application "Terminal" to do script {_applescript_str(attach)}\ntell application "Terminal" to activate'
            r = subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)
            if r.returncode == 0:
                return "terminal"
        return None


def _applescript_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
