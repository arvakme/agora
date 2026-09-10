"""Shared contract for controlling native Agent CLI sessions.

This module is the single source of truth for the identities, the delivery
state machine and the input-right rules that the local host (`daemon/`), the
Agora backend (`server/`) and the Pi Master extension all depend on. Field
lists live here only; documentation states ordering, ownership and reasons.
Non-Python consumers read the exported schema (``python -m native_protocol``)
instead of re-typing the fields.

Ownership this contract assumes, and does not restate elsewhere:

* Agora/Postgres owns rooms, membership, collaboration requests, published
  results and Master acceptance. ``master_accepted`` is therefore not a state
  in this module; a completed delivery is an input to that decision, not it.
* The host owns only live sessions, the current input right and the log of
  transmissions it has not yet seen confirmed. It is a transmission log, not a
  second, editable task pool.
* Each CLI owns its own conversation record. ``NativeSession.native_locator``
  points at it; the host never copies it.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

AdapterKind = Literal["pi", "claude_code", "codex"]

EvidenceKind = Literal[
    "native_hook",
    "native_queue_ack",
    "native_notify",
    "native_record",
    "process_exit",
    "operator",
]
"""How a fact about a native session became known.

Terminal bytes are deliberately absent. A quiet pane, an ANSI redraw, a model
that types "done", and a successful ``tmux send-keys`` are transports or
renderings, never evidence that input was accepted or a turn finished.
"""

ACCEPT_EVIDENCE: frozenset[str] = frozenset(
    {"native_hook", "native_queue_ack", "native_record"}
)
"""Evidence that can establish ``input_accepted``: the CLI itself said so."""

COMPLETION_EVIDENCE: frozenset[str] = frozenset(
    {"native_hook", "native_notify", "native_record"}
)
"""Evidence that can establish ``execution_completed``.

``process_exit`` is excluded on purpose: a CLI that exits has not thereby
finished the model's work, and a CLI that keeps running has not thereby failed.
"""

EventKind = Literal[
    "input_accepted",
    "execution_completed",
    "execution_failed",
    "permission_wait",
    "cancel_acked",
    "session_exit",
]

DeliveryState = Literal[
    "pending",
    "in_flight",
    "accepted",
    "completed",
    "failed",
    "cancelled",
    "uncertain",
]

InputHolder = Literal["host", "human", "none"]


class NativeSession(BaseModel, frozen=True):
    """One controlled native CLI session inside one deployment.

    None of these fields is a credential. Authority to control a session comes
    from the Agora-issued host identity; a matching tmux target, pane id or
    working directory proves nothing.
    """

    deployment: str = Field(min_length=1)
    session_key: str = Field(min_length=1)
    adapter: AdapterKind
    tmux_target: str = Field(min_length=1)
    native_locator: str = Field(min_length=1)


class DeliveryRequest(BaseModel, frozen=True):
    """A task the host has been asked to put into one session.

    A request exists in Agora before the host may attempt delivery, and the
    notification that follows only says "there is an update"; readers catch up
    by cursor. ``request_id`` is the idempotency key end to end.
    """

    request_id: UUID
    session: NativeSession
    body: str = Field(min_length=1)
    side_effecting: bool = True
    persisted: bool = False


class NativeEvent(BaseModel, frozen=True):
    """One observation about a session, carrying its own stable identity."""

    event_id: UUID
    kind: EventKind
    evidence: EvidenceKind
    session_key: str = Field(min_length=1)
    request_id: UUID | None = None
    result_id: UUID | None = None
    detail: str = ""


@dataclass(frozen=True)
class DeliveryRecord:
    """Host-side transmission log entry for one request.

    ``state`` never reaches ``completed`` from ``cancelled``: a result that
    arrives after a cancellation is recorded in ``late_results`` and stays
    invalid, because cancelling a request does not stop a physical turn.
    """

    request: DeliveryRequest
    state: DeliveryState = "pending"
    applied_events: frozenset[UUID] = frozenset()
    results: frozenset[UUID] = frozenset()
    late_results: int = 0
    duplicate_acks: int = 0
    rejected_evidence: int = 0
    awaiting_permission: bool = False
    note: str = ""


@dataclass(frozen=True)
class InputRight:
    """Who may put bytes into a session right now.

    Read-only attach is the default entry and never takes this right. A human
    takeover is exclusive and pauses automatic delivery; detaching does not
    return it, and losing the control connection keeps it paused. Any writable
    client the deployment did not hand out also pauses delivery rather than
    being forced off.
    """

    holder: InputHolder = "host"
    paused: bool = False
    unmanaged_writers: int = 0


def start(request: DeliveryRequest) -> DeliveryRecord:
    """Open a transmission log entry. Persist the request first, then notify."""
    if not request.persisted:
        raise ValueError("request must be persisted in Agora before delivery")
    return DeliveryRecord(request=request)


def may_deliver(record: DeliveryRecord, right: InputRight) -> bool:
    """Whether the host may hand this request to the adapter right now."""
    return (
        record.state == "pending"
        and right.holder == "host"
        and not right.paused
        and right.unmanaged_writers == 0
    )


def hand_off(record: DeliveryRecord) -> DeliveryRecord:
    """Mark the injection window open: delivered, no native acknowledgement yet.

    A crash between here and ``input_accepted`` is exactly the window that
    ``mark_uncertain`` describes.
    """
    if record.state != "pending":
        return record
    return replace(record, state="in_flight")


def apply(record: DeliveryRecord, event: NativeEvent) -> DeliveryRecord:
    """Fold one native observation into the record.

    Idempotent by ``event_id`` and by ``result_id``: a repeat only counts as an
    acknowledgement, so re-sending a result never posts twice or wakes anyone
    again. Events whose evidence cannot carry their claim are counted and
    otherwise ignored.
    """
    if event.event_id in record.applied_events:
        return replace(record, duplicate_acks=record.duplicate_acks + 1)
    seen = replace(record, applied_events=record.applied_events | {event.event_id})

    if event.kind == "permission_wait":
        return replace(seen, awaiting_permission=True, note=event.detail)

    if event.kind == "cancel_acked":
        return replace(seen, state="cancelled", note=event.detail)

    if event.kind == "input_accepted":
        if event.evidence not in ACCEPT_EVIDENCE:
            return replace(seen, rejected_evidence=seen.rejected_evidence + 1)
        if seen.state in ("in_flight", "pending", "uncertain"):
            return replace(seen, state="accepted", awaiting_permission=False)
        return seen

    if event.kind in ("execution_completed", "execution_failed"):
        if event.kind == "execution_completed" and event.evidence not in COMPLETION_EVIDENCE:
            return replace(seen, rejected_evidence=seen.rejected_evidence + 1)
        if seen.state == "cancelled":
            return replace(seen, late_results=seen.late_results + 1)
        if event.result_id is not None and event.result_id in seen.results:
            return replace(seen, duplicate_acks=seen.duplicate_acks + 1)
        results = seen.results | ({event.result_id} if event.result_id else frozenset())
        state = "completed" if event.kind == "execution_completed" else "failed"
        return replace(seen, state=state, results=results, awaiting_permission=False)

    if event.kind == "session_exit":
        if seen.state in ("in_flight", "accepted"):
            return replace(
                seen, state="uncertain", note="CLI exited before a native result"
            )
        return seen

    return seen


def mark_uncertain(record: DeliveryRecord, why: str) -> DeliveryRecord:
    """Record that the host lost track inside the injection window."""
    if record.state in ("completed", "failed", "cancelled"):
        return record
    return replace(record, state="uncertain", note=why)


RecoveryAction = Literal["deliver", "await_native", "reconcile_first", "settled"]


def plan_recovery(record: DeliveryRecord) -> RecoveryAction:
    """What the host may do after a restart, given only its own log.

    A missing acknowledgement is not permission to run a side-effecting request
    again; the native session is checked first. Nothing here promises the model
    ran exactly once.
    """
    if record.state in ("completed", "failed", "cancelled"):
        return "settled"
    if record.state == "pending":
        return "deliver"
    if record.state == "uncertain":
        return "await_native" if record.request.side_effecting else "deliver"
    return "reconcile_first" if record.state == "in_flight" else "await_native"


def on_detach(right: InputRight) -> InputRight:
    """Detaching is not a hand-back and not a cancellation."""
    return right


def on_control_loss(right: InputRight) -> InputRight:
    """An interrupted control connection stays paused until someone claims it."""
    return replace(right, paused=True)


def observe_writers(right: InputRight, unmanaged_writers: int) -> InputRight:
    """Unmanaged writable clients pause automatic delivery; nobody is kicked."""
    return replace(right, unmanaged_writers=unmanaged_writers)


def schema() -> dict:
    """Contract schema for non-Python consumers to import rather than copy."""
    return {
        "models": {
            name: model.model_json_schema()
            for name, model in (
                ("NativeSession", NativeSession),
                ("DeliveryRequest", DeliveryRequest),
                ("NativeEvent", NativeEvent),
            )
        },
        "delivery_states": list(DeliveryState.__args__),
        "event_kinds": list(EventKind.__args__),
        "evidence_kinds": list(EvidenceKind.__args__),
        "accept_evidence": sorted(ACCEPT_EVIDENCE),
        "completion_evidence": sorted(COMPLETION_EVIDENCE),
    }


if __name__ == "__main__":  # pragma: no cover - export entry point
    import json

    print(json.dumps(schema(), indent=2, ensure_ascii=False))
