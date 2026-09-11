"""Zero-model Agent stand-in: record raw input and write Codex-like JSONL."""

from __future__ import annotations

import os
import select
import sys
import termios
import time
import tty
from collections.abc import Callable
from pathlib import Path


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    received = Path(args[0])
    native = Path(args[1])
    ready = Path(args[2]) if len(args) > 2 else received.with_name(received.name + ".ready")
    fd = sys.stdin.fileno()
    os.write(sys.stdout.fileno(), b"\x1b[?2004h")
    ready.write_text("ready")
    old = termios.tcgetattr(fd)
    tty.setraw(fd)
    buf = b""
    try:
        with received.open("ab", buffering=0) as out:
            while True:
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                out.write(chunk)
                buf = _take_commands(buf + chunk, native)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def wait_until(pred: Callable[[], bool], path: Path, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    directory = path if path.is_dir() else path.parent
    directory.mkdir(parents=True, exist_ok=True)
    if pred():
        return
    if hasattr(select, "kqueue"):
        _wait_kqueue(pred, directory, deadline)
        return
    _wait_inotify(pred, directory, deadline)


def wait_file(path: Path, timeout: float = 2.0) -> None:
    wait_until(path.exists, path, timeout)


def wait_bytes(path: Path, needle: bytes, timeout: float = 2.0) -> bytes:
    def ready() -> bool:
        return path.is_file() and needle in path.read_bytes()

    wait_until(ready, path, timeout)
    return path.read_bytes()


def _take_commands(buf: bytes, native: Path) -> bytes:
    while True:
        end = buf.find(b"\r")
        if end < 0:
            return buf
        frame, buf = buf[:end], buf[end + 1 :]
        body = frame
        if body.startswith(b"\x1b[200~") and body.endswith(b"\x1b[201~"):
            body = body[6:-6]
        if not body.startswith(b"NATIVE\n"):
            continue
        native.parent.mkdir(parents=True, exist_ok=True)
        payload = body[7:]
        if payload and not payload.endswith(b"\n"):
            payload += b"\n"
        with native.open("ab") as handle:
            handle.write(payload)


def _wait_kqueue(pred: Callable[[], bool], directory: Path, deadline: float) -> None:
    kq = select.kqueue()
    fd = os.open(directory, os.O_RDONLY)
    kq.control(
        [
            select.kevent(
                fd,
                select.KQ_FILTER_VNODE,
                select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND | select.KQ_NOTE_ATTRIB,
            )
        ],
        0,
    )
    try:
        while not pred():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(directory)
            kq.control([], 1, remaining)
    finally:
        os.close(fd)
        kq.close()


def _wait_inotify(pred: Callable[[], bool], directory: Path, deadline: float) -> None:
    import ctypes
    import ctypes.util

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    fd = libc.inotify_init1(0x80000)
    if fd < 0:
        raise OSError("inotify_init1")
    libc.inotify_add_watch(fd, os.fsencode(directory), 0x386)
    poller = select.poll()
    poller.register(fd, select.POLLIN)
    try:
        while not pred():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(directory)
            if poller.poll(remaining * 1000):
                os.read(fd, 4096)
    finally:
        os.close(fd)


if __name__ == "__main__":
    main()
