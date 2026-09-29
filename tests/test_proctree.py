"""Stopping a turn ends the whole tree it started (KT1). Agent CLIs put their shells in other process groups
(Node ``detached``, ``setsid``) and some of what runs there ignores SIGTERM: the group signal alone left
``sleep`` and test commands behind (measured with the real Grok and Cursor, round-04/evidence/KT1)."""

import asyncio
import json
import os
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from server.canvas import agents, proctree
from server.canvas.runner import ExecOptions, RunRequest

# A fake CLI: starts a child in a new session that ignores SIGTERM and has its own child (the "shell → test command"
# chain), records their pids, then either waits (a turn running) or exits at once (the CLI dies first).
FAKE = textwrap.dedent(
    """\
    import json, os, signal, subprocess, sys, time
    out = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "wait"
    child_code = (
        "import os, signal, subprocess, sys, time\\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\\n"
        "g = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)'])\\n"
        "open(sys.argv[1], 'w').write(str(os.getpid()) + ' ' + str(g.pid))\\n"
        "time.sleep(120)\\n"
    )
    kid = subprocess.Popen([sys.executable, "-c", child_code, out + ".kids"], start_new_session=True)
    for _ in range(100):
        if os.path.exists(out + ".kids") and open(out + ".kids").read().count(" "):
            break
        time.sleep(0.05)
    open(out, "w").write(json.dumps({"cli": os.getpid(), "kids": open(out + ".kids").read().split()}))
    print(json.dumps({"type": "thread.started", "thread_id": "t"}), flush=True)
    if mode == "exit":  # dies when told to (the test looks at the tree first)
        while not os.path.exists(out + ".go"):
            time.sleep(0.05)
        sys.exit(0)
    time.sleep(120)
    """
)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(st) and not st.startswith("Z")


def gone(pids, timeout=5.0) -> list[int]:
    end = time.time() + timeout
    left = [p for p in pids if alive(p)]
    while left and time.time() < end:
        time.sleep(0.05)
        left = [p for p in left if alive(p)]
    return left


@pytest.fixture()
def fake(tmp_path):
    script = tmp_path / "fake_cli.py"
    script.write_text(FAKE)
    made: list[int] = []
    yield script, tmp_path / "pids.json", made
    for p in made:  # whatever a failing test left
        try:
            os.kill(p, signal.SIGKILL)
        except ProcessLookupError:
            pass


def read_pids(path: Path, made: list[int]) -> dict:
    for _ in range(200):
        if path.exists() and path.read_text():
            d = json.loads(path.read_text())
            made += [d["cli"], *map(int, d["kids"])]
            return {"cli": d["cli"], "kids": list(map(int, d["kids"]))}
        time.sleep(0.05)
    raise AssertionError("the fake CLI did not start")


def test_stop_ends_the_group_the_detached_children_and_what_ignores_sigterm(fake):
    script, out, made = fake
    p = subprocess.Popen([sys.executable, str(script), str(out)], start_new_session=True, stdout=subprocess.DEVNULL)
    pids = read_pids(out, made)
    assert len(pids["kids"]) == 2 and all(alive(k) for k in pids["kids"])
    assert os.getpgid(pids["kids"][0]) != p.pid  # in another group: the old killpg never reached it
    t = time.time()
    proctree.stop(p.pid, grace=1.0)
    p.wait(timeout=5)
    assert gone([p.pid, *pids["kids"]]) == []
    assert time.time() - t < 6  # the grace, then SIGKILL


def test_stop_still_collects_the_children_when_the_cli_died_first(fake):
    script, out, made = fake
    p = subprocess.Popen([sys.executable, str(script), str(out), "exit"], start_new_session=True, stdout=subprocess.DEVNULL)
    watch = proctree.Watch(p.pid)
    pids = read_pids(out, made)
    watch.update()  # noticed while the turn ran: the CLI's children are re-parented to init once it is gone
    assert len(watch.seen) >= 2
    Path(str(out) + ".go").write_text("")
    p.wait(timeout=5)
    assert all(alive(k) for k in pids["kids"])
    proctree.stop(p.pid, watch.seen, grace=1.0)
    assert gone(pids["kids"]) == []


def test_stop_leaves_other_processes_alone(fake):
    script, out, made = fake
    bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
    made.append(bystander.pid)
    p = subprocess.Popen([sys.executable, str(script), str(out)], start_new_session=True, stdout=subprocess.DEVNULL)
    read_pids(out, made)
    proctree.stop(p.pid, grace=1.0)
    p.wait(timeout=5)
    assert alive(bystander.pid)
    bystander.kill()


def test_a_remembered_pid_that_now_belongs_to_another_process_is_not_killed(fake):
    """pids are reused: what was seen is only stopped while it is still the process that was seen (same start time)."""
    script, out, made = fake
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
    made.append(other.pid)
    p = subprocess.Popen([sys.executable, str(script), str(out)], start_new_session=True, stdout=subprocess.DEVNULL)
    read_pids(out, made)
    proctree.stop(p.pid, {other.pid: "Mon Jan  1 00:00:00 2001"}, grace=1.0)
    p.wait(timeout=5)
    assert alive(other.pid)
    other.kill()


async def test_the_backends_stop_path_ends_the_tree_of_a_cancelled_turn(fake):
    script, out, made = fake
    b = agents.CodexBackend([sys.executable, str(script), str(out)])
    b.timeout_s = 60
    req = RunRequest(schema=None, system=None, prompt="p", options=ExecOptions(backend="codex", model=""), cwd=str(out.parent))

    async def consume():
        async for _ in b.run(req):
            pass

    task = asyncio.create_task(consume())
    pids = await asyncio.to_thread(read_pids, out, made)
    await asyncio.sleep(1.5)  # the watcher looks once a second
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await asyncio.to_thread(gone, [pids["cli"], *pids["kids"]]) == []


def test_a_leftover_turn_of_a_dead_server_is_ended_with_its_tree(fake):
    from server.canvas.sessions import _stop_process

    script, out, made = fake
    argv = [sys.executable, str(script), str(out)]
    p = subprocess.Popen(argv, start_new_session=True, stdout=subprocess.DEVNULL)
    pids = read_pids(out, made)
    _stop_process(p.pid, argv)
    p.wait(timeout=10)
    assert gone(pids["kids"]) == []


def test_snapshots_are_shared_between_watches_for_a_moment(monkeypatch):
    """RVF-D G: several running turns each polled `ps` every second; within a short time they share one snapshot."""
    calls = []
    real = subprocess.run

    def counting(*a, **k):
        calls.append(a[0][0])
        return real(*a, **k)

    monkeypatch.setattr(proctree.subprocess, "run", counting)
    proctree.snapshot(max_age=0)  # a fresh one
    n = len(calls)
    for _ in range(5):
        proctree.snapshot(max_age=1.0)
    assert len(calls) == n  # five more reads, no more `ps`
    proctree.snapshot(max_age=0)
    assert len(calls) == n + 1  # a caller that needs the truth (stopping) can ask for a fresh one


def test_the_grace_period_polls_gently():
    assert proctree.POLL_S >= 0.2  # not the old 50 ms: an ignored SIGTERM used to cost ~100 `ps` in five seconds


def test_the_root_is_recognised_by_its_start_time_too():
    """A root pid the system has reused for another process (a different start time) is not signalled."""
    snap = proctree.snapshot(max_age=0)
    me = os.getpid()
    start = snap[me][2]
    w = proctree.Watch(me)
    assert w.root_start == start
    assert proctree._alive(me, snap, start) and not proctree._alive(me, snap, "Thu Jan  1 00:00:00 1970")


def test_stop_leaves_a_root_pid_alone_when_its_start_time_says_it_is_someone_else():
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        time.sleep(0.2)
        proctree.stop(other.pid, None, 0.5, root_start="Thu Jan  1 00:00:00 1970")  # the turn's root had another start time: the pid was reused
        assert other.poll() is None  # not signalled
        proctree.stop(other.pid, None, 2.0, root_start=proctree.snapshot()[other.pid][2])  # ... while the real one is ended
        other.wait(5)
    finally:
        if other.poll() is None:
            other.kill()
