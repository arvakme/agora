"""Persistent delivery log: protocol decides, Postgres serializes and recovers."""

from __future__ import annotations

import asyncio
from urllib.parse import urlparse, urlunparse
from uuid import uuid4

import asyncpg
import pytest

import native_protocol as np
from server import db, delivery
from tests.conftest import DSN
from tests.test_native_protocol import event, make_request


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
async def pool(require_services: None) -> asyncpg.Pool:
    await _ensure_database(DELIVERY_DSN, DSN)
    created = await db.create_pool(DELIVERY_DSN)
    await db.migrate(created)
    await db.truncate_all(created)
    yield created
    await created.close()


async def _reopen() -> asyncpg.Pool:
    created = await db.create_pool(DELIVERY_DSN)
    await db.migrate(created)
    return created


def _full_record() -> np.DeliveryRecord:
    request = make_request()
    turn = np.NativeTurn(session="thread-x", turn="turn-1")
    return np.DeliveryRecord(
        request=request,
        turn_state="accepted",
        withdrawn=True,
        bound=turn,
        applied_events=frozenset({uuid4()}),
        deferred_events=(
            event(
                "execution_completed",
                "native_notify",
                summary="EARLY",
                usage=np.Usage(input_tokens=4, output_tokens=8),
            ),
        ),
        result=np.TurnResult(
            request_id=request.request_id,
            turn=turn,
            outcome="completed",
            summary="DONE",
            usage=np.Usage(input_tokens=12, output_tokens=3),
        ),
        awaiting_permission=True,
        note="waiting on the operator",
    )


def test_typed_record_roundtrip_keeps_every_field() -> None:
    original = _full_record()
    loaded = delivery._load(delivery._dump(original))
    assert loaded == original
    assert type(loaded.applied_events) is frozenset
    assert type(loaded.deferred_events) is tuple


@pytest.mark.asyncio
async def test_same_event_arriving_concurrently_takes_effect_once(pool: asyncpg.Pool) -> None:
    opened = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, opened.request.request_id)
    await delivery.apply(pool, opened.request.request_id, event("input_accepted", "native_hook"))

    eid = uuid4()
    done = event("execution_completed", "native_notify", event_id=eid, summary="ONCE")
    applied = await asyncio.gather(
        *[delivery.apply(pool, opened.request.request_id, done) for _ in range(16)]
    )

    effects = [item.effect for item in applied]
    assert effects.count("completed") == 1
    assert effects.count("reacked") == 15
    record = await delivery.get(pool, opened.request.request_id)
    assert record.turn_state == "completed"
    assert record.result is not None and record.result.summary == "ONCE"
    assert eid in record.applied_events


@pytest.mark.asyncio
async def test_outcome_before_binding_is_kept_and_folded_once(pool: asyncpg.Pool) -> None:
    opened = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, opened.request.request_id)
    eid = uuid4()
    early = event("execution_completed", "native_notify", event_id=eid, summary="EARLY")

    first = await delivery.apply(pool, opened.request.request_id, early)
    second = await delivery.apply(pool, opened.request.request_id, early)
    assert first.effect == "deferred"
    assert second.effect == "deferred"
    held = await delivery.get(pool, opened.request.request_id)
    assert eid not in held.applied_events
    assert [item.event_id for item in held.deferred_events] == [eid]

    bound = await delivery.apply(pool, opened.request.request_id, event("input_accepted", "native_hook"))
    assert bound.effect == "completed"
    assert bound.record.turn_state == "completed"
    assert bound.record.result is not None and bound.record.result.summary == "EARLY"
    assert not bound.record.deferred_events

    replay = await delivery.apply(pool, opened.request.request_id, early)
    assert replay.effect == "reacked"
    assert replay.record.result == bound.record.result


@pytest.mark.asyncio
async def test_withdrawn_completion_is_not_publishable_and_withdrawal_holds(pool: asyncpg.Pool) -> None:
    opened = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, opened.request.request_id)
    await delivery.apply(pool, opened.request.request_id, event("input_accepted", "native_hook"))
    cancelled = await delivery.withdraw(pool, opened.request.request_id, "master cancelled")
    assert cancelled.withdrawn

    late = await delivery.apply(
        pool,
        opened.request.request_id,
        event("execution_completed", "native_hook", summary="TOO LATE"),
    )
    assert late.effect == "late"
    assert late.record.withdrawn
    assert late.record.turn_state == "completed"
    assert late.record.result is not None
    assert np.publishable_result(late.record) is None

    again = await delivery.withdraw(pool, opened.request.request_id, "should not flip")
    assert again.withdrawn
    assert again.note == "master cancelled"
    assert np.publishable_result(again) is None


@pytest.mark.asyncio
async def test_foreign_session_or_turn_does_not_mutate_the_request(pool: asyncpg.Pool) -> None:
    opened = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, opened.request.request_id)
    other_session = await delivery.apply(
        pool,
        opened.request.request_id,
        event("execution_completed", "native_notify", session="other-thread"),
    )
    assert other_session.effect == "foreign"
    assert other_session.record.turn_state == "in_flight"
    assert not other_session.record.applied_events
    assert not other_session.record.deferred_events

    bound = await delivery.apply(pool, opened.request.request_id, event("input_accepted", "native_hook"))
    other_turn = await delivery.apply(
        pool,
        bound.record.request.request_id,
        event("execution_completed", "native_notify", turn_id="turn-9"),
    )
    assert other_turn.effect == "foreign"
    stored = await delivery.get(pool, opened.request.request_id)
    assert stored.turn_state == "accepted"
    assert stored.bound is not None and stored.bound.turn == "turn-1"
    assert stored.result is None


@pytest.mark.asyncio
async def test_restart_reloads_unfinished_deliveries_with_protocol_plans(pool: asyncpg.Pool) -> None:
    pending = await delivery.start(pool, make_request())
    in_flight = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, in_flight.request.request_id)
    harmless = await delivery.start(pool, make_request(side_effecting=False))
    await delivery.hand_off(pool, harmless.request.request_id)
    accepted = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, accepted.request.request_id)
    await delivery.apply(pool, accepted.request.request_id, event("input_accepted", "native_hook"))
    uncertain = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, uncertain.request.request_id)
    await delivery.mark_uncertain(pool, uncertain.request.request_id, "host restart")
    withdrawn_pending = await delivery.start(pool, make_request())
    await delivery.withdraw(pool, withdrawn_pending.request.request_id)
    withdrawn_bound = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, withdrawn_bound.request.request_id)
    await delivery.apply(pool, withdrawn_bound.request.request_id, event("input_accepted", "native_hook"))
    await delivery.withdraw(pool, withdrawn_bound.request.request_id)
    finished = await delivery.start(pool, make_request())
    await delivery.hand_off(pool, finished.request.request_id)
    await delivery.apply(pool, finished.request.request_id, event("input_accepted", "native_hook"))
    await delivery.apply(
        pool,
        finished.request.request_id,
        event("execution_completed", "native_record", summary="DONE"),
    )

    await pool.close()
    restarted = await _reopen()
    try:
        loaded = await delivery.get(restarted, finished.request.request_id)
        assert loaded.turn_state == "completed"
        assert np.publishable_result(loaded) is not None
        assert np.publishable_result(loaded).summary == "DONE"
        assert np.plan_recovery(loaded) == "settled"

        cancelled = await delivery.get(restarted, withdrawn_pending.request.request_id)
        assert cancelled.withdrawn
        assert np.plan_recovery(cancelled) == "settled"
        assert np.publishable_result(cancelled) is None

        open_rows = await delivery.unfinished(restarted)
        plans = {record.request.request_id: action for record, action in open_rows}
        assert plans[pending.request.request_id] == "deliver"
        assert plans[in_flight.request.request_id] == "reconcile_first"
        assert plans[harmless.request.request_id] == "deliver"
        assert plans[accepted.request.request_id] == "await_native"
        assert plans[uncertain.request.request_id] == "reconcile_first"
        assert plans[withdrawn_bound.request.request_id] == "await_native"
        assert withdrawn_pending.request.request_id not in plans
        assert finished.request.request_id not in plans
        assert set(plans) == {
            pending.request.request_id,
            in_flight.request.request_id,
            harmless.request.request_id,
            accepted.request.request_id,
            uncertain.request.request_id,
            withdrawn_bound.request.request_id,
        }
        for record, action in open_rows:
            assert action == np.plan_recovery(record)
    finally:
        await restarted.close()
