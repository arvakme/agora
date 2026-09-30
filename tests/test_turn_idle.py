"""A turn is stopped for going quiet, not for taking long (server/canvas/turn_clock.py): headless and resident alike.

The limits are shortened (seconds, not minutes) through the backends' own arguments and ``AGORA_TURN_*``; the fake CLI
(tests/fake_timed_cli.py) plays a timed script."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

from server.canvas import agents
from server.canvas.adapters.common import LogLookup
from server.canvas.agents import CodexBackend
from server.canvas.resident import CodexResidentBackend, ResidentPool
from server.canvas.runner import ExecOptions, RunRequest

FAKE = str(Path(__file__).parent / "fake_timed_cli.py")
CONTINUE = "发「继续」"


def script(*steps) -> dict[str, str]:
    return {"FAKE_SCRIPT": json.dumps(list(steps))}


def ticks(n: int, gap: float):
    return [s for _ in range(n) for s in ({"sleep": gap}, {"say": "还在做"})]


def request(tmp_path: Path, **kw) -> RunRequest:
    return RunRequest(schema=None, system=None, prompt="p", options=ExecOptions(backend="codex", model="", session=kw.pop("session", None)), cwd=str(tmp_path), env=kw.pop("env", None), **kw)


async def headless(tmp_path: Path, steps: dict[str, str], **limits):
    b = CodexBackend([sys.executable, FAKE], env=steps, **limits)
    t0 = time.monotonic()
    evs = [e async for e in b.run(request(tmp_path))]
    return evs[-1], time.monotonic() - t0


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("AGORA_TURN_IDLE_TIMEOUT_S", raising=False)
    monkeypatch.delenv("AGORA_TURN_MAX_S", raising=False)


async def test_a_turn_that_keeps_talking_outlives_the_idle_limit(tmp_path):
    """2.4 s of output, a line every 0.3 s, against an idle limit of 0.8 s: the old wall clock would have ended it at 0.8 s."""
    res, took = await headless(tmp_path, script(*ticks(8, 0.3), {"done": 1}), idle_s=0.8)
    assert "error" not in res, res
    assert took > 2.0


async def test_a_quiet_turn_is_stopped_with_words_a_person_can_act_on(tmp_path):
    res, took = await headless(tmp_path, script({"say": "开始"}, {"sleep": 30}), idle_s=0.6)
    assert took < 10
    assert res["error"] == f"这一轮 0.6 秒没有任何输出，已中止；原生会话还在，{CONTINUE}就能接着", res
    assert res["raw"] == "开始"  # what was said before it went quiet is kept


async def test_a_running_tool_call_gets_the_longer_limit(tmp_path):
    """A command that prints nothing for 1.2 s passes (limit 0.4 s × 4 while a call is open) ..."""
    res, _ = await headless(tmp_path, script({"tool": "start"}, {"sleep": 1.2}, {"tool": "end"}, {"say": "好了"}, {"done": 1}), idle_s=0.4)
    assert "error" not in res, res


async def test_a_tool_call_that_never_ends_is_stopped_at_the_longer_limit(tmp_path):
    res, took = await headless(tmp_path, script({"tool": "start"}, {"sleep": 30}), idle_s=0.4)
    assert res["error"].startswith("这一轮 1.6 秒没有任何输出"), res  # 4 × 0.4 s
    assert 1.4 < took < 10


async def test_idle_limit_zero_leaves_only_the_absolute_one(tmp_path, monkeypatch):
    monkeypatch.setenv("AGORA_TURN_IDLE_TIMEOUT_S", "0")
    res, _ = await headless(tmp_path, script({"sleep": 1.5}, {"done": 1}), max_s=30)
    assert "error" not in res, res  # 1.5 s of silence, no idle limit
    res, _ = await headless(tmp_path, script({"sleep": 30}), max_s=0.8)
    assert res["error"] == f"这一轮已经跑了 0.8 秒，到了上限，已中止；原生会话还在，{CONTINUE}就能接着", res


async def test_the_environment_sets_the_idle_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("AGORA_TURN_IDLE_TIMEOUT_S", "0.5")
    res, _ = await headless(tmp_path, script({"sleep": 30}))
    assert res["error"].startswith("这一轮 0.5 秒没有任何输出"), res


async def test_the_absolute_limit_stops_a_turn_that_never_goes_quiet(tmp_path, monkeypatch):
    monkeypatch.setenv("AGORA_TURN_MAX_S", "1.2")
    res, took = await headless(tmp_path, script(*ticks(100, 0.2)), idle_s=5)
    assert res["error"].startswith("这一轮已经跑了 1.2 秒，到了上限"), res
    assert took < 10


async def test_stderr_counts_as_activity(tmp_path):
    res, _ = await headless(tmp_path, script(*[s for i in range(6) for s in ({"sleep": 0.3}, {"stderr": f"step {i}"})], {"done": 1}), idle_s=0.8)
    assert "error" not in res, res


async def test_a_growing_native_log_counts_as_activity(tmp_path, monkeypatch):
    """Pi and Codex headless say little on stdout: the native log growing shows the turn is alive."""
    log = tmp_path / "native.jsonl"
    log.write_bytes(b"x")
    monkeypatch.setattr(agents, "locate_log", lambda kind, native_id, root=None, home=None, hint=None: LogLookup("found", log, [log]))
    b = CodexBackend([sys.executable, FAKE], env=script(*[s for _ in range(8) for s in ({"sleep": 0.3}, {"append": str(log)})], {"done": 1}), idle_s=0.8)
    evs = [e async for e in b.run(request(tmp_path, session="th-t"))]
    assert "error" not in evs[-1], evs[-1]


async def test_a_log_that_stopped_growing_does_not_keep_a_quiet_turn_alive(tmp_path, monkeypatch):
    log = tmp_path / "native.jsonl"
    log.write_bytes(b"x")
    monkeypatch.setattr(agents, "locate_log", lambda kind, native_id, root=None, home=None, hint=None: LogLookup("found", log, [log]))
    b = CodexBackend([sys.executable, FAKE], env=script({"sleep": 30}), idle_s=0.6)
    evs = [e async for e in b.run(request(tmp_path, session="th-t"))]
    assert evs[-1]["error"].startswith("这一轮 0.6 秒没有任何输出"), evs[-1]


# ——— the resident way: the same clock ———
@pytest.fixture
async def pool(tmp_path):
    p = ResidentPool(tmp_path / "residents", idle_s=600)
    yield p
    await p.close_all()


async def resident(pool, tmp_path: Path, steps: dict[str, str], **limits):
    b = CodexResidentBackend(cmd=[sys.executable, FAKE], env=steps, **limits)
    b.attach_pool(pool)
    r = request(tmp_path, env={"AGORA_SESSION": "s-1"})
    evs = [e async for e in b.run(r)]
    return evs[-1], evs


async def test_resident_a_turn_that_keeps_talking_outlives_the_idle_limit(pool, tmp_path):
    res, evs = await resident(pool, tmp_path, script(*ticks(8, 0.3), {"done": 1}), idle_s=0.8)
    assert any(e["t"] == "resident" and e["ok"] for e in evs)
    assert "error" not in res, res


async def test_resident_a_quiet_turn_is_stopped_and_its_process_ends(pool, tmp_path):
    res, _ = await resident(pool, tmp_path, script({"say": "开始"}, {"sleep": 30}), idle_s=0.6)
    assert res["error"] == f"这一轮 0.6 秒没有任何输出，已中止；原生会话还在，{CONTINUE}就能接着", res
    assert not pool.procs  # a timed-out process is not kept for the next turn


async def test_resident_a_running_tool_call_gets_the_longer_limit(pool, tmp_path):
    res, _ = await resident(pool, tmp_path, script({"tool": "start"}, {"sleep": 1.2}, {"tool": "end"}, {"say": "好了"}, {"done": 1}), idle_s=0.4)
    assert "error" not in res, res


async def test_resident_the_absolute_limit(pool, tmp_path):
    res, _ = await resident(pool, tmp_path, script(*ticks(100, 0.2)), idle_s=5, max_s=1.2)
    assert res["error"].startswith("这一轮已经跑了 1.2 秒，到了上限"), res


async def test_resident_idle_limit_zero_leaves_only_the_absolute_one(pool, tmp_path, monkeypatch):
    monkeypatch.setenv("AGORA_TURN_IDLE_TIMEOUT_S", "0")
    res, _ = await resident(pool, tmp_path, script({"sleep": 1.5}, {"done": 1}), max_s=30)
    assert "error" not in res, res
