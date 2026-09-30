"""The hub and the resident way (ST2): steer only when the process can take it, the reason on the session, interrupt the soft way,
the pool closed with the hub and what a dead server left stopped by the next one."""

import asyncio
import json
import os
import subprocess
import sys
import time

import pytest

from server.canvas import agents
from server.canvas.project import ProjectStore
from server.canvas.resident import ResidentPool
from server.canvas.sessions import AgentHub
from tests.test_steer import Slow, until  # noqa: F401  (the running-turn double)


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "图"}], "root": {}, "focused": "c1"}, base=None)
    return s


class Resident(Slow):
    """A resident backend's double: says at the start whether the resident way is in use (``ok``/``why``)."""

    def __init__(self, name, calls, release, resident):
        super().__init__(name, calls, release)
        self.resident = resident

    async def run(self, req):
        first = True
        async for ev in super().run(req):
            if first and self.resident is not None:
                yield {"t": "resident", "at": 0, **self.resident}
            first = False
            yield ev


async def running(store, kind, resident):
    calls, release = [], asyncio.Event()
    backend = Resident(kind, calls, release, resident)
    hub = AgentHub(store, backend_factory=lambda k: backend)
    store.bind("s-1", agent=kind, model="", effort="")
    sub = hub.subscribe(executor=False)
    first = hub.send("s-1", "读 5 个文件")
    await until(sub.q, lambda e: e.get("t") == "run" and e["event"].get("t") == "tool_use")
    return hub, sub, backend, calls, release, first


@pytest.mark.parametrize("kind", ["codex", "pi"])
async def test_a_resident_turn_takes_the_words_into_the_turn(store, kind):
    hub, sub, backend, calls, release, _ = await running(store, kind, {"ok": True})
    try:
        assert hub.status("s-1")["steer"] is True and hub.status("s-1")["steerWhy"] is None
        r = hub.send("s-1", "停一下，只读前两个")
        assert r["how"] == "steer"
        for _ in range(40):
            if backend.lines:
                break
            await asyncio.sleep(0.05)
        assert backend.lines == [{"type": "user", "message": {"role": "user", "content": "停一下，只读前两个"}}]
        st = (await until(sub.q, lambda e: e.get("t") == "steered"))[-1]
        assert st["afterTool"] == "tu-1" and hub.status("s-1")["queued"] == 0 and len(calls) == 1
    finally:
        release.set()
        await hub.close()


async def test_before_the_process_says_it_is_resident_words_wait_rather_than_get_lost(store):
    hub, sub, backend, calls, release, _ = await running(store, "codex", None)  # no `resident` event (yet)
    try:
        assert hub.status("s-1")["steer"] is None
        r = hub.send("s-1", "太早了")
        assert r["how"] == "queued" and not backend.lines
    finally:
        release.set()
        await hub.close()


async def test_a_turn_that_fell_back_says_why_and_cannot_be_steered(store):
    why = "app-server 起来就退出了：unrecognized subcommand"
    hub, sub, backend, calls, release, _ = await running(store, "codex", {"ok": False, "why": why})
    try:
        s = hub.status("s-1")
        assert s["steer"] is False and s["steerWhy"] == why
        with pytest.raises(ValueError, match="app-server"):
            hub.send("s-1", "停一下", mode="steer")
        assert hub.send("s-1", "排着")["how"] == "queued"  # auto: the old queue
        r = hub.send("s-1", "停下改说", mode="interrupt")
        assert r["how"] == "interrupt"
        t = time.time()
        await until(sub.q, lambda e: e.get("t") == "done" and e.get("error") == "已停止")
        assert time.time() - t < 5  # a one-shot process is stopped at once, not after the two-way grace
    finally:
        release.set()
        await hub.close()


async def test_the_reason_stays_until_a_turn_is_resident_again(store):
    hub, sub, backend, calls, release, _ = await running(store, "pi", {"ok": False, "why": "rpc 不支持"})
    try:
        release.set()
        await until(sub.q, lambda e: e.get("t") == "done")
        s = hub.status("s-1")
        assert s["running"] is False and s["steerWhy"] == "rpc 不支持" and s["steer"] is False
        backend.resident = {"ok": True}
        release.clear()
        hub.send("s-1", "再来")
        await until(sub.q, lambda e: e.get("t") == "run" and e["event"].get("t") == "tool_use")
        assert hub.status("s-1")["steerWhy"] is None and hub.status("s-1")["steer"] is True
    finally:
        release.set()
        await hub.close()


async def test_interrupt_of_a_resident_turn_asks_the_process_first(store):
    hub, sub, backend, calls, release, _ = await running(store, "codex", {"ok": True})
    try:
        assert hub.interrupt("s-1") is True
        for _ in range(40):
            if backend.lines:
                break
            await asyncio.sleep(0.05)
        assert backend.lines[0]["type"] == "control_request" and backend.lines[0]["request"]["subtype"] == "interrupt"
        assert not hub._get("s-1").run.done()  # it ends when the process answers (or after the grace)
    finally:
        release.set()
        await hub.close()


async def test_claude_is_as_before(store):
    hub, sub, backend, calls, release, _ = await running(store, "claude", None)
    try:
        assert hub.status("s-1")["steer"] is True
        assert hub.send("s-1", "停一下")["how"] == "steer"
    finally:
        release.set()
        await hub.close()


async def test_a_cli_without_steer_reports_none(store):
    hub, sub, backend, calls, release, _ = await running(store, "grok", None)
    try:
        assert hub.status("s-1")["steer"] is False
    finally:
        release.set()
        await hub.close()


async def test_the_hub_gives_its_pool_to_a_resident_backend_and_closes_it(store, tmp_path):
    calls, release = [], asyncio.Event()
    release.set()

    class B(Resident):
        pool = None

        def attach_pool(self, pool):
            self.pool = pool

    backend = B("codex", calls, release, {"ok": True})
    hub = AgentHub(store, backend_factory=lambda k: backend)
    store.bind("s-1", agent="codex", model="", effort="")
    sub = hub.subscribe(executor=False)
    hub.send("s-1", "hi")
    await until(sub.q, lambda e: e.get("t") == "done")
    assert backend.pool is hub.residents
    closed = []

    async def close_all():
        closed.append(1)

    hub.residents.close_all = close_all
    await hub.close()
    assert closed == [1]


async def test_a_server_that_starts_stops_what_a_dead_one_left_and_says_nothing_about_a_turn(store):
    sleeper = subprocess.Popen(["sleep", "300"], start_new_session=True)
    d = store.run_dir / "residents"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{sleeper.pid}.json").write_text(json.dumps({"pid": sleeper.pid, "argv": ["sleep", "300"], "server": 2**22 + 7, "key": "s-1"}))
    try:
        hub = AgentHub(store, backend_factory=lambda k: None)
        hub.ensure_started()
        for _ in range(60):
            if sleeper.poll() is not None:
                break
            await asyncio.sleep(0.1)
        assert sleeper.poll() is not None and not list(d.glob("*.json"))
        assert not hub._get("s-1").notes  # no turn was open: nothing to report
        await hub.close()
    finally:
        if sleeper.poll() is None:
            sleeper.kill()
        sleeper.wait()
