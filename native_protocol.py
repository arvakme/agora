"""Shared contract for controlling native Agent CLI sessions.

Single source of truth for the identities, the correlation rule and the
delivery state machine that the local host (`daemon/`), the Agora backend
(`server/`) and the Pi Master extension depend on. Field lists live here only;
documentation states ordering, ownership and reasons. Non-Python consumers read
``python -m native_protocol`` instead of re-typing the fields.

What this module deliberately does not own:

* Agora/Postgres owns rooms, membership, requests, published results and Master
  acceptance. ``master_accepted`` is not a state here; a completed delivery is
  an input to that decision, not the decision.
* The host owns live sessions, the input right and the transmission log. The
  serial input channel, the takeover lock and the tmux plumbing are the host's
  to implement; this module only says what they must guarantee and takes their
  answer as input (see ``SessionGate``).
* Each CLI owns its own conversation record. Correlation is expressed in the
  CLI's own identifiers (``NativeTurn``), never in text the host wrote.
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
that types "done" and a successful ``tmux send-keys`` are transports or
renderings, never evidence about a turn.
"""

ACCEPT_EVIDENCE: frozenset[str] = frozenset(
    {"native_hook", "native_queue_ack", "native_record"}
)
"""Evidence that can bind a request to a native turn: the CLI named the turn."""

OUTCOME_EVIDENCE: frozenset[str] = frozenset(
    {"native_hook", "native_notify", "native_record"}
)
"""Evidence that can end a turn, for success and for failure alike.

``process_exit`` is excluded from both. A CLI that exits has not thereby
finished or failed the model's work, and one that keeps running has not
thereby succeeded.
"""

EventKind = Literal[
    "input_accepted",
    "execution_completed",
    "execution_failed",
    "interrupt_confirmed",
    "permission_wait",
    "session_exit",
]

DeliveryState = Literal[
    "pending",
    "in_flight",
    "accepted",
    "completed",
    "failed",
    "uncertain",
    "withdrawn",
    "interrupt_pending",
    "cancelled",
]

TERMINAL_STATES: frozenset[str] = frozenset(
    {"completed", "failed", "withdrawn", "cancelled"}
)
"""Once reached, nothing later moves the record. Late facts stay late."""

Effect = Literal[
    "bound",
    "completed",
    "failed",
    "interrupted",
    "permission_wait",
    "uncertain",
    "reacked",
    "late",
    "foreign",
    "unbound",
    "unsupported_evidence",
    "ignored",
]
"""What the caller should do about an event, instead of counting it.

``reacked`` means acknowledge again and post nothing; ``late``, ``foreign`` and
``unbound`` mean the event is not a fact about this request.
"""


class NativeTurn(BaseModel, frozen=True):
    """The CLI's own coordinates for one turn.

    ``session`` is the CLI-native session identifier (Claude Code
    ``session_id``, Codex ``thread_id``) and must equal the controlled
    session's ``native_locator``. ``turn`` is the CLI-native turn identifier
    (Claude Code ``prompt_id``, Codex ``turn_id``). Both come from official
    payloads; neither is minted by the host.
    """

    session: str = Field(min_length=1)
    turn: str = Field(min_length=1)


class NativeSession(BaseModel, frozen=True):
    """One controlled native CLI session, bound to an Agora identity.

    Authority to control the session comes from ``participant_id`` and
    ``computer_id`` as issued by Agora. ``tmux_target``, the working directory
    and ``native_locator`` are addresses, not credentials: matching them proves
    nothing.
    """

    deployment: str = Field(min_length=1)
    participant_id: UUID
    computer_id: UUID
    adapter: AdapterKind
    tmux_target: str = Field(min_length=1)
    native_locator: str = Field(min_length=1)


class RequestOrigin(BaseModel, frozen=True):
    """Proof that Agora persisted the request before anyone was notified.

    ``request_seq`` is Agora's monotonic sequence for the room, so it is also
    the cursor a reconnecting reader catches up from. The host cannot invent
    it, which is why there is no self-reported "persisted" flag.
    """

    room_id: UUID
    request_seq: int = Field(ge=1)
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
    """One official observation, carrying the CLI's own turn coordinates."""

    event_id: UUID
    kind: EventKind
    evidence: EvidenceKind
    turn: NativeTurn
    summary: str = ""
    usage: Usage | None = None


class TurnResult(BaseModel, frozen=True):
    """What the host may submit to Agora once a bound turn ended."""

    request_id: UUID
    turn: NativeTurn
    outcome: Literal["completed", "failed"]
    summary: str
    usage: Usage | None


@dataclass(frozen=True)
class DeliveryRecord:
    """The host's transmission log entry for one request.

    ``bound`` is the correlation: until the CLI has named the turn this request
    became, no outcome can be attributed to it.
    """

    request: DeliveryRequest
    state: DeliveryState = "pending"
    bound: NativeTurn | None = None
    applied_events: frozenset[UUID] = frozenset()
    result: TurnResult | None = None
    awaiting_permission: bool = False
    note: str = ""


@dataclass(frozen=True)
class SessionGate:
    """What the host must tell this module before it may deliver.

    The host implements the guarantees; this module only refuses to deliver
    when they do not hold. Read-only attach is the default entry and takes no
    input right. A takeover is exclusive and sets ``input_right='human'``;
    detaching does not hand it back and a lost control connection keeps
    ``paused`` set, both of which are the host's obligation, not a function
    call here. ``unmanaged_writers`` counts writable clients the deployment did
    not hand out; they pause delivery rather than being forced off.
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
    """The token the adapter embeds so the CLI's own record names our turn.

    It is a correlation primitive, not evidence: it is matched against the
    CLI's durable record of that one message item, which yields the native
    turn. Everything afterwards is correlated by native identifiers. It is
    needed only for CLIs that expose no turn identity at delivery time.
    """
    return f"agora-req-{request_id}"


def start(request: DeliveryRequest) -> DeliveryRecord:
    """Open a transmission log entry for an already-persisted request."""
    return DeliveryRecord(request=request)


def blocked_reason(record: DeliveryRecord, gate: SessionGate) -> str | None:
    """Why the host may not hand this request over yet, or None."""
    if record.state != "pending":
        return f"request is {record.state}"
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
    if record.state != "pending":
        return record
    return replace(record, state="in_flight")


def withdraw(record: DeliveryRecord) -> DeliveryRecord:
    """Agora cancelled the request. This stops delivery, not a running turn.

    Before hand-off nothing was injected, so the request is simply withdrawn.
    After hand-off the physical turn may still be running, so the record waits
    for a native interrupt confirmation and treats any result as late.
    """
    if record.state in TERMINAL_STATES:
        return record
    if record.state == "pending":
        return replace(record, state="withdrawn", note="withdrawn before delivery")
    return replace(
        record, state="interrupt_pending", note="cancelled; physical turn not confirmed stopped"
    )


def apply(record: DeliveryRecord, event: NativeEvent) -> Applied:
    """Fold one official observation into the record.

    Refuses anything it cannot attribute: an event from another native session,
    an event from a different turn than the one this request is bound to, an
    outcome for a request that was never bound, and evidence that cannot carry
    the claim. Replays are acknowledged, never re-folded.
    """
    if event.event_id in record.applied_events:
        return Applied(record, "reacked")
    if event.turn.session != record.request.session.native_locator:
        return Applied(record, "foreign")
    if record.bound is not None and event.turn != record.bound:
        return Applied(record, "foreign")

    seen = replace(record, applied_events=record.applied_events | {event.event_id})
    terminal = record.state in TERMINAL_STATES

    if event.kind == "input_accepted":
        if event.evidence not in ACCEPT_EVIDENCE:
            return Applied(record, "unsupported_evidence")
        if terminal or record.state == "interrupt_pending":
            return Applied(seen, "late")
        return Applied(replace(seen, bound=event.turn, state="accepted"), "bound")

    if event.kind in ("execution_completed", "execution_failed"):
        if event.evidence not in OUTCOME_EVIDENCE:
            return Applied(record, "unsupported_evidence")
        if record.bound is None:
            return Applied(seen, "unbound")
        outcome = "completed" if event.kind == "execution_completed" else "failed"
        if terminal:
            same = record.result is not None and record.result.outcome == outcome
            return Applied(seen, "reacked" if same else "late")
        if record.state == "interrupt_pending":
            return Applied(seen, "late")
        result = TurnResult(
            request_id=record.request.request_id,
            turn=event.turn,
            outcome=outcome,
            summary=event.summary,
            usage=event.usage,
        )
        return Applied(replace(seen, state=outcome, result=result, awaiting_permission=False), outcome)

    if event.kind == "interrupt_confirmed":
        if event.evidence not in OUTCOME_EVIDENCE:
            return Applied(record, "unsupported_evidence")
        if terminal:
            return Applied(seen, "late")
        return Applied(replace(seen, state="cancelled", note=event.summary), "interrupted")

    if event.kind == "permission_wait":
        if terminal:
            return Applied(seen, "late")
        return Applied(replace(seen, awaiting_permission=True, note=event.summary), "permission_wait")

    if record.state in ("in_flight", "accepted", "interrupt_pending"):
        return Applied(
            replace(seen, state="uncertain", note="CLI exited before a native outcome"),
            "uncertain",
        )
    return Applied(seen, "ignored")


def mark_uncertain(record: DeliveryRecord, why: str) -> DeliveryRecord:
    """The host lost track inside the injection window."""
    if record.state in TERMINAL_STATES:
        return record
    return replace(record, state="uncertain", note=why)


RecoveryAction = Literal["deliver", "reconcile_first", "await_native", "settled"]


def plan_recovery(record: DeliveryRecord) -> RecoveryAction:
    """What a restarted host may do, given only its own durable log.

    A missing acknowledgement is never permission to run a side-effecting
    request again; the CLI's own record is checked first. Nothing here promises
    the model ran exactly once.
    """
    if record.state in TERMINAL_STATES:
        return "settled"
    if record.state == "pending":
        return "deliver"
    if record.state in ("in_flight", "uncertain"):
        return "reconcile_first" if record.request.side_effecting else "deliver"
    return "await_native"


def schema() -> dict:
    """Contract schema for non-Python consumers.

    Only the identities and the event vocabulary crossing the host/backend
    seam are exported. ``DeliveryRecord`` and ``SessionGate`` are host-private
    on purpose: nobody should re-implement the state machine in another
    language.
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
        "evidence_kinds": list(EvidenceKind.__args__),
        "accept_evidence": sorted(ACCEPT_EVIDENCE),
        "outcome_evidence": sorted(OUTCOME_EVIDENCE),
        "host_private": ["DeliveryRecord", "SessionGate", "DeliveryState", "Effect"],
    }


if __name__ == "__main__":  # pragma: no cover - export entry point
    import json

    print(json.dumps(schema(), indent=2, ensure_ascii=False))
