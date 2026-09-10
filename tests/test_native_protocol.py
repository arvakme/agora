"""Ordering and correlation rules of the native-control contract.

These are the invariants #19 and #20 build on: an event can only affect the
request whose native turn it names, terminal states do not move, and evidence
must be able to carry its claim.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

import native_protocol as np

LOCATOR = "thread-x"


def make_session(locator: str = LOCATOR) -> np.NativeSession:
    return np.NativeSession(
        deployment="test",
        participant_id=uuid4(),
        computer_id=uuid4(),
        adapter="codex",
        tmux_target="sock:w.0",
        native_locator=locator,
    )


def make_request(*, side_effecting: bool = True, locator: str = LOCATOR) -> np.DeliveryRequest:
    return np.DeliveryRequest(
        request_id=uuid4(),
        origin=np.RequestOrigin(room_id=uuid4(), request_seq=7, requested_by=uuid4()),
        session=make_session(locator),
        body="do the thing",
        side_effecting=side_effecting,
    )


def turn(turn_id: str = "turn-1", session: str = LOCATOR) -> np.NativeTurn:
    return np.NativeTurn(session=session, turn=turn_id)


def event(kind: np.EventKind, evidence: np.EvidenceKind, **kw) -> np.NativeEvent:
    return np.NativeEvent(
        event_id=kw.pop("event_id", uuid4()),
        kind=kind,
        evidence=evidence,
        turn=kw.pop("turn", turn()),
        **kw,
    )


def bound_record(**kw) -> np.DeliveryRecord:
    record = np.hand_off(np.start(make_request(**kw)))
    applied = np.apply(record, event("input_accepted", "native_hook"))
    assert applied.effect == "bound"
    return applied.record


def test_a_request_needs_agoras_sequence_not_a_self_reported_flag() -> None:
    with pytest.raises(ValueError):
        np.RequestOrigin(room_id=uuid4(), request_seq=0, requested_by=uuid4())


def test_transport_success_alone_is_not_acceptance() -> None:
    record = np.hand_off(np.start(make_request()))
    assert record.state == "in_flight"
    assert record.bound is None


def test_an_event_from_another_native_session_is_foreign() -> None:
    record = np.hand_off(np.start(make_request()))
    applied = np.apply(record, event("execution_completed", "native_notify", turn=turn(session="other-thread")))
    assert applied.effect == "foreign"
    assert applied.record.state == "in_flight"


def test_an_internal_turn_on_the_same_session_cannot_finish_our_request() -> None:
    record = bound_record()
    applied = np.apply(record, event("execution_completed", "native_notify", turn=turn("turn-2")))
    assert applied.effect == "foreign"
    assert applied.record.state == "accepted"


def test_an_outcome_for_an_unbound_request_is_not_attributed() -> None:
    record = np.hand_off(np.start(make_request()))
    applied = np.apply(record, event("execution_completed", "native_notify"))
    assert applied.effect == "unbound"
    assert applied.record.state == "in_flight"


def test_process_exit_can_neither_complete_nor_fail_a_turn() -> None:
    record = bound_record()
    for kind in ("execution_completed", "execution_failed"):
        applied = np.apply(record, event(kind, "process_exit"))
        assert applied.effect == "unsupported_evidence"
        assert applied.record.state == "accepted"


def test_an_exit_during_a_turn_is_uncertain_not_an_outcome() -> None:
    applied = np.apply(bound_record(), event("session_exit", "process_exit"))
    assert applied.effect == "uncertain"
    assert applied.record.state == "uncertain"


def test_a_late_cancel_cannot_erase_a_completed_turn() -> None:
    done = np.apply(bound_record(), event("execution_completed", "native_hook", summary="ok")).record
    assert done.state == "completed"
    applied = np.apply(done, event("interrupt_confirmed", "native_hook"))
    assert applied.effect == "late"
    assert applied.record.state == "completed"


def test_a_late_failure_cannot_flip_a_completed_turn() -> None:
    done = np.apply(bound_record(), event("execution_completed", "native_hook")).record
    applied = np.apply(done, event("execution_failed", "native_hook"))
    assert applied.effect == "late"
    assert applied.record.state == "completed"


def test_a_repeated_outcome_only_asks_for_another_ack() -> None:
    done = np.apply(bound_record(), event("execution_completed", "native_notify")).record
    again = np.apply(done, event("execution_completed", "native_notify"))
    assert again.effect == "reacked"
    assert again.record.result == done.result


def test_a_replayed_event_is_folded_once() -> None:
    eid = uuid4()
    record = np.hand_off(np.start(make_request()))
    first = np.apply(record, event("input_accepted", "native_hook", event_id=eid))
    second = np.apply(first.record, event("input_accepted", "native_hook", event_id=eid))
    assert second.effect == "reacked"
    assert second.record.applied_events == first.record.applied_events


def test_cancelling_after_delivery_waits_for_a_native_interrupt() -> None:
    record = np.withdraw(bound_record())
    assert record.state == "interrupt_pending"
    late = np.apply(record, event("execution_completed", "native_hook"))
    assert late.effect == "late"
    assert late.record.state == "interrupt_pending"
    stopped = np.apply(late.record, event("interrupt_confirmed", "native_hook"))
    assert stopped.record.state == "cancelled"


def test_cancelling_before_delivery_injects_nothing() -> None:
    record = np.withdraw(np.start(make_request()))
    assert record.state == "withdrawn"
    assert np.plan_recovery(record) == "settled"


def test_a_permission_prompt_stops_automatic_delivery() -> None:
    record = np.apply(np.start(make_request()), event("permission_wait", "native_hook")).record
    assert record.awaiting_permission
    assert np.blocked_reason(record, np.SessionGate()) is not None
    assert np.blocked_reason(np.start(make_request()), np.SessionGate(awaiting_permission=True))


def test_takeover_unmanaged_writers_and_a_busy_channel_all_block_delivery() -> None:
    record = np.start(make_request())
    assert np.blocked_reason(record, np.SessionGate()) is None
    assert np.blocked_reason(record, np.SessionGate(input_right="human"))
    assert np.blocked_reason(record, np.SessionGate(paused=True))
    assert np.blocked_reason(record, np.SessionGate(unmanaged_writers=1))
    assert np.blocked_reason(record, np.SessionGate(outstanding_requests=1))


def test_uncertainty_reconciles_before_a_side_effecting_request_runs_again() -> None:
    risky = np.mark_uncertain(np.hand_off(np.start(make_request())), "crash")
    assert np.plan_recovery(risky) == "reconcile_first"
    harmless = np.mark_uncertain(np.hand_off(np.start(make_request(side_effecting=False))), "crash")
    assert np.plan_recovery(harmless) == "deliver"


def test_native_records_resolve_an_uncertain_delivery_without_redelivering() -> None:
    record = np.mark_uncertain(np.hand_off(np.start(make_request())), "crash")
    record = np.apply(record, event("input_accepted", "native_record")).record
    applied = np.apply(record, event("execution_completed", "native_record", summary="AGORA-OK"))
    assert applied.record.state == "completed"
    assert applied.record.result is not None
    assert applied.record.result.summary == "AGORA-OK"
    assert np.plan_recovery(applied.record) == "settled"


def test_usage_is_unknown_rather_than_zero_when_the_cli_reports_none() -> None:
    done = np.apply(bound_record(), event("execution_completed", "native_hook")).record
    assert done.result is not None and done.result.usage is None
    metered = np.apply(
        bound_record(), event("execution_completed", "native_record", usage=np.Usage(input_tokens=19358, output_tokens=12))
    ).record
    assert metered.result is not None and metered.result.usage.output_tokens == 12


def test_the_exported_schema_carries_native_turn_and_hides_host_state() -> None:
    exported = np.schema()
    assert "turn" in exported["models"]["NativeEvent"]["properties"]
    assert "NativeTurn" in exported["models"]
    assert "DeliveryRecord" not in exported["models"]
