"""Ordering and correlation rules of the native-control contract.

These are the invariants #19 and #20 build on: an event only affects the
request whose native turn it names, a withdrawal survives everything the host
later learns, and an event is only acknowledged once it really was applied.
"""

from __future__ import annotations

from uuid import uuid4

import native_protocol as np

LOCATOR = "thread-x"
TURN = "turn-1"


def make_request(*, side_effecting: bool = True) -> np.DeliveryRequest:
    return np.DeliveryRequest(
        request_id=uuid4(),
        origin=np.RequestOrigin(room_id=uuid4(), request_seq=7, requested_by=uuid4()),
        session=np.NativeSession(
            deployment="test",
            participant_id=uuid4(),
            computer_id=uuid4(),
            adapter="codex",
            tmux_target="sock:w.0",
            native_locator=LOCATOR,
        ),
        body="do the thing",
        side_effecting=side_effecting,
    )


def event(kind: np.EventKind, evidence: np.EvidenceKind, **kw) -> np.NativeEvent:
    turn_id = kw.pop("turn_id", TURN if kind in np.TURN_SCOPED_EVENTS else None)
    return np.NativeEvent(
        event_id=kw.pop("event_id", uuid4()),
        kind=kind,
        evidence=evidence,
        session=kw.pop("session", LOCATOR),
        turn_id=turn_id,
        **kw,
    )


def bound_record(**kw) -> np.DeliveryRecord:
    applied = np.apply(np.hand_off(np.start(make_request(**kw))), event("input_accepted", "native_hook"))
    assert applied.effect == "bound"
    return applied.record


# --- correlation ------------------------------------------------------------


def test_an_event_from_another_native_session_is_foreign() -> None:
    record = np.hand_off(np.start(make_request()))
    applied = np.apply(record, event("execution_completed", "native_notify", session="other-thread"))
    assert applied.effect == "foreign"
    assert applied.record == record


def test_an_internal_turn_on_the_same_session_cannot_finish_our_request() -> None:
    record = bound_record()
    applied = np.apply(record, event("execution_completed", "native_notify", turn_id="turn-2"))
    assert applied.effect == "foreign"
    assert applied.record.turn_state == "accepted"


def test_a_turn_scoped_event_without_a_turn_is_not_attributable() -> None:
    applied = np.apply(bound_record(), event("execution_completed", "native_notify", turn_id=None))
    assert applied.effect == "foreign"


def test_a_session_can_be_observed_before_any_turn_exists() -> None:
    record = np.hand_off(np.start(make_request()))
    applied = np.apply(record, event("session_exit", "process_exit"))
    assert applied.effect == "uncertain"
    assert applied.record.turn_state == "uncertain"


def test_process_exit_can_neither_finish_nor_fail_a_turn() -> None:
    record = bound_record()
    for kind in ("execution_completed", "execution_failed"):
        applied = np.apply(record, event(kind, "process_exit"))
        assert applied.effect == "unsupported_evidence"
        assert applied.record.turn_state == "accepted"


# --- attribution before acknowledgement -------------------------------------


def test_an_outcome_that_arrives_before_the_binding_is_kept_not_acknowledged() -> None:
    eid = uuid4()
    record = np.hand_off(np.start(make_request()))
    early = np.apply(record, event("execution_completed", "native_notify", event_id=eid, summary="RESULT"))
    assert early.effect == "deferred"
    assert eid not in early.record.applied_events

    bound = np.apply(early.record, event("input_accepted", "native_hook"))
    assert bound.record.turn_state == "completed"
    assert bound.record.result is not None and bound.record.result.summary == "RESULT"

    replay = np.apply(bound.record, event("execution_completed", "native_notify", event_id=eid, summary="RESULT"))
    assert replay.effect == "reacked"
    assert replay.record.result == bound.record.result


def test_a_deferred_outcome_replayed_before_binding_is_kept_once() -> None:
    eid = uuid4()
    record = np.hand_off(np.start(make_request()))
    first = np.apply(record, event("execution_completed", "native_notify", event_id=eid))
    second = np.apply(first.record, event("execution_completed", "native_notify", event_id=eid))
    assert second.effect == "deferred"
    assert len(second.record.deferred_events) == 1


def test_a_deferred_outcome_for_another_turn_is_dropped_at_binding() -> None:
    record = np.hand_off(np.start(make_request()))
    early = np.apply(record, event("execution_completed", "native_notify", turn_id="turn-9"))
    bound = np.apply(early.record, event("input_accepted", "native_hook"))
    assert bound.record.turn_state == "accepted"
    assert bound.record.result is None


def test_a_repeated_outcome_only_asks_for_another_ack() -> None:
    done = np.apply(bound_record(), event("execution_completed", "native_notify")).record
    again = np.apply(done, event("execution_completed", "native_notify"))
    assert again.effect == "late"
    assert again.record.result == done.result


# --- withdrawal vs the physical turn ----------------------------------------


def test_a_withdrawal_survives_an_exit_and_a_late_completion() -> None:
    record = np.withdraw(bound_record())
    exited = np.apply(record, event("session_exit", "process_exit"))
    assert exited.record.withdrawn
    late = np.apply(exited.record, event("execution_completed", "native_hook", summary="LATE"))
    assert late.effect == "late"
    assert late.record.withdrawn
    assert np.publishable_result(late.record) is None
    assert np.plan_recovery(late.record) == "settled"


def test_a_withdrawal_survives_the_host_losing_track() -> None:
    record = np.mark_uncertain(np.withdraw(bound_record()), "host restart")
    assert record.withdrawn
    assert np.plan_recovery(record) == "await_native"
    done = np.apply(record, event("execution_completed", "native_hook"))
    assert np.publishable_result(done.record) is None
    assert np.plan_recovery(done.record) == "settled"


def test_a_withdrawn_request_is_never_delivered_again() -> None:
    for side_effecting in (True, False):
        record = np.mark_uncertain(np.withdraw(bound_record(side_effecting=side_effecting)), "crash")
        assert np.plan_recovery(record) != "deliver"
        assert np.blocked_reason(np.withdraw(np.start(make_request())), np.SessionGate())


def test_a_naturally_finished_turn_releases_the_channel_after_a_withdrawal() -> None:
    record = np.withdraw(bound_record())
    assert not np.channel_released(record)
    done = np.apply(record, event("execution_completed", "native_hook")).record
    assert np.channel_released(done)


def test_withdrawing_before_delivery_injects_nothing_and_frees_the_channel() -> None:
    record = np.withdraw(np.start(make_request()))
    assert record.turn_state == "pending"
    assert np.channel_released(record)
    assert np.plan_recovery(record) == "settled"


def test_a_stopped_turn_stays_unknown_because_no_cli_reports_one() -> None:
    """Both installed CLIs go silent after a stop; nothing may be inferred."""
    record = np.withdraw(bound_record())
    assert record.turn_state == "accepted"
    assert not np.channel_released(record)
    assert np.plan_recovery(record) == "await_native"
    assert np.publishable_result(record) is None


def test_a_settled_turn_is_not_reopened_by_a_later_signal() -> None:
    done = np.apply(bound_record(), event("execution_completed", "native_hook")).record
    for kind, evidence in (("execution_failed", "native_hook"), ("execution_completed", "native_notify")):
        applied = np.apply(done, event(kind, evidence))
        assert applied.effect == "late"
        assert applied.record.turn_state == "completed"


# --- delivery gate and recovery ---------------------------------------------


def test_a_permission_prompt_stops_automatic_delivery() -> None:
    waiting = np.apply(np.start(make_request()), event("permission_wait", "native_hook")).record
    assert np.blocked_reason(waiting, np.SessionGate()) is not None
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
    assert applied.record.turn_state == "completed"
    assert np.publishable_result(applied.record).summary == "AGORA-OK"
    assert np.plan_recovery(applied.record) == "settled"


def test_usage_is_unknown_rather_than_zero_when_the_cli_reports_none() -> None:
    done = np.apply(bound_record(), event("execution_completed", "native_hook")).record
    assert done.result is not None and done.result.usage is None
    metered = np.apply(
        bound_record(),
        event("execution_completed", "native_record", usage=np.Usage(input_tokens=19486, output_tokens=9)),
    ).record
    assert metered.result.usage.output_tokens == 9
