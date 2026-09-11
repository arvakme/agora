"""Real tmux host: isolation, paste framing, attach rights, reuse, death."""

from __future__ import annotations

import fcntl
import os
import pty
import select
import shutil
import struct
import subprocess
import sys
import termios
import threading
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from host import DeliveryBlocked, Host, HostBusy, SessionGone
from host.runtime import _control_identity
from tests.fake_native_cli import wait_bytes, wait_file

FAKE = Path(__file__).resolve().parent / "fake_native_cli.py"


@pytest.fixture
def tmux_bin() -> str:
    path = shutil.which("tmux")
    if not path:
        pytest.fail("tmux is required for host tests")
    return path


@pytest.fixture
def deploy(tmp_path: Path, tmux_bin: str) -> Iterator[tuple[Host, Path]]:
    root = tmp_path / "deploy"
    host = Host(root, deployment="test", tmux=tmux_bin)
    try:
        yield host, tmp_path
    finally:
        host.close()
        subprocess.run(
            [tmux_bin, "-S", str(host.socket_path), "kill-server"],
            check=False,
            capture_output=True,
        )
        host.socket_path.unlink(missing_ok=True)


def test_session_stays_on_the_deployment_socket(deploy: tuple[Host, Path], tmux_bin: str) -> None:
    host, tmp = deploy
    name = f"iso-{uuid4().hex[:8]}"
    host.ensure_session(name, _fake_cmd(tmp, name), cwd=tmp, native_log=tmp / "n.jsonl")
    ours = subprocess.run(
        [tmux_bin, "-S", str(host.socket_path), "list-sessions", "-F", "#{session_name}"],
        capture_output=True,
        text=True,
        check=True,
        env=_clean_env(),
    )
    assert name in ours.stdout.splitlines()
    default = subprocess.run(
        [tmux_bin, "list-sessions", "-F", "#{session_name}"],
        capture_output=True,
        text=True,
        env=_clean_env(),
    )
    assert name not in default.stdout.splitlines()


def test_deliver_is_bracketed_paste_then_a_separate_enter(deploy: tuple[Host, Path]) -> None:
    host, tmp = deploy
    name, recv, ready = _start_fake(host, tmp)
    wait_file(ready)
    host.deliver(name, "HELLO-PASTE")
    data = wait_bytes(recv, b"HELLO-PASTE")
    assert data == b"\x1b[200~HELLO-PASTE\x1b[201~\r"


def test_readonly_client_input_does_not_reach_the_app(deploy: tuple[Host, Path]) -> None:
    host, tmp = deploy
    name, recv, ready = _start_fake(host, tmp)
    wait_file(ready)
    extra = _attach(host, name, readonly=True)
    try:
        assert host.gate(name).unmanaged_writers == 0
        os.write(extra[1], b"FROM-READONLY\r")
        host.deliver(name, "AFTER-RO")
        data = wait_bytes(recv, b"AFTER-RO")
        assert b"FROM-READONLY" not in data
    finally:
        _detach(extra)


def test_an_unmanaged_writer_blocks_automatic_delivery(deploy: tuple[Host, Path]) -> None:
    host, tmp = deploy
    name, recv, ready = _start_fake(host, tmp)
    wait_file(ready)
    extra = _attach(host, name, readonly=False)
    try:
        if host.gate(name).unmanaged_writers == 0:
            select.select([extra[1]], [], [], 2)
        assert host.gate(name).unmanaged_writers == 1
        with pytest.raises(DeliveryBlocked, match="unmanaged writable"):
            host.deliver(name, "BLOCKED")
        assert not recv.exists() or b"BLOCKED" not in recv.read_bytes()
    finally:
        _detach(extra)
    assert host.gate(name).unmanaged_writers == 0
    host.deliver(name, "AFTER-UNLOCK")
    wait_bytes(recv, b"AFTER-UNLOCK")


def test_detach_leaves_the_application_running(deploy: tuple[Host, Path], tmux_bin: str) -> None:
    host, tmp = deploy
    name, recv, ready = _start_fake(host, tmp)
    wait_file(ready)
    pid = _pane_pid(tmux_bin, host, name)
    extra = _attach(host, name, readonly=True)
    _detach(extra)
    assert _pane_pid(tmux_bin, host, name) == pid
    os.kill(pid, 0)
    host.deliver(name, "STILL-HERE")
    wait_bytes(recv, b"STILL-HERE")


def test_a_new_host_reuses_the_live_session(deploy: tuple[Host, Path], tmux_bin: str) -> None:
    host, tmp = deploy
    name, recv, ready = _start_fake(host, tmp)
    wait_file(ready)
    pid = _pane_pid(tmux_bin, host, name)
    root = host.root
    host.close()
    revived = Host(root, deployment="test", tmux=tmux_bin)
    try:
        revived.ensure_session(name, _fake_cmd(tmp, name), cwd=tmp, native_log=tmp / f"{name}.jsonl")
        assert _pane_pid(tmux_bin, revived, name) == pid
        sessions = subprocess.run(
            [tmux_bin, "-S", str(revived.socket_path), "list-sessions", "-F", "#{session_name}"],
            capture_output=True,
            text=True,
            check=True,
            env=_clean_env(),
        )
        assert sessions.stdout.splitlines().count(name) == 1
        os.kill(pid, 0)
        revived.deliver(name, "REATTACHED")
        wait_bytes(recv, b"REATTACHED")
    finally:
        revived.close()


def test_a_killed_server_is_reported_gone(deploy: tuple[Host, Path], tmux_bin: str) -> None:
    host, tmp = deploy
    name, _recv, ready = _start_fake(host, tmp)
    wait_file(ready)
    subprocess.run([tmux_bin, "-S", str(host.socket_path), "kill-server"], check=True, capture_output=True)
    with pytest.raises(SessionGone):
        host.deliver(name, "TOO-LATE")
    with pytest.raises(SessionGone):
        host.gate(name)


def _start_fake(host: Host, tmp: Path) -> tuple[str, Path, Path]:
    name = f"s-{uuid4().hex[:8]}"
    recv = tmp / f"{name}.bin"
    ready = tmp / f"{name}.ready"
    host.ensure_session(name, _fake_cmd(tmp, name), cwd=tmp, native_log=tmp / f"{name}.jsonl")
    return name, recv, ready


def _fake_cmd(tmp: Path, name: str) -> list[str]:
    return [
        sys.executable,
        str(FAKE),
        str(tmp / f"{name}.bin"),
        str(tmp / f"{name}.jsonl"),
        str(tmp / f"{name}.ready"),
    ]


def _pane_pid(tmux_bin: str, host: Host, name: str) -> int:
    result = subprocess.run(
        [tmux_bin, "-S", str(host.socket_path), "list-panes", "-t", name, "-F", "#{pane_pid}"],
        capture_output=True,
        text=True,
        check=True,
        env=_clean_env(),
    )
    return int(result.stdout.strip())


def _attach(host: Host, name: str, *, readonly: bool) -> tuple[subprocess.Popen[bytes], int]:
    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    proc = subprocess.Popen(
        host.attach_command(name, readonly=readonly),
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=_clean_env(),
        close_fds=True,
    )
    os.close(slave)
    select.select([master], [], [], 2)
    if proc.poll() is not None:
        raise RuntimeError("tmux attach exited before the client appeared")
    return proc, master


def _detach(handle: tuple[subprocess.Popen[bytes], int]) -> None:
    proc, fd = handle
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=1)
    os.close(fd)


def _clean_env() -> dict[str, str]:
    env = os.environ.copy()
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    env["TERM"] = "xterm-256color"
    return env


class _ControlPipes:
    """Stand-in for the control-mode process, wired to plain pipes."""

    def __init__(self, stdin: object, stdout: object) -> None:
        self.stdin = stdin
        self.stdout = stdout


def test_the_handshake_completes_on_the_reply_block_not_on_elapsed_time() -> None:
    """Readiness is tmux's own reply block, not the arrival of bytes.

    Attaching emits notifications immediately; treating those as readiness
    races against the client actually serving commands. The negative half
    needs a real interval: the call must still be waiting while only
    notifications have arrived.
    """
    to_host_read, to_host_write = os.pipe()
    from_host_read, from_host_write = os.pipe()
    proc = _ControlPipes(os.fdopen(from_host_write, "wb"), os.fdopen(to_host_read, "rb"))
    tmux = os.fdopen(to_host_write, "wb")
    host_input = os.fdopen(from_host_read, "rb")
    named: list[str] = []
    handshake = threading.Thread(target=lambda: named.append(_control_identity(proc)))
    handshake.start()
    try:
        tmux.write(b"%session-changed $0 native\n%output %1 booting\n")
        tmux.flush()
        handshake.join(0.3)
        assert handshake.is_alive() and named == []

        tmux.write(b"%begin 1 1 0\n%end 1 1 0\n")
        tmux.flush()
        assert host_input.readline() == b"display-message -p '#{client_name}'\n"

        tmux.write(b"%begin 1 2 1\ncontrol-7\n%end 1 2 1\n")
        tmux.flush()
        handshake.join(5)
        assert not handshake.is_alive()
        assert named == ["control-7"]
    finally:
        tmux.close()
        handshake.join(5)
        host_input.close()
        proc.stdin.close()
        proc.stdout.close()


def test_a_closed_control_pipe_is_reported_not_waited_out() -> None:
    to_host_read, to_host_write = os.pipe()
    from_host_read, from_host_write = os.pipe()
    proc = _ControlPipes(os.fdopen(from_host_write, "wb"), os.fdopen(to_host_read, "rb"))
    os.close(to_host_write)
    host_input = os.fdopen(from_host_read, "rb")
    try:
        with pytest.raises(SessionGone):
            _control_identity(proc)
    finally:
        host_input.close()
        proc.stdin.close()
        proc.stdout.close()


def test_a_second_host_on_the_same_root_is_refused_not_blocked(
    deploy: tuple[Host, Path], tmux_bin: str
) -> None:
    host, _ = deploy
    with pytest.raises(HostBusy):
        Host(host.root, deployment="test", tmux=tmux_bin)


def test_a_body_carrying_a_paste_terminator_is_refused(deploy: tuple[Host, Path]) -> None:
    """A terminator inside the body would make the rest arrive as real keys."""
    host, tmp = deploy
    name, recv, ready = _start_fake(host, tmp)
    wait_file(ready)
    with pytest.raises(ValueError):
        host.deliver(name, "before\x1b[201~after")
    host.deliver(name, "CLEAN-BODY")
    assert wait_bytes(recv, b"CLEAN-BODY") == b"\x1b[200~CLEAN-BODY\x1b[201~\r"
