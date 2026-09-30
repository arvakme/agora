"""The turn clock's rules with a clock of our own (server/canvas/turn_clock.py); the backends' use of it is tests/test_turn_idle.py."""

from __future__ import annotations

import pytest

from server.canvas.turn_clock import TurnClock, span


class Now:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("AGORA_TURN_IDLE_TIMEOUT_S", raising=False)
    monkeypatch.delenv("AGORA_TURN_MAX_S", raising=False)


def test_defaults_are_thirty_minutes_of_quiet_and_a_six_hour_fuse():
    c = TurnClock()
    assert (c.idle_s, c.max_s) == (1800, 6 * 3600)


def test_the_environment_overrides_and_zero_switches_a_limit_off(monkeypatch):
    monkeypatch.setenv("AGORA_TURN_IDLE_TIMEOUT_S", "0")
    monkeypatch.setenv("AGORA_TURN_MAX_S", "90")
    c = TurnClock()
    assert (c.idle_s, c.max_s) == (0, 90)
    monkeypatch.setenv("AGORA_TURN_IDLE_TIMEOUT_S", "nonsense")
    assert TurnClock().idle_s == 1800  # a value that is not a number is not a setting


def test_only_quiet_time_counts_and_a_touch_starts_it_over():
    now = Now()
    c = TurnClock(idle_s=60, max_s=0, now=now)
    now.t += 59
    assert c.expired() is None
    c.touch()
    now.t += 59
    assert c.expired() is None  # 118 s into the turn, 59 s of quiet
    now.t += 2
    assert c.expired() == "idle"


def test_an_open_tool_call_allows_a_longer_quiet_spell_until_it_closes():
    now = Now()
    c = TurnClock(idle_s=60, max_s=0, now=now)
    c.observe({"t": "tool_use", "id": "c1"})
    now.t += 200
    assert c.expired() is None  # 60 s × 4 = 240 s
    now.t += 41
    assert c.expired() == "idle"
    c.observe({"t": "tool_result", "id": "c1"})
    now.t += 61
    assert c.expired() == "idle"  # closed: back to 60 s
    c.observe({"t": "text"})
    assert c.expired() is None


def test_two_open_calls_need_both_results():
    now = Now()
    c = TurnClock(idle_s=10, max_s=0, now=now)
    c.observe({"t": "tool_use", "id": "a"})
    c.observe({"t": "tool_use", "id": "b"})
    c.observe({"t": "tool_result", "id": "a"})
    now.t += 30
    assert c.expired() is None


def test_the_fuse_ends_a_turn_that_never_goes_quiet():
    now = Now()
    c = TurnClock(idle_s=60, max_s=600, now=now)
    for _ in range(11):
        now.t += 55
        c.touch()
    assert c.expired() == "max"


def test_waiting_for_the_person_stops_both_limits_and_is_not_the_turns_time():
    now = Now()
    c = TurnClock(idle_s=60, max_s=600, now=now)
    c.hold(True)
    now.t += 5000
    assert c.expired() is None
    c.hold(False)
    assert c.expired() is None  # the wait is over: a new quiet spell starts
    now.t += 500
    c.touch()
    assert c.expired() is None  # 500 s of the turn's own time, not 5500
    now.t += 101
    assert c.expired() == "max"


def test_with_both_limits_off_nothing_expires():
    now = Now()
    c = TurnClock(idle_s=0, max_s=0, now=now)
    now.t += 10**6
    assert c.expired() is None


def test_wake_in_is_the_nearest_deadline():
    now = Now()
    c = TurnClock(idle_s=60, max_s=100, now=now)
    assert c.wake_in() == 60
    now.t += 50
    c.touch()
    assert c.wake_in() == 50  # the fuse is nearer than another 60 s of quiet


@pytest.mark.parametrize(
    "seconds, words",
    [(0.6, "0.6 秒"), (60, "1 分钟"), (90, "1.5 分钟"), (3600, "1 小时"), (6 * 3600, "6 小时"), (5400, "90 分钟")],
)
def test_span_reads_like_a_person_says_it(seconds, words):
    assert span(seconds) == words


def test_the_messages_say_what_happened_and_how_to_go_on():
    c = TurnClock(idle_s=1800, max_s=6 * 3600)
    c.reason, c.limit_s = "idle", 1800
    assert c.message() == "这一轮 30 分钟没有任何输出，已中止；原生会话还在，发「继续」就能接着"
    c.reason, c.limit_s = "max", 6 * 3600
    assert c.message() == "这一轮已经跑了 6 小时，到了上限，已中止；原生会话还在，发「继续」就能接着"
