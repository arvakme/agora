"""End-to-end ask flow: host delivery, native evidence, and Postgres persistence."""

from __future__ import annotations

import fcntl
import os
import select
import shutil
import struct
import subprocess
import sys
import termios
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlparse, urlunparse
from uuid import uuid4

import asyncpg
import pytest

from agora_ask.config import AskSettings
from agora_ask.run import AskError, ask_once
from host import Host
from server import db, delivery
from tests.conftest import DSN
from tests.fake_native_cli import wait_file

FAKE = Path(__file__).resolve().parent / "fake_native_cli.py"


def _isolated_dsn(url: str) -> str:
    parsed = urlparse(url)
    if parsed.path.lstrip("/") == "agora":
        return urlunparse(parsed._replace(path="/agora_delivery"))
    return url


DELIVERY_DSN = _isolated_dsn(DSN)


def _safe_dbname(url: str) -> str:
    name = urlparse(url).path.lstrip("/")
    if not name.replace("_", "").isalnum():
        raise ValueError(f"unsafe database name {name!r}")
    return name


async def _ensure_database(target: str, admin: str) -> None:
    if target == admin:
        return
    name = _safe_dbname(target)
    conn = await asyncpg.connect(admin)
    try:
        found = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name)
        if found:
            return
        try:
            await conn.execute(f"CREATE DATABASE {name}")
        except asyncpg.DuplicateDatabaseError:
            return
    finally:
        await conn.close()


@pytest.fixture
def tmux_bin() -> str:
    path = shutil.which("tmux")
    if not path:
        pytest.fail("tmux is required for agora_ask tests")
    return path


@pytest.fixture
async def pool(require_services: None) -> asyncpg.Pool:
    await _ensure_database(DELIVERY_DSN, DSN)
    created = await db.create_pool(DELIVERY_DSN)
    await db.migrate(created)
    await db.truncate_all(created)
    yield created
    await created.close()


@pytest.fixture
def deploy(tmp_path: Path, tmux_bin: str) -> Iterator[tuple[Host, Path]]:
    host = Host(tmp_path / "deploy", deployment="ask", tmux=tmux_bin)
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


def _fake_settings(tmp: Path, pool_dsn: str, *, name: str, log: Path, ready: Path) -> AskSettings:
    recv = tmp / f"{name}.bin"
    return AskSettings(
        host_root=tmp / "deploy",
        deployment="ask",
        session_name=name,
        codex_command=" ".join(
            [
                sys.executable,
                str(FAKE),
                str(recv),
                str(log),
                str(ready),
            ]
        ),
        cwd=tmp,
        database_url=pool_dsn,
        native_log=log,
        native_locator=name,
        timeout_s=10.0,
    )


def _start_fake(host: Host, tmp: Path) -> tuple[str, Path, Path, Path]:
    name = f"ask-{uuid4().hex[:8]}"
    recv = tmp / f"{name}.bin"
    ready = tmp / f"{name}.ready"
    log = tmp / f"{name}.jsonl"
    host.ensure_session(
        name,
        [sys.executable, str(FAKE), str(recv), str(log), str(ready)],
        cwd=tmp,
        native_log=log,
    )
    wait_file(ready)
    return name, recv, ready, log


@pytest.mark.asyncio
async def test_ask_delivers_records_and_returns_native_answer(
    deploy: tuple[Host, Path], pool: asyncpg.Pool
) -> None:
    host, tmp = deploy
    name, recv, ready, log = _start_fake(host, tmp)
    settings = _fake_settings(tmp, DELIVERY_DSN, name=name, log=log, ready=ready)
    host.close()

    answer = await ask_once("hello from ask", settings, pool=pool)
    assert answer == "echo: hello from ask"
    assert recv.exists() and b"hello from ask" in recv.read_bytes()

    rows = await pool.fetch("SELECT record FROM delivery_records")
    assert len(rows) == 1
    record = delivery._load(rows[0]["record"])
    assert record.turn_state == "completed"
    assert record.result is not None
    assert record.result.summary == answer


@pytest.mark.asyncio
async def test_ask_reports_delivery_blocked(deploy: tuple[Host, Path], pool: asyncpg.Pool) -> None:
    host, tmp = deploy
    name, _recv, ready, log = _start_fake(host, tmp)
    settings = _fake_settings(tmp, DELIVERY_DSN, name=name, log=log, ready=ready)
    extra = _attach(host, name, readonly=False)
    try:
        with pytest.raises(AskError, match="delivery blocked"):
            await ask_once("should not pass", settings, host=host, pool=pool)
    finally:
        _detach(extra)


@pytest.mark.asyncio
async def test_ask_reports_session_gone(
    deploy: tuple[Host, Path], pool: asyncpg.Pool, tmux_bin: str
) -> None:
    host, tmp = deploy
    name, _recv, ready, log = _start_fake(host, tmp)
    settings = _fake_settings(tmp, DELIVERY_DSN, name=name, log=log, ready=ready)
    subprocess.run([tmux_bin, "-S", str(host.socket_path), "kill-server"], check=True, capture_output=True)

    with pytest.raises(AskError, match="session gone"):
        await ask_once("too late", settings, host=host, pool=pool)


@pytest.mark.asyncio
async def test_ask_times_out_without_native_completion(
    deploy: tuple[Host, Path], pool: asyncpg.Pool
) -> None:
    host, tmp = deploy
    name = f"idle-{uuid4().hex[:8]}"
    log = tmp / f"{name}.jsonl"
    host.ensure_session(
        name,
        [sys.executable, "-c", "import time; time.sleep(3600)"],
        cwd=tmp,
        native_log=log,
    )
    settings = AskSettings(
        host_root=tmp / "deploy",
        deployment="ask",
        session_name=name,
        codex_command=f"{sys.executable} -c 'import time; time.sleep(3600)'",
        cwd=tmp,
        database_url=DELIVERY_DSN,
        native_log=log,
        native_locator=name,
        timeout_s=0.3,
    )

    with pytest.raises(AskError, match="timed out"):
        await ask_once("never answered", settings, host=host, pool=pool)


def _attach(host: Host, name: str, *, readonly: bool) -> tuple[subprocess.Popen[bytes], int]:
    import pty

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
