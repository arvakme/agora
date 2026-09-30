"""Codex and Pi that can take words while a turn runs (ST2): one long-lived process per session (``codex app-server``,
``pi --mode rpc``) instead of a process per turn. Protocol shapes are those recorded on 2026-09-29 (codex 0.157.1, pi 0.87.1,
tests/fixtures/agents/{codex-appserver,pi-rpc}/); the processes here are stubs (tests/fake_codex_appserver.py, fake_pi_rpc.py)."""

import asyncio
import json
import os
import signal
import sys
import time
from pathlib import Path

import pytest

from server.canvas import adapters, agents, resident
from server.canvas.adapters.claude import interrupt_request
from server.canvas.resident import CodexResidentBackend, PiResidentBackend, ResidentPool
from server.canvas.runner import Control, ExecOptions, RunRequest

CODEX = Path(__file__).parent / "fake_codex_appserver.py"
PI = Path(__file__).parent / "fake_pi_rpc.py"


def steer_line(kind: str, text: str) -> dict:
    return adapters.need(kind).steer_line(text)


@pytest.fixture
async def pool(tmp_path):
    p = ResidentPool(tmp_path / "residents", idle_s=600)
    yield p
    await p.close_all()


def make(kind, pool, tmp_path, mode="hold", **env):
    log = tmp_path / f"{kind}.log"
    cls, fake = (CodexResidentBackend, CODEX) if kind == "codex" else (PiResidentBackend, PI)
    b = cls(cmd=[sys.executable, str(fake)], env={"FAKE_LOG": str(log), "FAKE_MODE": mode, **{k: str(v) for k, v in env.items()}}, timeout_s=20)
    b.attach_pool(pool)
    return b, log


def req(kind, tmp_path, prompt="读 f1", *, sid="s-1", session=None, control=None, model="m-1", effort="low", env=None, new=True, **kw):
    return RunRequest(schema=None, system=None, prompt=prompt, options=ExecOptions(backend=kind, model=model, effort=effort, session=session, new_session=new), cwd=str(tmp_path), env={"AGORA_SESSION": sid, **(env or {})}, control=control, **kw)


async def run(backend, r):
    return [e async for e in backend.run(r)]


def lines(log: Path) -> list:
    return [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []


def methods(log: Path) -> list[str]:
    return [x["method"] for x in lines(log) if isinstance(x, dict) and "method" in x]


def kinds(evs) -> list[str]:
    return [e["t"] for e in evs]


async def steady(cond, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        await asyncio.sleep(0.05)
    return False


# ——— what the adapters say ———
def test_codex_and_pi_can_take_words_and_no_longer_give_a_reason():
    for k in ("codex", "pi"):
        a = adapters.need(k)
        assert a.steer is True and a.no_steer == ""
    assert adapters.need("codex").steer_line("停一下") == {"type": "user", "message": {"role": "user", "content": "停一下"}}


# ——— Codex: app-server ———
async def test_codex_a_turn_over_the_app_server(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "quick")
    evs = await run(b, req("codex", tmp_path, "读 f1"))
    assert kinds(evs)[:3] == ["resident", "start", "session"] and evs[0] == {"t": "resident", "ok": True, "at": evs[0]["at"]}
    assert evs[2]["session"] == "th-1"
    assert [e["name"] for e in evs if e["t"] == "tool_use"] == ["shell"]
    tr = next(e for e in evs if e["t"] == "tool_result")
    assert tr["id"] == "c1" and "content-1" in tr["text"] and tr["isError"] is False
    res = evs[-1]
    assert res["t"] == "result" and "error" not in res and res["raw"] == "f1 是 content-1" and res["session"] == "th-1"
    assert res["usage"]["inputTokens"] and res["usage"]["outputTokens"] == 10
    ms = methods(log)
    assert ms[:4] == ["initialize", "initialized", "thread/start", "turn/start"]
    start = next(x for x in lines(log) if x.get("method") == "thread/start")
    assert start["params"]["cwd"] == str(tmp_path) and start["params"]["approvalPolicy"] == "never" and start["params"]["model"] == "m-1"
    turn = next(x for x in lines(log) if x.get("method") == "turn/start")
    assert turn["params"]["input"] == [{"type": "text", "text": "读 f1"}] and turn["params"]["effort"] == "low"
    assert any(e["t"] == "spawned" and e["pid"] for e in evs)


async def test_codex_the_next_turn_of_a_session_uses_the_same_process(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "quick")
    first = await run(b, req("codex", tmp_path, "一"))
    second = await run(b, req("codex", tmp_path, "二", session="th-1", new=False))
    assert methods(log).count("initialize") == 1 and methods(log).count("thread/start") == 1 and methods(log).count("turn/start") == 2
    assert next(e["pid"] for e in first if e["t"] == "spawned") == next(e["pid"] for e in second if e["t"] == "spawned")
    assert second[-1]["t"] == "result" and "error" not in second[-1]
    assert "session" not in kinds(second)  # the host knows the thread already


async def test_codex_a_new_process_resumes_the_thread_it_is_told_to(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "quick")
    evs = await run(b, req("codex", tmp_path, "接着", session="th-9", new=False))
    res = next(x for x in lines(log) if x.get("method") == "thread/resume")
    assert res["params"]["threadId"] == "th-9" and res["params"]["excludeTurns"] is True and res["params"]["approvalPolicy"] == "never"
    assert "thread/start" not in methods(log) and evs[-1]["t"] == "result" and "error" not in evs[-1]


async def test_codex_words_said_during_the_turn_are_steered_into_it(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "hold")
    ctl = Control()
    task = asyncio.create_task(run(b, req("codex", tmp_path, "读 5 个", control=ctl)))
    assert await steady(lambda: "turn/start" in methods(log) and (tmp_path / "codex.log").read_text().count("turn/start") == 1)
    await asyncio.sleep(0.3)
    ctl.send(steer_line("codex", "停一下，只读前两个"))
    evs = await asyncio.wait_for(task, 10)
    st = next(x for x in lines(log) if x.get("method") == "turn/steer")
    assert st["params"]["threadId"] == "th-1" and st["params"]["expectedTurnId"] == "tu-1"
    assert st["params"]["input"] == [{"type": "text", "text": "停一下，只读前两个"}]
    assert evs[-1]["t"] == "result" and "error" not in evs[-1] and evs[-1]["raw"] == "收到，只读前两个"


async def test_codex_interrupt_ends_the_turn_and_keeps_the_process(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "hold")
    ctl = Control()
    task = asyncio.create_task(run(b, req("codex", tmp_path, "读 5 个", control=ctl)))
    assert await steady(lambda: "turn/start" in methods(log))
    await asyncio.sleep(0.3)
    ctl.send(interrupt_request("i-1"))
    evs = await asyncio.wait_for(task, 10)
    it = next(x for x in lines(log) if x.get("method") == "turn/interrupt")
    assert it["params"] == {"threadId": "th-1", "turnId": "tu-1"}
    assert evs[-1]["t"] == "result" and evs[-1].get("interrupted") is True and "error" not in evs[-1]
    (proc,) = pool.procs.values()
    assert proc.alive  # the next turn goes on in it
    b2 = await run(b, req("codex", tmp_path, "quick:再来", session="th-1", new=False, control=Control()))
    assert methods(log).count("initialize") == 1 and b2[-1]["t"] == "result"


async def test_codex_a_process_that_dies_mid_turn_is_an_error_with_its_last_words_and_the_next_turn_resumes(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "die")
    evs = await run(b, req("codex", tmp_path))
    err = evs[-1]["error"]
    assert evs[-1]["t"] == "result" and "database is locked" in err and "3" in err
    assert not pool.procs  # the dead one is gone
    b.env["FAKE_MODE"] = "quick"
    evs = await run(b, req("codex", tmp_path, session="th-1", new=False))
    assert "thread/resume" in methods(log) and evs[-1]["t"] == "result" and "error" not in evs[-1]


async def test_codex_what_the_cli_asks_the_host_is_answered_not_left_hanging(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "approval")
    evs = await asyncio.wait_for(run(b, req("codex", tmp_path)), 10)
    answer = next(x for x in lines(log) if x.get("id") == "srv-1")
    assert "error" in answer and evs[-1]["t"] == "result" and "error" not in evs[-1]


async def test_codex_a_changed_environment_starts_a_fresh_process(pool, tmp_path):
    """AGORA_CANVAS is in the process's environment: a session moved to another canvas must not keep the old one."""
    b, log = make("codex", pool, tmp_path, "quick")
    await run(b, req("codex", tmp_path, env={"AGORA_CANVAS": "c1"}))
    await run(b, req("codex", tmp_path, session="th-1", new=False, env={"AGORA_CANVAS": "c2"}))
    assert methods(log).count("initialize") == 2 and "thread/resume" in methods(log)


# ——— Pi: rpc ———
async def test_pi_a_turn_over_rpc(pool, tmp_path):
    b, log = make("pi", pool, tmp_path, "quick")
    evs = await run(b, req("pi", tmp_path, "读 f1", session="11111111-1111-4111-8111-111111111111"))
    assert kinds(evs)[:2] == ["resident", "start"]
    assert [e["name"] for e in evs if e["t"] == "tool_use"] == ["read"]
    res = evs[-1]
    assert res["t"] == "result" and "error" not in res and res["raw"] == "f1 是 content-1" and res["usage"]["outputTokens"] == 10
    argv = lines(log)[0]["argv"]
    assert argv[:2] == ["--mode", "rpc"] and "-p" not in argv
    assert argv[argv.index("--session-id") + 1] == "11111111-1111-4111-8111-111111111111"
    assert argv[argv.index("--model") + 1] == "m-1" and argv[argv.index("--thinking") + 1] == "low"
    p = next(x for x in lines(log) if x.get("type") == "prompt")
    assert p["message"] == "读 f1"


async def test_pi_the_next_turn_reuses_the_process(pool, tmp_path):
    b, log = make("pi", pool, tmp_path, "quick")
    sess = "11111111-1111-4111-8111-111111111111"
    a = await run(b, req("pi", tmp_path, "一", session=sess))
    c = await run(b, req("pi", tmp_path, "二", session=sess, new=False))
    assert sum(1 for x in lines(log) if "argv" in x) == 1 and sum(1 for x in lines(log) if x.get("type") == "prompt") == 2
    assert next(e["pid"] for e in a if e["t"] == "spawned") == next(e["pid"] for e in c if e["t"] == "spawned")


async def test_pi_words_said_during_the_turn_are_steered(pool, tmp_path):
    b, log = make("pi", pool, tmp_path, "hold")
    ctl = Control()
    task = asyncio.create_task(run(b, req("pi", tmp_path, "读 5 个", control=ctl, session="s")))
    assert await steady(lambda: any(x.get("type") == "prompt" for x in lines(log)))
    await asyncio.sleep(0.3)
    ctl.send(steer_line("pi", "停一下，只读前两个"))
    evs = await asyncio.wait_for(task, 10)
    st = next(x for x in lines(log) if x.get("type") == "steer")
    assert st["message"] == "停一下，只读前两个"
    assert evs[-1]["t"] == "result" and "error" not in evs[-1] and evs[-1]["raw"] == "收到，只读前两个"


async def test_pi_abort_is_a_clean_stop_not_a_failure(pool, tmp_path):
    b, log = make("pi", pool, tmp_path, "hold")
    ctl = Control()
    task = asyncio.create_task(run(b, req("pi", tmp_path, control=ctl, session="s")))
    assert await steady(lambda: any(x.get("type") == "prompt" for x in lines(log)))
    await asyncio.sleep(0.3)
    ctl.send(interrupt_request("i-1"))
    evs = await asyncio.wait_for(task, 10)
    assert any(x.get("type") == "abort" for x in lines(log))
    assert evs[-1]["t"] == "result" and evs[-1].get("interrupted") is True and "error" not in evs[-1]
    (proc,) = pool.procs.values()
    assert proc.alive


async def test_pi_a_process_that_dies_is_an_error_and_the_next_turn_starts_a_new_one(pool, tmp_path):
    b, log = make("pi", pool, tmp_path, "die")
    evs = await run(b, req("pi", tmp_path, session="s"))
    assert "out of memory" in evs[-1]["error"] and not pool.procs
    b.env["FAKE_MODE"] = "quick"
    evs = await run(b, req("pi", tmp_path, session="s", new=False))
    assert evs[-1]["t"] == "result" and "error" not in evs[-1] and sum(1 for x in lines(log) if "argv" in x) == 2


async def test_pi_a_question_from_an_extension_is_answered_with_a_cancel(pool, tmp_path):
    b, log = make("pi", pool, tmp_path, "ui")
    evs = await asyncio.wait_for(run(b, req("pi", tmp_path, session="s")), 10)
    ans = next(x for x in lines(log) if x.get("type") == "extension_ui_response")
    assert ans["id"] == "ask-1" and ans["cancelled"] is True and evs[-1]["t"] == "result"


# ——— the process's life ———
async def test_an_idle_process_is_let_go_after_the_idle_time_and_the_next_turn_starts_a_new_one(tmp_path):
    pool = ResidentPool(tmp_path / "residents", idle_s=0.4, sweep_s=0.1)
    b, log = make("codex", pool, tmp_path, "quick")
    await run(b, req("codex", tmp_path))
    (proc,) = pool.procs.values()
    pid = proc.pid
    assert await steady(lambda: not pool.procs, 6)
    assert await steady(lambda: not _alive(pid), 6)  # (it leaves the pool first, then it is stopped)
    assert not list((tmp_path / "residents").glob("*.json"))  # its marker went with it
    evs = await run(b, req("codex", tmp_path, session="th-1", new=False))
    assert "thread/resume" in methods(log) and evs[-1]["t"] == "result"
    await pool.close_all()


async def test_a_busy_process_is_never_reaped(tmp_path):
    pool = ResidentPool(tmp_path / "residents", idle_s=0.2, sweep_s=0.1)
    b, log = make("codex", pool, tmp_path, "hold")
    ctl = Control()
    task = asyncio.create_task(run(b, req("codex", tmp_path, control=ctl)))
    assert await steady(lambda: "turn/start" in methods(log))
    await asyncio.sleep(1.0)  # far past idle_s, the turn still runs
    assert pool.procs
    ctl.send(steer_line("codex", "好了"))
    await asyncio.wait_for(task, 10)
    await pool.close_all()


async def test_too_many_processes_the_longest_idle_one_makes_room(tmp_path):
    pool = ResidentPool(tmp_path / "residents", idle_s=600, max_procs=2)
    b, log = make("codex", pool, tmp_path, "quick")
    for sid in ("a", "b", "c"):
        await run(b, req("codex", tmp_path, sid=sid))
    assert sorted(p.key for p in pool.procs.values()) == ["b", "c"]
    await pool.close_all()


async def test_one_stuck_session_does_not_hold_the_others(pool, tmp_path):
    hold, quick = make("codex", pool, tmp_path, "hold")[0], make("codex", pool, tmp_path, "quick")[0]
    ctl = Control()
    stuck = asyncio.create_task(run(hold, req("codex", tmp_path, sid="stuck", control=ctl)))
    await asyncio.sleep(0.5)
    t = time.time()
    evs = await asyncio.wait_for(run(quick, req("codex", tmp_path, sid="other")), 10)
    assert evs[-1]["t"] == "result" and time.time() - t < 8 and not stuck.done()
    ctl.send(steer_line("codex", "好了"))
    await asyncio.wait_for(stuck, 10)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        import subprocess

        st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    except OSError:
        return True
    return bool(st) and not st.startswith("Z")


async def test_closing_the_pool_ends_the_process_and_what_it_started(tmp_path):
    pool = ResidentPool(tmp_path / "residents", idle_s=600)
    child = tmp_path / "child.pid"
    b, log = make("codex", pool, tmp_path, "quick", FAKE_CHILD=child)
    await run(b, req("codex", tmp_path))
    (proc,) = pool.procs.values()
    kid = int(child.read_text())
    assert _alive(proc.pid) and _alive(kid)
    t = time.time()
    await pool.close_all()
    assert time.time() - t < 12 and not _alive(proc.pid)
    assert await steady(lambda: not _alive(kid), 6)  # a shell's child too (proctree)
    assert not pool.procs and not list((tmp_path / "residents").glob("*.json"))


async def test_a_cancelled_turn_stops_its_process_the_turn_state_is_unknown(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "hold")
    task = asyncio.create_task(run(b, req("codex", tmp_path, control=Control())))
    assert await steady(lambda: "turn/start" in methods(log))
    (proc,) = pool.procs.values()
    pid = proc.pid
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await steady(lambda: not _alive(pid), 8) and not pool.procs


def test_leftovers_of_a_dead_server_are_listed_for_the_next_one_to_stop(tmp_path):
    d = tmp_path / "residents"
    d.mkdir()
    (d / "111.json").write_text(json.dumps({"pid": 111, "argv": ["codex", "app-server"], "server": 2**22 + 5, "key": "s-1"}))
    (d / "222.json").write_text(json.dumps({"pid": 222, "argv": ["codex", "app-server"], "server": os.getpid(), "key": "s-2"}))
    (d / "bad.json").write_text("{")
    pool = ResidentPool(d)
    left = pool.leftovers()
    assert [(m["pid"], m["key"]) for m in left] == [(111, "s-1")]  # 222 belongs to a server that is alive (this one)
    assert not (d / "111.json").exists() and not (d / "bad.json").exists() and (d / "222.json").exists()


# ——— falling back to the one-shot way ———
async def test_codex_without_an_app_server_falls_back_and_says_why(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "quick", FAKE_NO_APPSERVER=1)
    evs = await run(b, req("codex", tmp_path))
    assert evs[0]["t"] == "resident" and evs[0]["ok"] is False and "app-server" in evs[0]["why"]
    assert evs[-1]["t"] == "result" and "error" not in evs[-1] and evs[-1]["raw"] == "一次性跑法的回答"
    assert not pool.procs
    n = sum(1 for x in lines(log) if x.get("argv", [""])[0] == "app-server")
    await run(b, req("codex", tmp_path, session="th-exec", new=False))
    assert sum(1 for x in lines(log) if x.get("argv", [""])[0] == "app-server") == n  # not tried again on every turn


async def test_pi_without_rpc_falls_back_and_says_why(pool, tmp_path):
    b, log = make("pi", pool, tmp_path, "quick", FAKE_NO_RPC=1)
    evs = await run(b, req("pi", tmp_path, session="s"))
    assert evs[0]["t"] == "resident" and evs[0]["ok"] is False and "rpc" in evs[0]["why"]
    assert evs[-1]["t"] == "result" and evs[-1]["raw"] == "一次性跑法的回答"


async def test_a_missing_binary_falls_back_with_the_reason(pool, tmp_path):
    b = CodexResidentBackend(cmd=[str(tmp_path / "no-such-codex")], timeout_s=5)
    b.attach_pool(pool)
    evs = await run(b, req("codex", tmp_path))
    assert evs[0]["ok"] is False and evs[0]["why"]
    assert evs[-1]["t"] == "result" and "spawn" in evs[-1]["error"]  # the one-shot way fails the way it always did


async def test_a_retry_after_the_failure_time_tries_the_resident_way_again(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "quick", FAKE_NO_APPSERVER=1)
    b.retry_s = 0.2
    await run(b, req("codex", tmp_path))
    b.env.pop("FAKE_NO_APPSERVER")
    await asyncio.sleep(0.4)
    evs = await run(b, req("codex", tmp_path, session="th-exec", new=False))
    assert evs[0]["t"] == "resident" and evs[0]["ok"] is True


async def test_no_pool_or_a_switch_means_the_old_way_without_a_note(tmp_path, monkeypatch):
    b = CodexResidentBackend(cmd=[sys.executable, str(CODEX)], env={"FAKE_MODE": "quick"}, timeout_s=10)
    evs = await run(b, req("codex", tmp_path))  # no pool attached (planning, `agora` CLI)
    assert evs[0]["t"] == "start" and evs[-1]["raw"] == "一次性跑法的回答"
    pool = ResidentPool(tmp_path / "r")
    b.attach_pool(pool)
    monkeypatch.setenv("AGORA_RESIDENT", "0")
    evs = await run(b, req("codex", tmp_path))
    assert evs[0]["t"] == "start" and not pool.procs


async def test_turns_with_pictures_or_a_fork_use_the_one_shot_way_quietly(pool, tmp_path):
    b, log = make("codex", pool, tmp_path, "quick")
    evs = await run(b, req("codex", tmp_path, images=("/tmp/a.png",)))
    assert evs[0]["t"] == "start" and not pool.procs
    b2, log2 = make("pi", pool, tmp_path, "quick")
    r = RunRequest(schema=None, system=None, prompt="x", options=ExecOptions(backend="pi", fork_from="abc"), cwd=str(tmp_path), env={"AGORA_SESSION": "s"})
    evs = await run(b2, r)
    assert evs[0]["t"] == "start" and not pool.procs


def test_the_registered_backends_are_the_resident_ones():
    assert agents.BACKEND_CLASSES["codex"] is CodexResidentBackend and agents.BACKEND_CLASSES["pi"] is PiResidentBackend


# ——— reading the real thing (recorded lines) ———
FIX = Path(__file__).parent / "fixtures" / "agents"


def recorded(path: Path):
    for l in path.read_text().splitlines():
        d = json.loads(l)
        if d.get("dir", "in") == "in" and "line" in d:  # what the CLI wrote (not what the host sent)
            yield d["line"]


def test_the_recorded_codex_turns_read_as_the_one_shot_way_reads_them():
    from server.canvas.adapters.codex import CodexAppStream

    turns, m = [], CodexAppStream("m", None)
    evs: list[dict] = []
    for line in recorded(FIX / "codex-appserver" / "interrupt-then-resume.jsonl"):
        if not isinstance(line, dict) or "method" not in line:
            continue
        evs += m.feed(line, 1)
        if m.done:
            turns.append((m.interrupted, m.error, m.text, [e["t"] for e in evs]))
            m.done = m.interrupted = False
            m.text, evs = "", []
    (t1, t2, t3) = turns
    assert t1[0] is True and t1[1] is None and t1[3][:2] == ["text", "tool_use"] and "tool_result" in t1[3]  # interrupted mid-turn: a clean stop
    assert t2[0] is False and t2[2] == "刚才读到了 f1.txt。" and "usage" in t2[3]
    assert t3[2] == "两件事。"  # the resumed process's turn: the usage baseline came from the resume, so the turn adds only its own
    assert m.usage["outputTokens"] and m.usage["outputTokens"] < 1000


def test_the_recorded_pi_abort_reads_as_aborted_then_the_next_prompt_as_a_normal_turn():
    from server.canvas.adapters.pi import PiStream

    m, ends = PiStream("m", None), []
    for line in recorded(FIX / "pi-rpc" / "abort-then-prompt.jsonl"):
        if isinstance(line, dict) and "type" in line:
            m.feed(line, 1)
            if m.done:
                ends.append(m.error)
                m.done, m.error = False, None
    assert len(ends) == 2 and (ends[0] or "").startswith("pi: aborted") and ends[1] is None
