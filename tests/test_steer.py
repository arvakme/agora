"""Words said while a turn runs go into that turn (ST1) when the CLI can take them; when it cannot, the person
chooses (stop this turn and say it now, or wait for the end) and nothing is queued behind their back.

What each CLI can do was measured on 2026-09-29 (web/docs/cli-adapters.md §插话); the backends here are doubles."""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.adapters import drift
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app
from server.canvas.sessions import AgentHub


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "图"}], "root": {}, "focused": "c1"}, base=None)
    return s


class Slow:
    """A turn that runs until ``release`` is set (or it is cancelled); what the host writes to a two-way turn's stdin lands in ``lines``."""

    def __init__(self, name, calls, release):
        self.name, self.calls, self.release = name, calls, release
        self.lines: list[dict] = []

    async def run(self, req):
        self.calls.append(req)
        yield {"t": "start", "at": 1, "backend": self.name, "model": None, "session": "n-1"}
        yield {"t": "tool_use", "at": 2, "id": "tu-1", "name": "Read", "input": {"file_path": "f1"}}
        while not self.release.is_set():
            if req.control is not None:
                try:
                    self.lines.append(await asyncio.wait_for(req.control.queue.get(), 0.05))
                except TimeoutError:
                    pass
            else:
                await asyncio.sleep(0.05)
        yield {"t": "result", "at": 3, "raw": "好", "usage": {"costUsd": None}, "session": None, "backend": self.name}


async def until(q, pred, timeout=10.0):
    got, end = [], time.time() + timeout
    while time.time() < end:
        try:
            ev = await asyncio.wait_for(q.get(), 0.2)
        except TimeoutError:
            continue
        got.append(ev)
        if pred(ev):
            return got
    raise AssertionError(f"timed out; saw {[e.get('t') for e in got]}")


async def running(store, kind):
    calls, release = [], asyncio.Event()
    backend = Slow(kind, calls, release)
    hub = AgentHub(store, backend_factory=lambda k: backend)
    store.bind("s-1", agent=kind, model="", effort="")
    sub = hub.subscribe(executor=False)
    first = hub.send("s-1", "读 5 个文件")
    await until(sub.q, lambda e: e.get("t") == "run" and e["event"].get("t") == "tool_use")
    return hub, sub, backend, calls, release, first


# ——— what each CLI can do ———
def test_claude_codex_and_pi_can_take_words_mid_turn_and_the_others_say_why():
    infos = {i["kind"]: i for i in drift.adapter_infos(with_versions=False)}
    for kind in ("claude", "codex", "pi"):
        assert infos[kind]["caps"]["steer"] is True and infos[kind]["caps"]["noSteer"] == "", kind
    for kind, i in infos.items():
        if kind not in ("claude", "codex", "pi"):
            assert i["caps"]["steer"] is False and len(i["caps"]["noSteer"]) > 8, kind


def test_the_adapters_api_carries_the_ability(store):
    c = TestClient(create_project_app(store.root))
    by = {a["kind"]: a for a in c.get("/api/agent/adapters?versions=0").json()}
    assert by["claude"]["caps"]["steer"] is True and by["devin"]["caps"]["steer"] is False and by["devin"]["caps"]["noSteer"]


# ——— it can: the words go into the running turn ———
async def test_a_steerable_cli_gets_the_words_at_once_and_the_step_is_marked(store):
    hub, sub, backend, calls, release, first = await running(store, "claude")
    try:
        assert first["how"] == "turn"
        r = hub.send("s-1", "停一下，只读前两个")
        assert r["how"] == "steer" and r["route"] == "headless" and r["sendId"] != first["sendId"]
        for _ in range(40):
            if backend.lines:
                break
            await asyncio.sleep(0.05)
        assert backend.lines == [{"type": "user", "message": {"role": "user", "content": "停一下，只读前两个"}}]
        evs = await until(sub.q, lambda e: e.get("t") == "steered")
        st = evs[-1]
        assert st["sendId"] == r["sendId"] and st["afterTool"] == "tu-1" and st["text"].startswith("停一下")
        item = next(i for i in hub._get("s-1").items.values() if i.get("tone") == "steer")
        assert item["kind"] == "notice" and item["at"] and "停一下" in item["text"] and item["afterId"] == "tu-1"
        assert hub.status("s-1")["queued"] == 0 and len(calls) == 1  # no second turn, nothing waits
    finally:
        release.set()
        await hub.close()


async def test_steer_also_works_for_a_dispatch_and_a_comment_hand_off(store):
    """Both go through ``hub.send`` without a mode: a running steerable turn takes them in."""
    hub, sub, backend, calls, release, _ = await running(store, "claude")
    try:
        r = hub.send("s-1", "关于你派的 T-1：先停", mode="auto")
        assert r["how"] == "steer"
    finally:
        release.set()
        await hub.close()


async def test_an_idle_session_just_starts_a_turn(store):
    calls, release = [], asyncio.Event()
    release.set()
    hub = AgentHub(store, backend_factory=lambda k: Slow(k, calls, release))
    store.bind("s-1", agent="claude", model="", effort="")
    try:
        assert hub.send("s-1", "hi")["how"] == "turn"
    finally:
        await hub.close()


# ——— it cannot: the person chooses ———
async def test_a_cli_that_cannot_steer_refuses_a_steer_and_says_why(store):
    hub, sub, backend, calls, release, _ = await running(store, "grok")
    try:
        with pytest.raises(ValueError, match="不能"):
            hub.send("s-1", "停一下", mode="steer")
        assert hub.status("s-1")["queued"] == 0
    finally:
        release.set()
        await hub.close()


async def test_interrupt_then_say_it_stops_the_turn_and_sends_the_words_as_a_new_one(store):
    hub, sub, backend, calls, release, first = await running(store, "grok")
    try:
        r = hub.send("s-1", "停一下，只读前两个", mode="interrupt")
        assert r["how"] == "interrupt"
        evs = await until(sub.q, lambda e: e.get("t") == "done")
        assert evs[-1]["sendId"] == first["sendId"] and evs[-1]["error"] == "已停止"
        release.set()  # the second turn may end
        evs = await until(sub.q, lambda e: e.get("t") == "done" and e["sendId"] == r["sendId"])
        assert len(calls) == 2 and "停一下，只读前两个" in calls[1].prompt
        assert hub.status("s-1")["queued"] == 0
    finally:
        release.set()
        await hub.close()


async def test_wait_keeps_the_old_queue_and_the_words_go_after_the_turn(store):
    hub, sub, backend, calls, release, first = await running(store, "grok")
    try:
        r = hub.send("s-1", "之后再说", mode="wait")
        assert r["how"] == "queued" and hub.status("s-1")["queued"] == 1 and len(calls) == 1
        release.set()
        await until(sub.q, lambda e: e.get("t") == "done" and e["sendId"] == r["sendId"])
        assert len(calls) == 2 and "之后再说" in calls[1].prompt
    finally:
        release.set()
        await hub.close()


async def test_a_caller_that_names_no_mode_keeps_the_old_queue_for_a_cli_that_cannot_steer(store):
    """Dispatch and the CLI's own callers are not put to a choice: unchanged for them."""
    hub, sub, backend, calls, release, first = await running(store, "grok")
    try:
        r = hub.send("s-1", "排着")
        assert r["how"] == "queued" and hub.status("s-1")["queued"] == 1
    finally:
        release.set()
        await hub.close()


async def test_the_send_api_takes_the_mode(store):
    app = create_project_app(store.root)
    with TestClient(app) as c:
        store.bind("s-9", agent="codex", model="", effort="")
        r = c.post("/api/agent/sessions/s-9/send", json={"text": "x", "mode": "nope"})
        assert r.status_code in (400, 422)
