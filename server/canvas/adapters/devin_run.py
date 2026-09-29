#!/usr/bin/env python3
"""Runs one ``devin -p`` turn for Agora and tells the host what happened, as JSON lines on stdout.

``devin -p`` prints only the final answer (no events); the turn itself is written to the CLI's SQLite
log, which Agora follows. What the host still needs from the process is what the log cannot say:

- ``{"type": "init", "mode": <permission mode>, "model": <model or null>}`` — first, so the header can say
  how the session runs;
- ``{"type": "session", "id": <id>}`` — the id Devin gave a new session (it is not printed anywhere): the
  one session of this directory that appeared after the start; a resumed session (``-r <id>``) is known at once;
- ``{"type": "text", "text": <the answer>}`` and ``{"type": "turn_end", "code": <exit code>, "stderr": <tail>}``;
- ``{"type": "interrupted"}`` instead of the last two when the host stopped the turn (SIGTERM / SIGINT).

Stopping also stops what Devin started: its tool processes live in their own process groups, so
killing the CLI leaves them running (measured with ``sleep 45``); every descendant is stopped here.
Run by path (the project directory is the working directory, not this repo); it only needs the standard library and server/canvas/proctree.py, which does the stopping for every CLI.
Usage: ``devin_run.py <devin> [devin args…]``."""

from __future__ import annotations

import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))  # run by path: the repo root for the shared stop
from server.canvas import proctree  # noqa: E402

POLL_S = 0.3


def emit(**event: object) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def query(sql: str, args: tuple = ()) -> list[tuple]:
    db = Path.home() / ".local" / "share" / "devin" / "cli" / "sessions.db"
    if not db.is_file():
        return []
    try:
        con = sqlite3.connect(f"file:{urllib.parse.quote(str(db))}?mode=ro", uri=True, timeout=1)
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return []


def option(args: list[str], *names: str) -> str | None:
    """The value of the first of ``names`` before the ``--`` that ends the options."""
    for i, a in enumerate(args):
        if a == "--":
            break
        if a in names and i + 1 < len(args):
            return args[i + 1]
    return None


def main(argv: list[str]) -> int:
    if not argv:
        sys.stderr.write("usage: devin_run.py <devin> [args…]\n")
        return 2
    exe, args = argv[0], argv[1:]
    cwd = os.getcwd()
    where = tuple(dict.fromkeys([cwd, os.path.realpath(cwd)]))
    marks = ",".join("?" * len(where))
    resumed = option(args, "-r", "--resume")
    emit(type="init", mode=option(args, "--permission-mode") or "auto", model=option(args, "--model"))
    session = resumed
    if session:
        emit(type="session", id=session)
    before = {r[0] for r in query(f"select id from sessions where working_directory in ({marks})", where)} if not session else set()
    started = time.time()

    stopping = threading.Event()
    child: subprocess.Popen[str] | None = None
    watch: proctree.Watch | None = None  # descendants noticed while the turn ran

    def on_signal(signum: int, _frame: object) -> None:
        stopping.set()
        if child is not None:
            proctree.stop(child.pid, watch.seen if watch else None, 2.0)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    try:
        child = subprocess.Popen([exe, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=cwd)
    except OSError as exc:
        emit(type="turn_end", code=127, stderr=f"spawn: {exc}")
        return 127
    watch = proctree.Watch(child.pid)
    out: list[str] = []
    err: list[str] = []
    readers = [threading.Thread(target=lambda: out.append(child.stdout.read()), daemon=True), threading.Thread(target=lambda: err.append(child.stderr.read()), daemon=True)]
    for r in readers:
        r.start()

    def claim() -> str | None:
        rows = query(f"select id from sessions where working_directory in ({marks}) and created_at >= ? order by created_at, rowid", (*where, int(started) - 1))
        return next((r[0] for r in rows if r[0] not in before), None)

    while child.poll() is None:
        watch.update()
        if session is None:
            session = claim()
            if session:
                emit(type="session", id=session)
        time.sleep(POLL_S)
    for r in readers:
        r.join(timeout=5)
    if session is None:
        session = claim()
        if session:
            emit(type="session", id=session)
    if stopping.is_set():
        emit(type="interrupted")
        return 143
    text = "".join(out).strip()
    if child.returncode == 0 and text:
        emit(type="text", text=text)
    lines = [ln for ln in "".join(err).splitlines() if ln.strip()]
    emit(type="turn_end", code=child.returncode, stderr="\n".join(lines[:3])[:400])
    return 0 if child.returncode == 0 else child.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
