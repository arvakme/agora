"""Ordering rules of the native-control contract that other modules rely on."""

from __future__ import annotations

from uuid import uuid4

import pytest

import native_protocol as np


def session() -> np.NativeSession:
    return np.NativeSession(
        deployment="test",
        session_key="w1",
        adapter="claude_code",
        tmux_target="sock:w.0",
        native_locator="abc",
    )


def request(*, side_effecting: bool = True, persisted: bool = True) -> np.DeliveryRequest:
    return np.DeliveryRequest(
        request_id=uuid4(),
        session=session(),
        body="do the thing",
        side_effecting=side_effecting,
        persisted=persisted,
    )


def event(kind: np.EventKind, evidence: np.EvidenceKind, **kw) -> np.NativeEvent:
    return np.NativeEvent(
        event_id=kw.pop("event_id", uuid4()),
        kind=kind,
        evidence=evidence,
        session_key="w1",
        **kw,
    )


def test_delivery_requires_persisted_request() -> None:
    with pytest.raises(ValueError):
        np.start(request(persisted=False))


def test_terminal_transport_success_is_not_acceptance() -> None:
    record = np.hand_off(np.start(request()))
    assert record.state == "in_flight"
    assert np.plan_recovery(record) == "reconcile_first"


def test_process_exit_cannot_complete_a_turn() -> None:
    record = np.hand_off(np.start(request()))
    record = np.apply(record, event("execution_completed", "process_exit"))
    assert record.state == "in_flight"
    assert record.rejected_evidence == 1


def test_exit_during_a_turn_is_uncertain_not_failure() -> None:
    record = np.apply(np.hand_off(np.start(request())), event("session_exit", "process_exit"))
    assert record.state == "uncertain"


def test_side_effecting_uncertainty_waits_for_the_native_session() -> None:
    record = np.mark_uncertain(np.hand_off(np.start(request())), "crash")
    assert np.plan_recovery(record) == "await_native"
    harmless = np.mark_uncertain(np.hand_off(np.start(request(side_effecting=False))), "crash")
    assert np.plan_recovery(harmless) == "deliver"


def test_native_evidence_resolves_an_uncertain_delivery() -> None:
    record = np.mark_uncertain(np.hand_off(np.start(request())), "crash")
    record = np.apply(record, event("input_accepted", "native_hook"))
    record = np.apply(record, event("execution_completed", "native_hook", result_id=uuid4()))
    assert record.state == "completed"
    assert np.plan_recovery(record) == "settled"


def test_a_repeated_result_only_acknowledges() -> None:
    result = uuid4()
    record = np.apply(np.hand_off(np.start(request())), event("input_accepted", "native_queue_ack"))
    record = np.apply(record, event("execution_completed", "native_notify", result_id=result))
    again = np.apply(record, event("execution_completed", "native_notify", result_id=result))
    assert again.state == "completed"
    assert again.duplicate_acks == record.duplicate_acks + 1
    assert again.results == record.results


def test_a_replayed_event_is_folded_once() -> None:
    eid = uuid4()
    record = np.apply(np.hand_off(np.start(request())), event("input_accepted", "native_hook", event_id=eid))
    again = np.apply(record, event("input_accepted", "native_hook", event_id=eid))
    assert again.applied_events == record.applied_events
    assert again.duplicate_acks == 1


def test_a_late_result_after_cancel_is_not_a_completion() -> None:
    record = np.apply(np.hand_off(np.start(request())), event("cancel_acked", "native_hook"))
    record = np.apply(record, event("execution_completed", "native_hook", result_id=uuid4()))
    assert record.state == "cancelled"
    assert record.late_results == 1


def test_takeover_and_unmanaged_writers_both_stop_automatic_delivery() -> None:
    record = np.start(request())
    assert np.may_deliver(record, np.InputRight())
    assert not np.may_deliver(record, np.InputRight(holder="human"))
    assert not np.may_deliver(record, np.observe_writers(np.InputRight(), 1))


def test_detach_does_not_hand_the_input_right_back() -> None:
    taken = np.InputRight(holder="human", paused=True)
    assert np.on_detach(taken) == taken
    assert np.on_control_loss(np.InputRight()).paused
