"""A dispatch on disk: the one place its record format is defined.

``.agora/dispatch/<request_id>.json`` is the single source of truth for one "session A gave a task to
session B": the ``native_protocol.DeliveryRecord`` (what was handed over, what the target's own log then
showed), the task, scope, source and target sessions, the permission mode, the receipt B handed back and
the states the dispatch went through. The task text and the receipt text live next to it, in
``<request_id>/task.md`` and ``<request_id>/reply.md``. What actually happened stays in each CLI's own
log; nothing of that is copied here except what the state machine folded (turn id, outcome, summary).

The state a page or the run tree shows is ``derive_state``: a pure function of the record, so there is
no second state machine. ``sample.json`` (next to this file's tests) is a full example; the format is
round-tripped by ``tests/test_dispatch_store.py``.

Written atomically (temp file + rename, ``ProjectStore._atomic``); ``dispatch/`` is in the generated
``.gitignore`` next to ``sessions/`` and ``run/``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

from native_protocol import (
    DeliveryRecord,
    DeliveryRequest,
    NativeEvent,
    NativeTurn,
    TurnResult,
    channel_released,
)
from server.canvas.project import ProjectStore

FORMAT = 1
ID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")  # matched with fullmatch: `$` would let a trailing newline through
REPLY_STATUSES = ("done", "failed", "blocked")
# States after which nothing more is expected of the dispatch (a late receipt can still move idle_no_reply).
FINAL = frozenset({"done", "failed", "blocked", "idle_no_reply", "interrupted"})


@dataclass
class Dispatch:
    id: str
    delivery: DeliveryRecord
    task: dict[str, Any]  # {"summary", "scope": [...], "file": "task.md", "inline": bool}
    source: dict[str, Any]  # {"kind": "session", "sessionId"} | {"kind": "comment", "canvasId", "threadId", "threadN"} | {"kind": "user"}
    target: dict[str, Any]  # {"sessionId", "agent", "new": bool}
    permission: dict[str, Any]  # {"mode", "detail"}: what this run of the target is allowed, as it is configured
    expects_reply: bool = True  # False for a comment: the turn's own answer is the reply
    reply: dict[str, Any] | None = None  # {"status", "at", "summary", "file"}
    stopped: dict[str, Any] | None = None  # {"at", "how"}: the target's headless run was cancelled
    error: str | None = None  # it could not be delivered at all
    created_at: int = 0
    updated_at: int = 0
    notified: str | None = None  # the state the source was last told
    history: list[dict[str, Any]] = field(default_factory=list)  # [{"at", "state"}], oldest first


# ——— the state the record stands for ———
def derive_state(d: Dispatch) -> str:
    """One word from ``adapters/runs.py STATES``: what the dispatch is now, from the record alone."""
    r = d.delivery
    if d.error:
        return "failed"
    if d.stopped:
        return "interrupted"
    if r.withdrawn:
        return "interrupted" if channel_released(r) else "unknown"
    if r.awaiting_permission and r.turn_state in ("in_flight", "accepted"):
        return "waiting"
    ts = r.turn_state
    if ts in ("pending", "in_flight"):
        return "dispatched"
    if ts == "uncertain":
        return "unknown"
    if ts == "accepted":
        return "running"
    if ts == "failed":
        return "failed"
    # completed: the turn ended
    if d.reply:
        return d.reply["status"]
    return "idle_no_reply" if d.expects_reply else "done"


def is_final(state: str) -> bool:
    return state in FINAL


# ——— the format ———
def _delivery_json(r: DeliveryRecord) -> dict[str, Any]:
    return {
        "request": r.request.model_dump(mode="json"),
        "turn_state": r.turn_state,
        "withdrawn": r.withdrawn,
        "bound": r.bound.model_dump(mode="json") if r.bound else None,
        "applied_events": sorted(str(e) for e in r.applied_events),
        "deferred_events": [e.model_dump(mode="json") for e in r.deferred_events],
        "result": r.result.model_dump(mode="json") if r.result else None,
        "awaiting_permission": r.awaiting_permission,
        "note": r.note,
    }


def _delivery_from(o: dict[str, Any]) -> DeliveryRecord:
    return DeliveryRecord(
        request=DeliveryRequest.model_validate(o["request"]),
        turn_state=o["turn_state"],
        withdrawn=bool(o["withdrawn"]),
        bound=NativeTurn.model_validate(o["bound"]) if o.get("bound") else None,
        applied_events=frozenset(UUID(e) for e in o.get("applied_events") or []),
        deferred_events=tuple(NativeEvent.model_validate(e) for e in o.get("deferred_events") or []),
        result=TurnResult.model_validate(o["result"]) if o.get("result") else None,
        awaiting_permission=bool(o.get("awaiting_permission")),
        note=o.get("note") or "",
    )


def to_json(d: Dispatch) -> dict[str, Any]:
    return {
        "format": FORMAT,
        "id": d.id,
        "state": derive_state(d),  # for people reading the file; the record above it is the truth
        "delivery": _delivery_json(d.delivery),
        "task": d.task,
        "source": d.source,
        "target": d.target,
        "permission": d.permission,
        "expects_reply": d.expects_reply,
        "reply": d.reply,
        "stopped": d.stopped,
        "error": d.error,
        "created_at": d.created_at,
        "updated_at": d.updated_at,
        "notified": d.notified,
        "history": d.history,
    }


def from_json(o: dict[str, Any]) -> Dispatch:
    if o.get("format") != FORMAT:
        raise ValueError(f"dispatch record format {o.get('format')!r} is not {FORMAT}")
    return Dispatch(
        id=o["id"],
        delivery=_delivery_from(o["delivery"]),
        task=o["task"],
        source=o["source"],
        target=o["target"],
        permission=o["permission"],
        expects_reply=bool(o.get("expects_reply", True)),
        reply=o.get("reply"),
        stopped=o.get("stopped"),
        error=o.get("error"),
        created_at=int(o.get("created_at") or 0),
        updated_at=int(o.get("updated_at") or 0),
        notified=o.get("notified"),
        history=list(o.get("history") or []),
    )


class DispatchStore:
    """``<project>/.agora/dispatch/``: records and their texts."""

    def __init__(self, project_dir: Path) -> None:
        self.dir = project_dir / "dispatch"

    def _json(self, id: str) -> Path:
        if not ID_RE.fullmatch(id):
            raise ValueError(f"not a request id: {id!r}")
        return self.dir / f"{id}.json"

    def folder(self, id: str) -> Path:
        self._json(id)
        return self.dir / id

    def write(self, d: Dispatch) -> None:
        ProjectStore._atomic(self._json(d.id), (json.dumps(to_json(d), ensure_ascii=False, indent=2) + "\n").encode())

    def read(self, id: str) -> Dispatch | None:
        try:
            return from_json(json.loads(self._json(id).read_text()))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):  # unreadable or damaged: not this record (and not the whole listing)
            return None

    def all(self) -> list[Dispatch]:
        out = []
        for p in sorted(self.dir.glob("*.json")) if self.dir.is_dir() else []:
            d = self.read(p.stem) if ID_RE.fullmatch(p.stem) else None
            if d is not None:
                out.append(d)
        return sorted(out, key=lambda d: d.created_at)

    def write_text(self, id: str, name: str, text: str) -> Path:
        p = self.folder(id) / name
        ProjectStore._atomic(p, text.encode())
        return p

    def read_text(self, id: str, name: str) -> str | None:
        try:
            return (self.folder(id) / name).read_text()
        except OSError:
            return None
