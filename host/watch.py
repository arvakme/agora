"""File-event JSONL cursor: register the existing ancestor, then catch up."""

from __future__ import annotations

import asyncio
import json
import os
import select
import threading
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import UUID, uuid5

from native_protocol import NativeEvent

_EVENT_NS = UUID("6b1d0a8e-2c3f-4a91-9d77-0f4e2b8c1a55")
_END = object()

_NOTE = 0
if hasattr(select, "kqueue"):
    _NOTE = (
        select.KQ_NOTE_WRITE
        | select.KQ_NOTE_EXTEND
        | select.KQ_NOTE_ATTRIB
        | select.KQ_NOTE_DELETE
        | select.KQ_NOTE_RENAME
        | select.KQ_NOTE_LINK
    )


def parse_rollout_line(
    raw: bytes,
    *,
    session: str,
    offset: int,
    last_turn: str | None,
) -> tuple[NativeEvent | None, str | None]:
    """Map one Codex-like JSONL record to a native event, or skip it."""
    try:
        record = json.loads(raw)
    except json.JSONDecodeError:
        return None, last_turn
    if not isinstance(record, dict):
        return None, last_turn
    payload = record.get("payload")
    payload = payload if isinstance(payload, dict) else {}
    inner = payload.get("type") if record.get("type") == "event_msg" else None
    turn = payload.get("turn_id")
    if isinstance(turn, str) and turn:
        last_turn = turn
    elif inner == "task_started":
        return None, last_turn
    kind = None
    summary = ""
    if inner == "user_message":
        kind = "input_accepted"
        message = payload.get("message")
        summary = message if isinstance(message, str) else ""
        turn = turn or last_turn
    elif inner == "task_complete":
        kind = "execution_completed"
        message = payload.get("last_agent_message")
        summary = message if isinstance(message, str) else ""
    elif inner == "turn_aborted":
        kind = "execution_failed"
        reason = payload.get("reason")
        summary = reason if isinstance(reason, str) else ""
    elif inner == "permission_wait":
        kind = "permission_wait"
        note = payload.get("message") or payload.get("reason")
        summary = note if isinstance(note, str) else ""
    if kind is None:
        return None, last_turn
    if kind in {"input_accepted", "execution_completed", "execution_failed"} and not turn:
        return None, last_turn
    event = NativeEvent(
        event_id=uuid5(_EVENT_NS, f"{offset}:{raw.decode('utf-8', 'surrogateescape')}"),
        kind=kind,
        evidence="native_record",
        session=session,
        turn_id=turn if isinstance(turn, str) and turn else None,
        summary=summary,
    )
    return event, last_turn


class Subscription:
    """Armed native-log reader. `async for` yields each complete record."""

    def __init__(self, queue: asyncio.Queue[object], watcher: "JsonlWatcher") -> None:
        self._queue = queue
        self._watcher = watcher

    def __aiter__(self) -> AsyncIterator[NativeEvent]:
        return self

    async def __anext__(self) -> NativeEvent:
        item = await self._queue.get()
        if item is _END:
            raise StopAsyncIteration
        assert isinstance(item, NativeEvent)
        return item

    async def aclose(self) -> None:
        self._watcher.stop()


class JsonlWatcher:
    def __init__(self, path: Path, *, session: str) -> None:
        self._path = path
        self._session = session
        self._cursor = 0
        self._tail = b""
        self._last_turn: str | None = None
        self._fds: dict[int, Path] = {}
        self._paths: dict[Path, int] = {}
        self._wake_r = -1
        self._wake_w = -1
        self._kq: select.kqueue | None = None
        self._inotify = -1
        self._wds: dict[int, Path] = {}
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[object] | None = None
        self._stop = threading.Event()

    def arm(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[object]) -> None:
        self._loop = loop
        self._queue = queue
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_r, False)
        if hasattr(select, "kqueue"):
            self._kq = select.kqueue()
        else:
            self._inotify = _inotify_init()
        self._descend()
        self._thread = threading.Thread(target=self._run, name="host-jsonl", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._stop.is_set():
            return
        self._stop.set()
        if self._wake_w >= 0:
            try:
                os.write(self._wake_w, b"x")
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._emit(_END)
        self._close_backend()

    def _descend(self) -> None:
        current = _deepest_existing(self._path)
        self._watch(current)
        self._ingest(current)
        while current != self._path:
            nxt = _child_towards(current, self._path)
            if nxt is None or not nxt.exists():
                return
            self._watch(nxt)
            self._ingest(nxt)
            current = nxt

    def _watch(self, path: Path) -> None:
        if path in self._paths:
            return
        fd = os.open(path, os.O_RDONLY)
        self._fds[fd] = path
        self._paths[path] = fd
        if self._kq is not None:
            self._kq.control(
                [
                    select.kevent(
                        fd,
                        select.KQ_FILTER_VNODE,
                        select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                        _NOTE,
                    )
                ],
                0,
            )
            return
        mask = _IN_CREATE | _IN_MOVED_TO | _IN_MODIFY | _IN_ATTRIB | _IN_DELETE | _IN_DELETE_SELF
        wd = _inotify_add(self._inotify, path, mask)
        self._wds[wd] = path

    def _ingest(self, path: Path) -> None:
        if path != self._path or not self._path.is_file():
            return
        with self._path.open("rb") as handle:
            handle.seek(self._cursor)
            chunk = handle.read()
        if not chunk:
            return
        origin = self._cursor - len(self._tail)
        self._cursor += len(chunk)
        data = self._tail + chunk
        start = 0
        while True:
            nl = data.find(b"\n", start)
            if nl < 0:
                break
            line = data[start:nl]
            event, self._last_turn = parse_rollout_line(
                line, session=self._session, offset=origin + start, last_turn=self._last_turn
            )
            if event is not None:
                self._emit(event)
            start = nl + 1
        self._tail = data[start:]

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if self._kq is not None:
                    self._wait_kqueue()
                else:
                    self._wait_inotify()
            except OSError:
                if self._stop.is_set():
                    return
                raise
            if self._stop.is_set():
                return
            self._descend()

    def _wait_kqueue(self) -> None:
        assert self._kq is not None
        events = self._kq.control(
            [
                select.kevent(
                    self._wake_r,
                    select.KQ_FILTER_READ,
                    select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                )
            ],
            16,
            None,
        )
        for event in events:
            ident = int(event.ident)
            if ident == self._wake_r:
                return

    def _wait_inotify(self) -> None:
        poller = select.poll()
        poller.register(self._inotify, select.POLLIN)
        poller.register(self._wake_r, select.POLLIN)
        poller.poll()
        if self._stop.is_set():
            return
        try:
            os.read(self._inotify, 4096)
        except BlockingIOError:
            return

    def _emit(self, item: object) -> None:
        loop = self._loop
        queue = self._queue
        if loop is None or queue is None:
            return
        loop.call_soon_threadsafe(queue.put_nowait, item)

    def _close_backend(self) -> None:
        if self._kq is not None:
            self._kq.close()
            self._kq = None
        if self._inotify >= 0:
            os.close(self._inotify)
            self._inotify = -1
        for fd in list(self._fds):
            os.close(fd)
        self._fds.clear()
        self._paths.clear()
        self._wds.clear()
        for fd in (self._wake_r, self._wake_w):
            if fd >= 0:
                os.close(fd)
        self._wake_r = self._wake_w = -1


def _deepest_existing(path: Path) -> Path:
    current = path
    while not current.exists():
        if current.parent == current:
            return current
        current = current.parent
    return current


def _child_towards(current: Path, target: Path) -> Path | None:
    try:
        rel = target.relative_to(current)
    except ValueError:
        return None
    if rel == Path("."):
        return None
    return current / rel.parts[0]


_IN_MODIFY = 0x00000002
_IN_ATTRIB = 0x00000004
_IN_MOVED_TO = 0x00000080
_IN_CREATE = 0x00000100
_IN_DELETE = 0x00000200
_IN_DELETE_SELF = 0x00000400
_IN_CLOEXEC = 0x00080000
_IN_NONBLOCK = 0x00000800


def _inotify_init() -> int:
    import ctypes
    import ctypes.util

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    libc.inotify_init1.argtypes = [ctypes.c_int]
    libc.inotify_init1.restype = ctypes.c_int
    fd = libc.inotify_init1(_IN_CLOEXEC | _IN_NONBLOCK)
    if fd < 0:
        raise OSError(ctypes.get_errno(), "inotify_init1")
    return fd


def _inotify_add(fd: int, path: Path, mask: int) -> int:
    import ctypes
    import ctypes.util

    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
    libc.inotify_add_watch.restype = ctypes.c_int
    wd = libc.inotify_add_watch(fd, os.fsencode(path), mask)
    if wd < 0:
        raise OSError(ctypes.get_errno(), f"inotify_add_watch {path}")
    return wd
