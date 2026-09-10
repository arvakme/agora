"""Shared contract for controlling native Agent CLI sessions.

Single source of truth for the identities, the correlation rule and the
delivery state machine that the local host (`daemon/`), the Agora backend
(`server/`) and the Pi Master extension depend on. Field lists live here only;
documentation states ordering, ownership and reasons. Non-Python consumers read
``python -m native_protocol`` instead of re-typing the fields.

Two facts about one request are kept apart on purpose:

* ``DeliveryRecord.withdrawn`` is a decision by the request authority. Once
  taken it is never undone by anything the host later learns.
* ``DeliveryRecord.turn_state`` is what the host has observed about the
  physical turn. The turn can still bind, finish, fail or be interrupted after
  a withdrawal, because cancelling a request does not stop a running model.

A physically finished turn therefore releases the session's input channel, and
its result is recorded as evidence, but ``publishable_result`` refuses to hand
a withdrawn request's result to Agora.

What this module does not own:

* Agora/Postgres owns rooms, membership, requests, published results and Master
  acceptance. ``master_accepted`` is not a state here.
* Authority to control a session comes from an authenticated Agora connection
  and the server-side binding of that connection to a Room member and a
  Computer. Nothing in this file is a credential or a proof: every identifier
  here is an address the host can also write down for itself.
* Each CLI owns its own conversation record. Correlation is expressed in the
  CLI's identifiers, never in text the host wrote.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
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
that types "done" and a successful ``tmux`` command are transports or
renderings, never evidence about a turn.
"""

ACCEPT_EVIDENCE: frozenset[str] = frozenset(
    {"native_hook", "native_queue_ack", "native_record"}
)
"""Evidence that can bind a request to a native turn: the CLI named the turn."""

OUTCOME_EVIDENCE: frozenset[str] = frozenset(
    {"native_hook", "native_notify", "native_record"}
)
"""Evidence that can end a turn, for success and failure alike.

``process_exit`` is excluded from both. A CLI that exits has not thereby
finished or failed the model's work, and one that keeps running has not
thereby succeeded.
"""

EventKind = Literal[
    "input_accepted",
    "execution_completed",
    "execution_failed",
    "permission_wait",
    "session_exit",
]
"""There is deliberately no "interrupt confirmed" kind.

Neither installed CLI reports anything when a turn is stopped: the stop key is
accepted, the turn ends, and no hook, notification or record follows. Adding a
kind no signal can produce would be a protocol shape pretending to be a
capability. See docs/native-control.md for what this leaves unresolved.
"""

TURN_SCOPED_EVENTS: frozenset[str] = frozenset(
    {"input_accepted", "execution_completed", "execution_failed"}
)
"""Kinds that must name a turn. The rest are session observations.

A session can be starting up, waiting or exiting before any turn exists, and
that has to be expressible without inventing a turn identifier.
"""

TurnState = Literal[
    "pending",
    "in_flight",
    "accepted",
    "completed",
    "failed",
    "uncertain",
]

SETTLED_TURN_STATES: frozenset[str] = frozenset({"completed", "failed"})
"""The physical turn is over. Nothing later moves it and the channel is free."""

Effect = Literal[
    "bound",
    "completed",
    "failed",
    "permission_wait",
    "uncertain",
    "deferred",
    "reacked",
    "late",
    "foreign",
    "unsupported_evidence",
    "ignored",
]
"""What the caller should do about an event, instead of counting it.

``deferred`` means the event is real but not yet attributable, so the sender
keeps it for catch-up; ``reacked`` means acknowledge again and publish nothing;
``late`` means recorded as evidence but not a valid result.
"""


class NativeTurn(BaseModel, frozen=True):
    """The CLI's own coordinates for one turn.

    ``session`` is the CLI-native session identifier (Claude Code
    ``session_id``, Codex ``thread_id``); ``turn`` is the CLI-native turn
    identifier (Claude Code ``prompt_id``, Codex ``turn_id``). Both come from
    official payloads; neither is minted by the host.
    """

    session: str = Field(min_length=1)
    turn: str = Field(min_length=1)


class NativeSession(BaseModel, frozen=True):
    """One controlled native CLI session and the Agora identity it maps to.

    ``participant_id`` and ``computer_id`` say which Room member and which
    paired Computer this session stands for. They are the mapping, not the
    authorisation: permission is decided by the authenticated connection the
    request arrived on, server side.
    """

    deployment: str = Field(min_length=1)
    participant_id: UUID
    computer_id: UUID
    adapter: AdapterKind
    tmux_target: str = Field(min_length=1)
    native_locator: str = Field(min_length=1)


class RequestOrigin(BaseModel, frozen=True):
    """Where the request sits in the room's order.

    ``request_seq`` is Agora's monotonic sequence, used to order requests and
    to catch up after a reconnect. It is not proof of anything on its own.
    """

    room_id: UUID
    request_seq: int
    requested_by: UUID


class Usage(BaseModel, frozen=True):
    """Native usage for one turn. Absent means unknown, never zero."""

    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)


class DeliveryRequest(BaseModel, frozen=True):
    """One task Agora asked the host to put into one session."""

    request_id: UUID
    origin: RequestOrigin
    session: NativeSession
    body: str = Field(min_length=1)
    side_effecting: bool = True


class NativeEvent(BaseModel, frozen=True):
    """One official observation about a controlled session.

    ``session`` is always the CLI-native session identifier. ``turn_id`` is
    present only for the kinds in ``TURN_SCOPED_EVENTS``; a startup wait or an
    exit before the first turn carries none.
    """

    event_id: UUID
    kind: EventKind
    evidence: EvidenceKind
    session: str = Field(min_length=1)
    turn_id: str | None = None
    summary: str = ""
    usage: Usage | None = None


class TurnResult(BaseModel, frozen=True):
    """What one bound turn produced."""

    request_id: UUID
    turn: NativeTurn
    outcome: Literal["completed", "failed"]
    summary: str
    usage: Usage | None


@dataclass(frozen=True)
class DeliveryRecord:
    """The host's transmission log entry for one request."""

    request: DeliveryRequest
    turn_state: TurnState = "pending"
    withdrawn: bool = False
    bound: NativeTurn | None = None
    applied_events: frozenset[UUID] = frozenset()
    deferred_events: tuple[NativeEvent, ...] = ()
    result: TurnResult | None = None
    awaiting_permission: bool = False
    note: str = ""


@dataclass(frozen=True)
class SessionGate:
    """What the host must tell this module before it may deliver.

    The host implements the guarantees; this module refuses to deliver when
    they do not hold. Read-only attach is the default entry and takes no input
    right. A takeover is exclusive and sets ``input_right='human'``; detaching
    does not hand it back and a lost control connection keeps ``paused`` set,
    both of which are the host's obligation, not a function call here.
    ``unmanaged_writers`` counts writable clients the deployment did not hand
    out; they pause delivery rather than being forced off.
    """

    input_right: Literal["host", "human", "none"] = "host"
    paused: bool = False
    unmanaged_writers: int = 0
    outstanding_requests: int = 0
    awaiting_permission: bool = False


@dataclass(frozen=True)
class Applied:
    """Result of folding one event: the new record and what to do about it."""

    record: DeliveryRecord
    effect: Effect


def binding_marker(request_id: UUID) -> str:
    """The token an adapter embeds so the CLI's own record names our turn.

    A correlation primitive, not evidence: it is matched once against the
    CLI's durable record of that one message item, which yields the native
    turn; everything afterwards is correlated by native identifiers. Needed
    only for CLIs that expose no turn identity at delivery time.
    """
    return f"agora-req-{request_id}"


def start(request: DeliveryRequest) -> DeliveryRecord:
    """Open a transmission log entry for a request Agora already accepted."""
    return DeliveryRecord(request=request)


def blocked_reason(record: DeliveryRecord, gate: SessionGate) -> str | None:
    """Why the host may not hand this request over yet, or None."""
    if record.withdrawn:
        return "the request was withdrawn"
    if record.turn_state != "pending":
        return f"the turn is {record.turn_state}"
    if gate.input_right != "host":
        return "input right held by a human takeover"
    if gate.paused:
        return "automatic delivery is paused"
    if gate.unmanaged_writers:
        return "an unmanaged writable client is attached"
    if gate.awaiting_permission or record.awaiting_permission:
        return "the session is waiting on a permission prompt"
    if gate.outstanding_requests:
        return "the session already has a request in flight"
    return None


def hand_off(record: DeliveryRecord) -> DeliveryRecord:
    """Open the injection window: delivered, no native acknowledgement yet."""
    if record.turn_state != "pending":
        return record
    return replace(record, turn_state="in_flight")


def withdraw(record: DeliveryRecord, why: str = "withdrawn by the request authority") -> DeliveryRecord:
    """Record the authority's decision to cancel. This never expires.

    It stops delivery and makes any result unpublishable. It does not claim the
    physical turn stopped: that stays whatever the CLI reports, so the input
    channel is released by a real terminal turn rather than by waiting forever
    for an interrupt acknowledgement that a naturally finished turn will never
    send.
    """
    if record.withdrawn:
        return record
    return replace(record, withdrawn=True, note=why)


def _fold_outcome(record: DeliveryRecord, event: NativeEvent, state: TurnState) -> Applied:
    seen = replace(record, applied_events=record.applied_events | {event.event_id})
    assert record.bound is not None
    result = TurnResult(
        request_id=record.request.request_id,
        turn=record.bound,
        outcome=state,
        summary=event.summary,
        usage=event.usage,
    )
    folded = replace(seen, turn_state=state, result=result, awaiting_permission=False)
    return Applied(folded, "late" if record.withdrawn else state)


def apply(record: DeliveryRecord, event: NativeEvent) -> Applied:
    """Fold one official observation into the record.

    Refuses anything it cannot attribute, and only marks an event applied once
    it really was: an outcome that arrives before the request is bound is kept
    in ``deferred_events`` and folded exactly once when the binding appears, so
    a lost acknowledgement can still be replayed with the same event id.
    """
    if event.session != record.request.session.native_locator:
        return Applied(record, "foreign")
    if event.kind in TURN_SCOPED_EVENTS and event.turn_id is None:
        return Applied(record, "foreign")
    if record.bound is not None and event.turn_id is not None and event.turn_id != record.bound.turn:
        return Applied(record, "foreign")
    if event.event_id in record.applied_events:
        return Applied(record, "reacked")

    settled = record.turn_state in SETTLED_TURN_STATES

    if event.kind == "input_accepted":
        if event.evidence not in ACCEPT_EVIDENCE:
            return Applied(record, "unsupported_evidence")
        if settled:
            return Applied(replace(record, applied_events=record.applied_events | {event.event_id}), "late")
        bound = NativeTurn(session=event.session, turn=event.turn_id)
        opened = replace(
            record,
            applied_events=record.applied_events | {event.event_id},
            bound=bound,
            turn_state="accepted",
            deferred_events=(),
        )
        for deferred in record.deferred_events:
            if deferred.turn_id == bound.turn:
                opened = apply(opened, deferred).record
        return Applied(opened, "bound")

    if event.kind in ("execution_completed", "execution_failed"):
        if event.evidence not in OUTCOME_EVIDENCE:
            return Applied(record, "unsupported_evidence")
        if record.bound is None:
            if any(d.event_id == event.event_id for d in record.deferred_events):
                return Applied(record, "deferred")
            return Applied(replace(record, deferred_events=record.deferred_events + (event,)), "deferred")
        if settled:
            return Applied(replace(record, applied_events=record.applied_events | {event.event_id}), "late")
        state: TurnState = "completed" if event.kind == "execution_completed" else "failed"
        return _fold_outcome(record, event, state)

    seen = replace(record, applied_events=record.applied_events | {event.event_id})
    if event.kind == "permission_wait":
        if settled:
            return Applied(seen, "late")
        return Applied(replace(seen, awaiting_permission=True, note=event.summary), "permission_wait")

    if record.turn_state in ("in_flight", "accepted"):
        return Applied(
            replace(seen, turn_state="uncertain", note="CLI exited before a native outcome"),
            "uncertain",
        )
    return Applied(seen, "ignored")


def mark_uncertain(record: DeliveryRecord, why: str) -> DeliveryRecord:
    """The host lost track of the physical turn. Decisions are untouched."""
    if record.turn_state in SETTLED_TURN_STATES:
        return record
    return replace(record, turn_state="uncertain", note=why)


def publishable_result(record: DeliveryRecord) -> TurnResult | None:
    """The result Agora may accept, or None.

    A withdrawn request has no valid result even when the physical turn ran to
    completion; the outcome stays in the record as evidence.
    """
    if record.withdrawn:
        return None
    return record.result


def channel_released(record: DeliveryRecord) -> bool:
    """Whether the session may take the next request.

    A settled turn releases it. So does a withdrawal that happened before
    anything was injected. Nothing else does: while a turn may still be
    running, the serial channel stays occupied.

    A stopped turn therefore does not release it, because neither installed
    CLI reports that a stop happened. That is a real gap, not a rule: the host
    cannot honestly free the channel on evidence it does not have.
    """
    if record.turn_state in SETTLED_TURN_STATES:
        return True
    return record.withdrawn and record.turn_state == "pending"


RecoveryAction = Literal["deliver", "reconcile_first", "await_native", "settled"]


def plan_recovery(record: DeliveryRecord) -> RecoveryAction:
    """What a restarted host may do, given only its own durable log.

    A withdrawn request is never delivered again, whatever the host does or
    does not know about the physical turn. A missing acknowledgement is never
    permission to run a side-effecting request again. Nothing here promises the
    model ran exactly once.
    """
    if record.withdrawn:
        return "settled" if channel_released(record) else "await_native"
    if record.turn_state in SETTLED_TURN_STATES:
        return "settled"
    if record.turn_state == "pending":
        return "deliver"
    if record.turn_state in ("in_flight", "uncertain"):
        return "reconcile_first" if record.request.side_effecting else "deliver"
    return "await_native"


def schema() -> dict:
    """Contract schema for non-Python consumers.

    Only what crosses the host/backend seam is exported. ``DeliveryRecord`` and
    ``SessionGate`` stay host-private: nobody should re-implement the state
    machine in another language.
    """
    return {
        "models": {
            name: model.model_json_schema()
            for name, model in (
                ("NativeTurn", NativeTurn),
                ("NativeSession", NativeSession),
                ("RequestOrigin", RequestOrigin),
                ("DeliveryRequest", DeliveryRequest),
                ("NativeEvent", NativeEvent),
                ("TurnResult", TurnResult),
                ("Usage", Usage),
            )
        },
        "event_kinds": list(EventKind.__args__),
        "turn_scoped_events": sorted(TURN_SCOPED_EVENTS),
        "evidence_kinds": list(EvidenceKind.__args__),
        "accept_evidence": sorted(ACCEPT_EVIDENCE),
        "outcome_evidence": sorted(OUTCOME_EVIDENCE),
        "host_private": ["DeliveryRecord", "SessionGate", "TurnState", "Effect"],
    }


if __name__ == "__main__":  # pragma: no cover - export entry point
    import json

    print(json.dumps(schema(), indent=2, ensure_ascii=False))
