"""Postgres transmission log for native deliveries.

Every mutation calls ``native_protocol`` and stores the returned record.
Concurrent writers take the row lock so a second apply of the same event
sees the first fold. Recovery plans are recomputed by ``plan_recovery``
after reload; the stored action is only an index.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any
from uuid import UUID

import asyncpg

import native_protocol as np
from native_protocol import Applied, DeliveryRecord, DeliveryRequest, NativeEvent, RecoveryAction


class NotFoundError(Exception):
    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def _dump(record: DeliveryRecord) -> str:
    return json.dumps(
        {
            "request": record.request.model_dump(mode="json"),
            "turn_state": record.turn_state,
            "withdrawn": record.withdrawn,
            "bound": None if record.bound is None else record.bound.model_dump(mode="json"),
            "applied_events": sorted(str(eid) for eid in record.applied_events),
            "deferred_events": [event.model_dump(mode="json") for event in record.deferred_events],
            "result": None if record.result is None else record.result.model_dump(mode="json"),
            "awaiting_permission": record.awaiting_permission,
            "note": record.note,
        }
    )


def _load(payload: Any) -> DeliveryRecord:
    if not isinstance(payload, dict):
        payload = json.loads(payload)
    return DeliveryRecord(
        request=np.DeliveryRequest.model_validate(payload["request"]),
        turn_state=payload["turn_state"],
        withdrawn=payload["withdrawn"],
        bound=None if payload["bound"] is None else np.NativeTurn.model_validate(payload["bound"]),
        applied_events=frozenset(UUID(eid) for eid in payload["applied_events"]),
        deferred_events=tuple(
            np.NativeEvent.model_validate(event) for event in payload["deferred_events"]
        ),
        result=None if payload["result"] is None else np.TurnResult.model_validate(payload["result"]),
        awaiting_permission=payload["awaiting_permission"],
        note=payload["note"],
    )


async def _lock(conn: asyncpg.Connection, request_id: UUID) -> DeliveryRecord:
    row = await conn.fetchrow(
        "SELECT record FROM delivery_records WHERE request_id = $1 FOR UPDATE",
        request_id,
    )
    if row is None:
        raise NotFoundError(f"delivery {request_id} not found")
    return _load(row["record"])


async def _write(conn: asyncpg.Connection, record: DeliveryRecord) -> None:
    await conn.execute(
        """
        UPDATE delivery_records
        SET turn_state = $2,
            withdrawn = $3,
            recovery_action = $4,
            record = $5,
            updated_at = now()
        WHERE request_id = $1
        """,
        record.request.request_id,
        record.turn_state,
        record.withdrawn,
        np.plan_recovery(record),
        _dump(record),
    )


async def _revise(
    pool: asyncpg.Pool,
    request_id: UUID,
    revise: Callable[[DeliveryRecord], DeliveryRecord],
) -> DeliveryRecord:
    async with pool.acquire() as conn:
        async with conn.transaction():
            record = revise(await _lock(conn, request_id))
            await _write(conn, record)
            return record


async def start(pool: asyncpg.Pool, request: DeliveryRequest) -> DeliveryRecord:
    record = np.start(request)
    async with pool.acquire() as conn:
        async with conn.transaction():
            inserted = await conn.fetchrow(
                """
                INSERT INTO delivery_records (
                    request_id, turn_state, withdrawn, recovery_action, record
                )
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (request_id) DO NOTHING
                RETURNING record
                """,
                request.request_id,
                record.turn_state,
                record.withdrawn,
                np.plan_recovery(record),
                _dump(record),
            )
            if inserted is not None:
                return _load(inserted["record"])
            existing = await conn.fetchrow(
                "SELECT record FROM delivery_records WHERE request_id = $1 FOR UPDATE",
                request.request_id,
            )
            assert existing is not None
            return _load(existing["record"])


async def hand_off(pool: asyncpg.Pool, request_id: UUID) -> DeliveryRecord:
    return await _revise(pool, request_id, np.hand_off)


async def withdraw(
    pool: asyncpg.Pool,
    request_id: UUID,
    why: str = "withdrawn by the request authority",
) -> DeliveryRecord:
    return await _revise(pool, request_id, lambda record: np.withdraw(record, why))


async def mark_uncertain(pool: asyncpg.Pool, request_id: UUID, why: str) -> DeliveryRecord:
    return await _revise(pool, request_id, lambda record: np.mark_uncertain(record, why))


async def apply(pool: asyncpg.Pool, request_id: UUID, event: NativeEvent) -> Applied:
    async with pool.acquire() as conn:
        async with conn.transaction():
            folded = np.apply(await _lock(conn, request_id), event)
            await _write(conn, folded.record)
            return folded


async def get(pool: asyncpg.Pool, request_id: UUID) -> DeliveryRecord:
    row = await pool.fetchrow(
        "SELECT record FROM delivery_records WHERE request_id = $1",
        request_id,
    )
    if row is None:
        raise NotFoundError(f"delivery {request_id} not found")
    return _load(row["record"])


async def unfinished(pool: asyncpg.Pool) -> list[tuple[DeliveryRecord, RecoveryAction]]:
    rows = await pool.fetch(
        """
        SELECT record FROM delivery_records
        WHERE recovery_action <> 'settled'
        ORDER BY created_at, request_id
        """
    )
    records = [_load(row["record"]) for row in rows]
    return [(record, np.plan_recovery(record)) for record in records]


async def truncate(pool: asyncpg.Pool) -> None:
    await pool.execute("TRUNCATE delivery_records")
