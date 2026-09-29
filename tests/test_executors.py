"""Canvas edits go to a page that can be seen and can answer (BR1). ``agora canvas read/apply/anim`` are executed
by an open Agora page; the newest connection used to get them all, and a page the browser had frozen in a
background tab took the edit and never answered. Now pages report whether they are visible and when they were
last focused, the server offers a request to the pages in that order, hands it on when one does not take it
within a few seconds, and a page runs it only after it has *claimed* it — so it runs once, wherever it lands."""

import asyncio
import inspect
import json
import time

import pytest

from server.canvas import executors, share_gateway
from server.canvas.executors import Page, order
from server.canvas.project import ProjectStore
from server.canvas.sessions import AgentHub, NoPage


# ——— the order (pure) ———
def page(pid, *, at=0.0, visible=None, focused=0.0, answered=None, failed=None) -> Page:
    return Page(id=pid, at=at, visible=visible, focused_at=focused, answered_at=answered, failed_at=failed)


def test_a_visible_page_comes_before_a_hidden_one_however_new_the_hidden_one_is():
    got = order([page("hidden-new", at=100, visible=False), page("visible-old", at=1, visible=True)])
    assert [p.id for p in got] == ["visible-old", "hidden-new"]


def test_among_pages_of_the_same_visibility_the_last_focused_comes_first_then_the_newest_connection():
    got = order([page("a", at=5, visible=False, focused=10), page("b", at=1, visible=False, focused=50), page("c", at=9, visible=False, focused=0), page("d", at=8, visible=False, focused=0)])
    assert [p.id for p in got] == ["b", "a", "c", "d"]


def test_a_page_that_did_not_answer_last_time_goes_back_until_it_answers_again():
    failed = page("front", at=1, visible=True, failed=100.0)
    other = page("hidden", at=2, visible=False)
    assert [p.id for p in order([failed, other])] == ["hidden", "front"]
    answered_since = page("front", at=1, visible=True, failed=100.0, answered=101.0)
    assert [p.id for p in order([answered_since, other])] == ["front", "hidden"]
    failed_again = page("front", at=1, visible=True, failed=102.0, answered=101.0)
    assert [p.id for p in order([failed_again, other])] == ["hidden", "front"]


def test_a_page_that_never_said_whether_it_is_visible_counts_as_not_visible():
    assert [p.id for p in order([page("unknown", visible=None), page("seen", visible=True)])] == ["seen", "unknown"]


def test_guests_are_not_executors():
    """The share gateway serves the guest routes only: there is no /api/agent/events for a guest to subscribe to as an executor."""
    src = inspect.getsource(share_gateway)
    assert "/api/agent" not in src and "executor" not in src


# ——— the hub ———
@pytest.fixture()
def hub(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    return AgentHub(s)


def take(sub, kind=None):
    """The bridge request waiting in a page's queue (None if there is none)."""
    while not sub.q.empty():
        ev = sub.q.get_nowait()
        if ev.get("t") == "bridge" and (kind is None or ev["kind"] == kind):
            return ev
    return None


async def until_offered(sub, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        ev = take(sub)
        if ev:
            return ev
        await asyncio.sleep(0.01)
    raise AssertionError("nothing was offered")


def page_at(hub, *, visible, focused=0.0):
    sub = hub.subscribe(2)  # 2: a page that claims what it runs
    hub.page_state(sub.id, visible=visible, focused_at=focused)
    return sub


async def test_the_visible_page_gets_the_edit_not_the_newest_connection(hub):
    front = page_at(hub, visible=True)
    back = page_at(hub, visible=False)  # connected later
    task = asyncio.create_task(hub.bridge("apply", {"canvasId": "c1"}, timeout=5, reply_s=0.3))
    req = await until_offered(front)
    assert take(back) is None
    assert hub.claim_bridge(req["rid"], front.id)
    assert hub.bridge_result(req["rid"], {"status": "applied"})
    assert (await task) == {"status": "applied"}


async def test_a_page_that_does_not_take_it_is_skipped_and_its_late_answer_is_dropped(hub):
    silent = page_at(hub, visible=True)  # frozen: never reads its queue
    live = page_at(hub, visible=False)
    t = time.time()
    task = asyncio.create_task(hub.bridge("apply", {"canvasId": "c1"}, timeout=5, reply_s=0.3))
    first = await until_offered(silent)
    second = await until_offered(live)
    assert first["rid"] == second["rid"]  # one request, offered on
    assert hub.claim_bridge(second["rid"], live.id)
    assert not hub.claim_bridge(first["rid"], silent.id)  # the frozen page wakes up later: too late, it must not run it
    hub.bridge_result(second["rid"], {"status": "applied", "by": "live"})
    assert (await task)["by"] == "live" and time.time() - t < 3
    assert not hub.bridge_result(first["rid"], {"status": "applied", "by": "silent"})  # a late answer is dropped


async def test_the_edit_lands_once_a_page_runs_it_only_after_a_claim(hub):
    """The pages here behave like the real ones: run only when the claim was granted."""
    runs: list[str] = []
    a = page_at(hub, visible=True)
    b = page_at(hub, visible=False)
    task = asyncio.create_task(hub.bridge("apply", {"canvasId": "c1"}, timeout=5, reply_s=0.2))
    for who, sub in (("a", a), ("b", b)):
        req = await until_offered(sub)
        if who == "a":
            await asyncio.sleep(0.5)  # a is slow: the server has already offered it on
        if hub.claim_bridge(req["rid"], sub.id):
            runs.append(who)
            hub.bridge_result(req["rid"], {"status": "applied"})
    await task
    assert runs == ["b"]


async def test_a_page_that_took_it_is_waited_for_not_replaced(hub):
    """Taken but no answer: the edit may already be on that page's canvas, so it is not given to another page."""
    a = page_at(hub, visible=True)
    b = page_at(hub, visible=False)
    task = asyncio.create_task(hub.bridge("apply", {"canvasId": "c1"}, timeout=1.0, reply_s=0.2))
    req = await until_offered(a)
    assert hub.claim_bridge(req["rid"], a.id)
    with pytest.raises(NoPage) as e:
        await task
    assert "已接手" in str(e.value) and "先看一眼图" in str(e.value)
    assert take(b) is None


async def test_when_no_page_answers_the_error_says_what_to_do(hub):
    page_at(hub, visible=True)
    page_at(hub, visible=False)
    t = time.time()
    with pytest.raises(NoPage) as e:
        await hub.bridge("apply", {"canvasId": "c1"}, timeout=1.0, reply_s=0.2)
    assert "都没有回应" in str(e.value) and "切到前台" in str(e.value) and "多半" not in str(e.value)
    assert time.time() - t < 2  # inside the total limit


async def test_a_page_that_failed_goes_back_in_the_order_until_it_answers_again(hub):
    front = page_at(hub, visible=True)
    back = page_at(hub, visible=False)

    async def ask(who_answers):
        for sub in (front, back):
            take(sub)  # what earlier requests left in the queues
        task = asyncio.create_task(hub.bridge("read", {"canvasId": "c1"}, timeout=3, reply_s=0.15))
        for sub in hub.executors():
            req = await until_offered(sub) if sub is who_answers else None
            if req:
                assert hub.claim_bridge(req["rid"], sub.id)
                hub.bridge_result(req["rid"], {"scene": {}})
                break
            await asyncio.sleep(0.25)  # this one does not take it
        await task

    assert hub.executors()[0].id == front.id
    await ask(back)  # the visible page is silent: the request moves on to the hidden one, which answers
    assert hub.executors()[0].id == back.id  # so the visible one goes behind
    await ask(back)
    assert hub.executors()[0].id == back.id
    await ask(front)  # now the hidden one is silent and the front one answers once
    assert hub.executors()[0].id == front.id


async def test_a_page_of_the_old_protocol_takes_what_it_is_given_as_before(hub):
    old = hub.subscribe(1)  # ``executor=1``: does not know claims
    hub.page_state(old.id, visible=True, focused_at=0)
    other = page_at(hub, visible=False)
    task = asyncio.create_task(hub.bridge("apply", {"canvasId": "c1"}, timeout=2, reply_s=0.2))
    req = await until_offered(old)
    await asyncio.sleep(0.5)  # longer than one page's turn: the edit stays with it, no second copy
    assert take(other) is None
    hub.bridge_result(req["rid"], {"status": "applied"})
    assert (await task) == {"status": "applied"}


def test_no_page_at_all_is_still_the_old_message(hub):
    async def go():
        with pytest.raises(NoPage, match="没有打开的 Agora 页面"):
            await hub.bridge("read", {"canvasId": "c1"})

    asyncio.run(go())
    assert executors  # the module the hub orders with


# ——— over HTTP ———
async def test_the_routes_a_page_uses_to_report_and_to_claim(tmp_path):
    from fastapi.testclient import TestClient

    from server.canvas.project_router import create_project_app

    s = ProjectStore(tmp_path / "proj")
    s.init()
    app = create_project_app(s.root)
    hub = app.state.hub
    # a page connecting with executor=2 is an executor that claims (not the old kind): the level goes through the route
    from server.canvas.agent_router import create_agent_router

    route = next(r for r in create_agent_router(hub).routes if getattr(r, "path", "") == "/events")

    class Req:
        async def is_disconnected(self):
            return False

    resp = await route.endpoint(request=Req(), executor=2)
    hello = json.loads((await resp.body_iterator.__anext__())[len("data: "):])
    sub = next(x for x in hub.subs if x.id == hello["sub"])
    assert sub.executor == 2
    await resp.body_iterator.aclose()
    c = TestClient(app)
    live = hub.subscribe(2)
    assert c.post(f"/api/agent/events/{live.id}/state", json={"visible": True, "focusedAt": 5}).json() == {"ok": True}
    assert live.visible is True and live.focused_at == 5
    assert c.post("/api/agent/events/nobody/state", json={"visible": True, "focusedAt": 1}).json() == {"ok": False}
    assert c.post("/api/agent/bridge/b-none/claim", json={"sub": live.id}).json() == {"ok": False}
