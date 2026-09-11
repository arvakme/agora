"""Isolated tmux host: create or reuse a session, paste, gate, subscribe."""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import select
import shutil
import subprocess
import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from io import TextIOWrapper
from pathlib import Path
from uuid import UUID, uuid4, uuid5

from native_protocol import (
    DeliveryRecord,
    DeliveryRequest,
    NativeEvent,
    NativeSession,
    RequestOrigin,
    SessionGate,
    apply,
    blocked_reason,
    channel_released,
    hand_off,
    start,
)

from host.watch import JsonlWatcher, Subscription

# A TUI reading bracketed paste treats bytes after this terminator as real
# keys, so a body carrying one would deliver something other than itself.
_PASTE_TERMINATOR = b"\x1b[201~"

_NS = UUID("a3e1c4d2-7b90-4f16-8e2a-5d6c9b0f1a24")
_PASTE_BUFFER = "agora-host-paste"
_CLIENT_FMT = "#{client_name}|#{client_readonly}|#{client_session}"
# An attach over a local socket answers in milliseconds; this only bounds a
# server that stopped answering, so it never decides a healthy attach failed.
_HANDSHAKE_TIMEOUT_S = 10.0

_BASELINE = """set -g destroy-unattached off
set -g exit-unattached off
set -g exit-empty off
set -g set-clipboard off
set -g assume-paste-time 0
set -g escape-time 0
"""


class DeliveryBlocked(Exception):
    """Automatic delivery is refused by the current session gate."""


class SessionGone(Exception):
    """The tmux server or named session is not there. Do not treat it as live."""


class HostBusy(Exception):
    """Another host already holds this deployment root."""


@dataclass
class _Session:
    name: str
    command: tuple[str, ...]
    cwd: Path
    native_log: Path
    native_locator: str
    client: str | None = None
    control: subprocess.Popen[bytes] | None = None
    record: DeliveryRecord | None = None
    visible_from: int = 0
    watchers: list[JsonlWatcher] = field(default_factory=list)


class Host:
    """One deployment's tmux server and the sessions running on it."""

    def __init__(
        self,
        root: Path,
        *,
        deployment: str,
        user_conf: Path | None = None,
        tmux: str | None = None,
    ) -> None:
        self.root = root
        self.deployment = deployment
        self.socket_path = _short_socket(root, deployment)
        self._conf = root / "tmux.conf"
        self._bin = tmux or shutil.which("tmux")
        if not self._bin:
            raise RuntimeError("tmux is required")
        if user_conf is not None and not user_conf.is_file():
            raise FileNotFoundError(user_conf)
        self._user_conf = user_conf
        self._env = _tmux_env()
        self._lock = threading.RLock()
        self._sessions: dict[str, _Session] = {}
        root.mkdir(parents=True, exist_ok=True)
        self._lock_fd: TextIOWrapper | None = (root / "host.lock").open("a+")
        try:
            fcntl.flock(self._lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self._lock_fd.close()
            self._lock_fd = None
            raise HostBusy(f"deployment root {root} is already held by another host") from error
        self._write_conf()
        self._load_index()

    def close(self) -> None:
        with self._lock:
            for state in self._sessions.values():
                _stop_control(state)
                for watcher in state.watchers:
                    watcher.stop()
                state.watchers.clear()
        if self._lock_fd is not None:
            fcntl.flock(self._lock_fd.fileno(), fcntl.LOCK_UN)
            self._lock_fd.close()
            self._lock_fd = None

    def __enter__(self) -> Host:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def ensure_session(
        self,
        name: str,
        command: Sequence[str],
        *,
        cwd: Path,
        native_log: Path,
        native_locator: str | None = None,
    ) -> str:
        if not name or not command:
            raise ValueError("session name and command are required")
        locator = native_locator or name
        with self._lock:
            if name in self._tmux_sessions():
                state = self._sessions.get(name)
                if state is None:
                    state = _Session(
                        name=name,
                        command=tuple(command),
                        cwd=cwd,
                        native_log=native_log,
                        native_locator=locator,
                    )
                    self._sessions[name] = state
                else:
                    state.native_log = native_log
                    state.native_locator = locator
                self._hold_client(state)
                self._save_index()
                return name
            cwd.mkdir(parents=True, exist_ok=True)
            try:
                self._new_session(name, cwd, command)
            except SessionGone as exc:
                err = str(exc).lower()
                if self.socket_path.exists() and ("connect" in err or "no server" in err):
                    self.socket_path.unlink()
                    self._new_session(name, cwd, command)
                else:
                    raise
            state = _Session(
                name=name,
                command=tuple(command),
                cwd=cwd,
                native_log=native_log,
                native_locator=locator,
            )
            self._sessions[name] = state
            self._hold_client(state)
            self._save_index()
            return name

    def deliver(self, name: str, body: str) -> None:
        if not body:
            raise ValueError("body is required")
        encoded = body.encode()
        if _PASTE_TERMINATOR in encoded:
            raise ValueError("body carries a bracketed-paste terminator and cannot be delivered")
        with self._lock:
            state = self._require(name)
            record = start(self._request(state, body))
            reason = blocked_reason(record, self._gate(state))
            if reason:
                raise DeliveryBlocked(reason)
            # Anything the CLI wrote before this point belongs to an earlier
            # turn and must not bind or settle the request being sent now.
            state.visible_from = _log_end(state.native_log)
            paste = self.root / f".paste-{name}"
            paste.write_bytes(encoded)
            try:
                self._tmux("load-buffer", "-b", _PASTE_BUFFER, str(paste))
                self._tmux("paste-buffer", "-prd", "-b", _PASTE_BUFFER, "-t", name)
            finally:
                paste.unlink(missing_ok=True)
            if not state.client:
                raise SessionGone(f"session {name} has no managed client")
            self._tmux("send-keys", "-c", state.client, "-t", name, "Enter")
            state.record = hand_off(record)

    def gate(self, name: str) -> SessionGate:
        with self._lock:
            return self._gate(self._require(name))

    async def subscribe(self, name: str) -> Subscription:
        with self._lock:
            state = self._require(name)
            locator = state.native_locator
            log = state.native_log
            # A settled record stays on the session; only an unreleased
            # channel means the delivery whose start this marks is still live.
            live = state.record is not None and not channel_released(state.record)
            start_at = state.visible_from if live else _log_end(log)
        queue: asyncio.Queue[object] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        watcher = JsonlWatcher(log, session=locator, start_at=start_at)

        def on_item(item: object) -> None:
            if isinstance(item, NativeEvent):
                with self._lock:
                    current = self._sessions.get(name)
                    if current is None or current.record is None:
                        return
                    current.record = apply(current.record, item).record

        wrapped: asyncio.Queue[object] = queue

        class _Folding(Subscription):
            async def __anext__(self) -> NativeEvent:
                event = await super().__anext__()
                on_item(event)
                return event

        sub = _Folding(wrapped, watcher)
        watcher.arm(loop, wrapped)
        with self._lock:
            self._sessions[name].watchers.append(watcher)
        return sub

    def attach_command(self, name: str, *, readonly: bool = True) -> list[str]:
        cmd = [self._bin, "-S", str(self.socket_path), "-f", str(self._conf), "attach-session"]
        if readonly:
            cmd.append("-r")
        cmd.extend(["-t", name])
        return cmd

    def _gate(self, state: _Session) -> SessionGate:
        unmanaged = 0
        for client in self._clients():
            if client.session != state.name:
                continue
            if client.readonly:
                continue
            if client.name == state.client:
                continue
            unmanaged += 1
        outstanding = 0
        awaiting = False
        if state.record is not None:
            awaiting = state.record.awaiting_permission
            if not channel_released(state.record):
                outstanding = 1
        return SessionGate(unmanaged_writers=unmanaged, outstanding_requests=outstanding, awaiting_permission=awaiting)

    def _require(self, name: str) -> _Session:
        if name not in self._tmux_sessions():
            raise SessionGone(f"session {name} is gone")
        state = self._sessions.get(name)
        if state is None:
            raise SessionGone(f"session {name} is not held by this host")
        self._hold_client(state)
        return state

    def _hold_client(self, state: _Session) -> None:
        if state.control is not None and state.control.poll() is None and state.client:
            names = {c.name for c in self._clients() if c.session == state.name}
            if state.client in names:
                return
        _stop_control(state)
        proc = subprocess.Popen(
            [
                self._bin,
                "-S",
                str(self.socket_path),
                "-f",
                str(self._conf),
                "-C",
                "attach-session",
                "-t",
                state.name,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=self._env,
        )
        state.control = proc
        try:
            state.client = _control_identity(proc)
        except SessionGone:
            _stop_control(state)
            raise
        threading.Thread(target=_drain, args=(proc.stdout,), daemon=True).start()

    def _clients(self) -> list[_Client]:
        raw = self._tmux("list-clients", "-F", _CLIENT_FMT, check=False)
        clients: list[_Client] = []
        for line in raw.splitlines():
            name, readonly, session = (line.split("|") + ["", "", ""])[:3]
            if not name:
                continue
            clients.append(_Client(name=name, readonly=readonly == "1", session=session))
        return clients

    def _tmux_sessions(self) -> set[str]:
        raw = self._tmux("list-sessions", "-F", "#{session_name}", check=False)
        return {line for line in raw.splitlines() if line}

    def _tmux(self, *args: str, check: bool = True) -> str:
        result = subprocess.run(
            [self._bin, "-S", str(self.socket_path), "-f", str(self._conf), *args],
            env=self._env,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            if check:
                raise SessionGone(result.stderr.strip() or "tmux failed")
            return ""
        return result.stdout

    def _request(self, state: _Session, body: str) -> DeliveryRequest:
        return DeliveryRequest(
            request_id=uuid4(),
            origin=RequestOrigin(
                room_id=uuid5(_NS, f"{self.deployment}:room"),
                request_seq=0,
                requested_by=uuid5(_NS, f"{self.deployment}:user"),
            ),
            session=NativeSession(
                deployment=self.deployment,
                participant_id=uuid5(_NS, f"{self.deployment}:participant"),
                computer_id=uuid5(_NS, f"{self.deployment}:computer"),
                adapter="codex",
                tmux_target=f"{self.socket_path}:{state.name}",
                native_locator=state.native_locator,
            ),
            body=body,
        )

    def _new_session(self, name: str, cwd: Path, command: Sequence[str]) -> None:
        self._tmux(
            "new-session",
            "-d",
            "-s",
            name,
            "-x",
            "80",
            "-y",
            "24",
            "-c",
            str(cwd),
            *command,
        )

    def _write_conf(self) -> None:
        parts: list[str] = []
        if self._user_conf is not None:
            parts.append(f"source-file {json.dumps(str(self._user_conf))}\n")
        parts.append(_BASELINE)
        self._conf.write_text("".join(parts))

    def _load_index(self) -> None:
        path = self.root / "sessions.json"
        if not path.is_file():
            return
        data = json.loads(path.read_text())
        if data.get("deployment") not in (None, self.deployment):
            raise ValueError("deployment does not match this host root")
        for name, item in data.get("sessions", {}).items():
            self._sessions[name] = _Session(
                name=name,
                command=tuple(item["command"]),
                cwd=Path(item["cwd"]),
                native_log=Path(item["native_log"]),
                native_locator=item["native_locator"],
            )

    def _save_index(self) -> None:
        payload = {
            "deployment": self.deployment,
            "sessions": {
                name: {
                    "command": list(state.command),
                    "cwd": str(state.cwd),
                    "native_log": str(state.native_log),
                    "native_locator": state.native_locator,
                }
                for name, state in self._sessions.items()
            },
        }
        (self.root / "sessions.json").write_text(json.dumps(payload, indent=2))


@dataclass(frozen=True)
class _Client:
    name: str
    readonly: bool
    session: str


def _short_socket(root: Path, deployment: str) -> Path:
    digest = hashlib.sha256(f"{root.resolve()}\0{deployment}".encode()).hexdigest()[:16]
    return Path("/tmp") / f"ag-{digest}.sock"


def _tmux_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    env["TERM"] = "xterm-256color"
    return env


def _stop_control(state: _Session) -> None:
    proc = state.control
    state.control = None
    state.client = None
    if proc is None:
        return
    if proc.stdin is not None:
        try:
            proc.stdin.close()
        except OSError:
            pass
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=1)


def _read_block(fd: int, pending: bytearray, deadline: float) -> list[str]:
    """Return the body of tmux's next %begin/%end reply block.

    Control mode wraps every reply in such a block and emits notifications
    outside them, so a complete block is tmux's own statement that it served a
    command. Reads go through the raw descriptor and this caller-owned buffer:
    a buffered reader would leave already-consumed lines invisible to select
    and stall on data that has in fact arrived.
    """
    body: list[str] = []
    inside = False
    while True:
        while b"\n" in pending:
            line, _, rest = pending.partition(b"\n")
            del pending[:]
            pending.extend(rest)
            text = line.decode(errors="replace").rstrip("\r")
            if text.startswith("%begin"):
                inside, body = True, []
            elif text.startswith("%error"):
                raise SessionGone(f"control client refused a command: {text}")
            elif text.startswith("%end") and inside:
                return body
            elif inside:
                body.append(text)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SessionGone("control client never finished the handshake")
        if not select.select([fd], [], [], remaining)[0]:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            raise SessionGone("control client closed before the handshake")
        pending.extend(chunk)


def _log_end(log: Path) -> int:
    try:
        return log.stat().st_size
    except OSError:
        return 0


def _control_identity(proc: subprocess.Popen[bytes]) -> str:
    """Wait for the control client to serve commands, then have it name itself.

    Attaching produces a reply block of its own; that block, not the arrival of
    bytes, is when the client is attached and serving. A command written before
    it is dropped. The name tmux reports is exact where diffing client lists
    only guesses which new client is ours.
    """
    if proc.stdin is None or proc.stdout is None:
        raise SessionGone("control client was started without pipes")
    deadline = time.monotonic() + _HANDSHAKE_TIMEOUT_S
    fd = proc.stdout.fileno()
    pending = bytearray()
    _read_block(fd, pending, deadline)
    try:
        proc.stdin.write(b"display-message -p '#{client_name}'\n")
        proc.stdin.flush()
    except OSError as error:
        raise SessionGone(f"control client would not take the handshake: {error}") from error
    reply = _read_block(fd, pending, deadline)
    name = reply[0].strip() if reply else ""
    if not name:
        raise SessionGone("control client did not name itself")
    return name


def _drain(stream: object) -> None:
    read = getattr(stream, "read", None)
    if read is None:
        return
    try:
        while read(4096):
            pass
    except OSError:
        return
