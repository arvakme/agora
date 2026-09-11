"""Native JSONL subscription: batch lines, half-writes, and a late directory."""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from host import Host
from tests.test_host_fake_cli import wait_file

FAKE = Path(__file__).resolve().parent / "test_host_fake_cli.py"


@pytest.fixture
def tmux_bin() -> str:
    path = shutil.which("tmux")
    if not path:
        pytest.fail("tmux is required for host tests")
    return path


@pytest.fixture
def deploy(tmp_path: Path, tmux_bin: str) -> Iterator[tuple[Host, Path]]:
    host = Host(tmp_path / "deploy", deployment="watch", tmux=tmux_bin)
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


@pytest.mark.asyncio
async def test_batch_records_are_each_visible(deploy: tuple[Host, Path]) -> None:
    host, tmp = deploy
    name, log = _idle_session(host, tmp, log=tmp / "batch.jsonl")
    sub = await host.subscribe(name)
    log.write_text(
        _record("user_message", turn="t1", message="one")
        + _record("user_message", turn="t2", message="two")
        + _record("task_complete", turn="t1", message="done")
    )
    first = await asyncio.wait_for(anext(sub), 2)
    second = await asyncio.wait_for(anext(sub), 2)
    third = await asyncio.wait_for(anext(sub), 2)
    await sub.aclose()
    assert [first.kind, second.kind, third.kind] == [
        "input_accepted",
        "input_accepted",
        "execution_completed",
    ]
    assert [first.turn_id, second.turn_id, third.turn_id] == ["t1", "t2", "t1"]
    assert first.evidence == "native_record"


@pytest.mark.asyncio
async def test_a_half_line_waits_for_the_rest(deploy: tuple[Host, Path]) -> None:
    host, tmp = deploy
    name, log = _idle_session(host, tmp, log=tmp / "half.jsonl")
    sub = await host.subscribe(name)
    prefix, suffix = _split_record("user_message", turn="t9", message="later")
    log.write_bytes(prefix)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(anext(sub), 0.2)
    with log.open("ab") as handle:
        handle.write(suffix)
    event = await asyncio.wait_for(anext(sub), 2)
    await sub.aclose()
    assert event.kind == "input_accepted"
    assert event.turn_id == "t9"


@pytest.mark.asyncio
async def test_a_directory_created_after_subscribe_is_not_lost(deploy: tuple[Host, Path]) -> None:
    host, tmp = deploy
    log = tmp / "later" / "nested" / "rollout.jsonl"
    name, _ = _idle_session(host, tmp, log=log)
    assert not log.parent.exists()
    sub = await host.subscribe(name)
    log.parent.mkdir(parents=True)
    log.write_text(
        _record("user_message", turn="t3", message="born")
        + _record("turn_aborted", turn="t3", message="stop")
    )
    accepted = await asyncio.wait_for(anext(sub), 2)
    failed = await asyncio.wait_for(anext(sub), 2)
    await sub.aclose()
    assert accepted.kind == "input_accepted"
    assert failed.kind == "execution_failed"
    assert accepted.turn_id == failed.turn_id == "t3"


@pytest.mark.asyncio
async def test_the_fake_cli_writes_rollout_records_on_command(deploy: tuple[Host, Path]) -> None:
    host, tmp = deploy
    name = f"s-{uuid4().hex[:8]}"
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
    sub = await host.subscribe(name)
    host.deliver(
        name,
        "NATIVE\n"
        + _record("user_message", turn="cmd-1", message="hi").rstrip("\n")
        + "\n"
        + _record("task_complete", turn="cmd-1", message="ok").rstrip("\n"),
    )
    accepted = await asyncio.wait_for(anext(sub), 2)
    done = await asyncio.wait_for(anext(sub), 2)
    await sub.aclose()
    assert accepted.kind == "input_accepted"
    assert done.kind == "execution_completed"
    assert accepted.turn_id == done.turn_id == "cmd-1"


def _idle_session(host: Host, tmp: Path, *, log: Path) -> tuple[str, Path]:
    name = f"w-{uuid4().hex[:8]}"
    host.ensure_session(
        name,
        [sys.executable, "-c", "import time; time.sleep(3600)"],
        cwd=tmp,
        native_log=log,
    )
    return name, log


def _record(inner: str, *, turn: str, message: str) -> str:
    payload = {"type": inner, "turn_id": turn}
    if inner == "user_message":
        payload["message"] = message
    elif inner == "task_complete":
        payload["last_agent_message"] = message
    else:
        payload["reason"] = message
    return json.dumps({"type": "event_msg", "payload": payload}) + "\n"


def _split_record(inner: str, *, turn: str, message: str) -> tuple[bytes, bytes]:
    raw = _record(inner, turn=turn, message=message).encode()
    cut = max(1, len(raw) // 2)
    if raw[cut - 1 : cut] == b"\n":
        cut -= 1
    return raw[:cut], raw[cut:]
