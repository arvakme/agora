"""Ask one question through a native Codex session and persist the delivery."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import asyncpg
import native_protocol as np
from native_protocol import SETTLED_TURN_STATES, publishable_result

from agora_ask.config import AskSettings
from host import DeliveryBlocked, Host, SessionGone, pane_pid, wait_rollout
from server import db, delivery


class AskError(Exception):
    """The ask flow failed before a publishable native result existed."""


async def ask_once(
    question: str,
    settings: AskSettings,
    *,
    host: Host | None = None,
    pool: asyncpg.Pool | None = None,
) -> str:
    owns_pool = pool is None
    if pool is None:
        pool = await db.create_pool(settings.effective_database_url())
        await db.migrate(pool)
    try:
        if host is None:
            settings.host_root.mkdir(parents=True, exist_ok=True)
            with Host(settings.host_root, deployment=settings.deployment) as owned:
                return await _ask(question, settings, pool, owned)
        return await _ask(question, settings, pool, host)
    finally:
        if owns_pool:
            await pool.close()


async def _ask(
    question: str,
    settings: AskSettings,
    pool: asyncpg.Pool,
    host: Host,
) -> str:
    name = settings.session_name
    command = settings.codex_argv()
    cwd = settings.cwd
    log, locator = _initial_native_target(settings, host, name)
    if host.native_target(name) is not None and name not in host.tmux_session_names():
        raise AskError(f"session gone: session {name} is gone")
    host.ensure_session(name, command, cwd=cwd, native_log=log, native_locator=locator)
    _discover_native_log(host, settings, name, command, cwd, log, locator)

    request = host.build_request(name, question)
    await delivery.start(pool, request)
    sub = await host.subscribe(name)
    try:
        try:
            host.deliver(name, question, request=request)
        except DeliveryBlocked as exc:
            raise AskError(f"delivery blocked: {exc}") from exc
        except SessionGone as exc:
            raise AskError(f"session gone: {exc}") from exc
        await delivery.hand_off(pool, request.request_id)
        record = await _wait_for_terminal(pool, sub, request.request_id, settings.timeout_s)
    finally:
        await sub.aclose()

    result = publishable_result(record)
    if result is None:
        if record.turn_state == "failed":
            raise AskError(record.result.summary if record.result else "native execution failed")
        raise AskError(record.note or f"turn ended in state {record.turn_state}")
    return result.summary


async def _wait_for_terminal(
    pool: asyncpg.Pool,
    sub,
    request_id,
    timeout_s: float,
) -> np.DeliveryRecord:
    record = await delivery.get(pool, request_id)
    try:
        async with asyncio.timeout(timeout_s):
            async for event in sub:
                folded = await delivery.apply(pool, request_id, event)
                record = folded.record
                if record.awaiting_permission:
                    raise AskError(record.note or "session is waiting on a permission prompt")
                if record.turn_state in SETTLED_TURN_STATES:
                    return record
    except TimeoutError as exc:
        raise AskError(f"timed out after {timeout_s}s waiting for native completion") from exc
    raise AskError("native subscription ended before the turn settled")


def _initial_native_target(
    settings: AskSettings, host: Host, name: str
) -> tuple[Path, str]:
    if settings.native_log is not None:
        locator = settings.native_locator or name
        return settings.native_log, locator
    saved = host.native_target(name)
    if saved is not None and saved[1] != "pending":
        return saved
    pending = Path.home() / ".codex" / "sessions" / ".agora-pending" / "rollout-pending.jsonl"
    return pending, "pending"


def _discover_native_log(
    host: Host,
    settings: AskSettings,
    name: str,
    command: list[str],
    cwd: Path,
    log: Path,
    locator: str,
) -> None:
    if settings.native_log is not None or locator != "pending":
        return
    pid = pane_pid(host._bin, host.socket_path, name)
    discovered_log, discovered_locator = wait_rollout(pid, timeout=settings.discovery_timeout_s)
    host.ensure_session(
        name,
        command,
        cwd=cwd,
        native_log=discovered_log,
        native_locator=discovered_locator,
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in {"-h", "--help"}:
        print("usage: python -m agora_ask <question>", file=sys.stderr)
        return 2 if args else 0
    question = " ".join(args).strip()
    if not question:
        print("question is required", file=sys.stderr)
        return 2
    settings = AskSettings()
    try:
        answer = asyncio.run(ask_once(question, settings))
    except AskError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(answer)
    return 0
