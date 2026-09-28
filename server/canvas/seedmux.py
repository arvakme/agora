"""Seedmux (macOS terminal app, tmux underneath) as a place to open a session's terminal.

Only Seedmux's own documented control plane is used to create a pane: the team bridge
(``~/Library/Application Support/Seedmux/team-bridge.json`` → ``http://127.0.0.1:<port>``,
header ``X-Token``) and its ``POST /spawn {cwd, launch, focus, near?, direction?}``, the same
call its bundled ``smx-team`` CLI makes (documented in the app's
``Resources/team/references/operations.md``). No ticket files, no ``smx-team spawn``: the pane
just runs our command. Seedmux types ``launch`` into a fresh login shell of the new pane; we
prefix ``exec`` so the pane *is* the agent CLI and closes when it exits.

Each Seedmux pane is a tmux session ``smx-<paneId>`` on Seedmux's own server
(``~/.seedmux/tmux.sock``). After spawning, Agora only ever addresses **that** session: whether
it still runs, the last keypress of its client, a bracketed paste into it, and killing it when
the person closes the terminal from Agora. Nothing else on that server is read or written.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

SHELLS = {"zsh", "-zsh", "bash", "-bash", "sh", "-sh", "fish", "-fish", "login"}
# Seedmux types the launch line into a new shell; until `exec` replaces the shell the pane
# still shows it. Within this window a shell-only pane counts as "starting", not "gone".
START_GRACE_S = 20.0


class SeedmuxError(RuntimeError):
    pass


def default_bridge_path() -> Path:
    env = os.environ.get("SEEDMUX_TEAM_BRIDGE_PATH")
    return Path(env) if env else Path.home() / "Library" / "Application Support" / "Seedmux" / "team-bridge.json"


def default_socket() -> Path:
    return Path(os.environ.get("AGORA_SEEDMUX_SOCK") or Path.home() / ".seedmux" / "tmux.sock")


@dataclass
class Seedmux:
    bridge_path: Path
    socket: Path
    tmux: str

    @classmethod
    def default(cls) -> "Seedmux":
        return cls(default_bridge_path(), default_socket(), shutil.which("tmux") or "tmux")

    # ——— bridge (official control plane) ———
    def _bridge(self) -> tuple[str, str]:
        try:
            cfg = json.loads(self.bridge_path.read_text())
            port, token = cfg["port"], cfg["token"]
        except FileNotFoundError:
            raise SeedmuxError("Seedmux 没有运行，或在设置 › Agent Team 里关掉了控制桥") from None
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise SeedmuxError(f"读不了 Seedmux 的桥配置：{exc}") from None
        if type(port) is not int or not 1 <= port <= 65535 or not isinstance(token, str) or not token:
            raise SeedmuxError("Seedmux 的桥配置无效")
        return f"http://127.0.0.1:{port}", token

    def _req(self, path: str, body: dict | None = None, timeout: float = 15) -> dict:
        base, token = self._bridge()
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, headers={"X-Token": token, **({"Content-Type": "application/json"} if data else {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                out = json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            raise SeedmuxError(f"Seedmux 拒绝了请求（HTTP {exc.code}）：{exc.read().decode(errors='replace')[:200]}") from None
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise SeedmuxError(f"连不上 Seedmux：{exc}") from None
        if not isinstance(out, dict):
            raise SeedmuxError("Seedmux 返回了无法识别的内容")
        return out

    def check(self) -> dict:
        """``{available, reason?}`` — the bridge answers an authenticated ``GET /panes``."""
        try:
            self._req("/panes", timeout=3)
            return {"available": True}
        except SeedmuxError as exc:
            return {"available": False, "reason": str(exc)}

    def spawn(self, launch: str, cwd: Path, *, focus: bool = True) -> str:
        """A new pane (Seedmux places it beside the focused one) running ``launch``. Returns its id."""
        r = self._req("/spawn", {"launch": launch, "cwd": str(cwd), "focus": focus, "direction": "right"})
        pane = r.get("paneId")
        if not r.get("ok") or not isinstance(pane, str) or not pane:
            raise SeedmuxError(f"Seedmux 没有开出新 pane：{r.get('error') or r}")
        return pane

    # ——— the one pane we created (Seedmux's tmux server) ———
    @staticmethod
    def session(pane_id: str) -> str:
        return f"smx-{pane_id}"

    def _tmux(self, *args: str, input: bytes | None = None, check: bool = False) -> subprocess.CompletedProcess:
        return subprocess.run([self.tmux, "-S", str(self.socket), *args], input=input, capture_output=True, timeout=10, check=check)

    def state(self, pane_id: str) -> str:
        """``running`` (the CLI holds the pane), ``starting`` (still the shell), or ``gone``."""
        r = self._tmux("display-message", "-p", "-t", f"={self.session(pane_id)}:", "#{pane_dead} #{pane_current_command}")
        if r.returncode != 0:
            return "gone"
        dead, _, cmd = r.stdout.decode().strip().partition(" ")
        if dead != "0":
            return "gone"
        return "starting" if cmd in SHELLS else "running"

    def last_input(self, pane_id: str) -> float | None:
        r = self._tmux("list-clients", "-t", f"={self.session(pane_id)}", "-F", "#{client_activity}")
        vals = [float(x) for x in r.stdout.decode().split() if x.strip().isdigit()] if r.returncode == 0 else []
        return max(vals) if vals else None

    def clients(self, pane_id: str) -> int:
        r = self._tmux("list-clients", "-t", f"={self.session(pane_id)}", "-F", "#{client_name}")
        return len(r.stdout.split()) if r.returncode == 0 else 0

    def paste(self, pane_id: str, text: str, buf: str, settle_s: float = 0.4) -> None:
        target = f"={self.session(pane_id)}:"
        self._tmux("load-buffer", "-b", buf, "-", input=text.encode(), check=True)
        self._tmux("paste-buffer", "-p", "-d", "-b", buf, "-t", target, check=True)
        time.sleep(settle_s)
        self._tmux("send-keys", "-t", target, "Enter", check=True)

    def capture(self, pane_id: str, lines: int = 200) -> str:
        r = self._tmux("capture-pane", "-p", "-J", "-S", f"-{lines}", "-t", f"={self.session(pane_id)}:")
        return r.stdout.decode("utf-8", "replace")

    def kill(self, pane_id: str) -> None:
        """End the pane Agora created (Seedmux drops a pane whose session is gone)."""
        self._tmux("kill-session", "-t", f"={self.session(pane_id)}")
