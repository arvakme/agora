"""Agent sessions: the locked binding, routing a message (headless turn vs. terminal pane),
following the native log, and the canvas bridge that `agora canvas` talks to."""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.project import Locked, ProjectStore
from server.canvas.project_router import create_project_app
from server.canvas.sessions import AgentHub, NoPage, agora_prompt, resolve_canvas
from server.canvas.transcript import MARKER

REPO = Path(__file__).resolve().parents[1]
TUI = Path(__file__).parent / "fake_agent_tui.py"

SCENE = {
    "elements": [
        {"id": "redis", "type": "rectangle", "x": 10, "y": 20, "width": 160, "height": 64, "version": 3, "groupIds": [], "boundElements": [{"type": "text", "id": "redis-t"}]},
        {"id": "redis-t", "type": "text", "text": "Redis", "containerId": "redis", "x": 0, "y": 0, "width": 1, "height": 1, "version": 2, "groupIds": []},
        {"id": "gone", "type": "rectangle", "x": 0, "y": 0, "width": 1, "height": 1, "version": 1, "isDeleted": True, "groupIds": []},
    ]
}


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    """Binding checks the model and effort against the real CLIs' catalogs (test_agent_models.py covers
    that with recorded outputs); here it must not spawn claude / pi."""
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "架构图"}], "root": {}, "focused": "c1"}, base=None)
    s.write("canvas", "c1", SCENE, base=None)
    return s


# ——— binding ———
def test_binding_is_fixed_once_chosen(store):
    b = store.bind("s-1", agent="claude", model="sonnet", effort="high", native_id="n-1")
    assert b["agent"] == "claude" and b["nativeId"] == "n-1"
    assert store.bind("s-1", agent="claude", model="sonnet", effort="high")["nativeId"] == "n-1"  # same choice: fine
    for other in ({"agent": "pi"}, {"agent": "claude", "model": "opus", "effort": "high"}, {"agent": "claude", "model": "sonnet", "effort": "low"}):
        with pytest.raises(Locked):
            store.bind("s-1", **{"model": "", "effort": "", **other})
    with pytest.raises(Locked):
        store.bind("s-1", agent="claude", model="sonnet", effort="high", native_id="n-2")
    with pytest.raises(ValueError):
        store.bind("s-2", agent="kimi")
    store.bind("s-3", agent="codex")
    assert store.set_native("s-3", "t-9")["nativeId"] == "t-9"
    with pytest.raises(Locked):
        store.set_native("s-3", "t-10")
    assert set(store.snapshot()["bindings"]) == {"s-1", "s-3"}


def test_binding_api_locks_and_goes_with_the_session(store):
    c = TestClient(create_project_app(store.root))
    r = c.put("/api/agent/sessions/s-a", json={"agent": "claude", "model": "sonnet", "effort": "high"})
    assert r.status_code == 200 and len(r.json()["nativeId"]) == 36  # Claude takes a preassigned uuid
    assert c.put("/api/agent/sessions/s-a", json={"agent": "codex"}).json()["locked"] is True
    assert c.put("/api/agent/sessions/s-a", json={"agent": "claude", "model": "opus", "effort": "high"}).status_code == 409
    assert c.put("/api/agent/sessions/s-b", json={"agent": "codex"}).json()["nativeId"] is None  # Codex assigns its own
    assert (store.root / ".claude" / "skills" / "agora-canvas").exists()  # skill linked on demand
    native = store.read_binding("s-a")["nativeId"]
    m = c.post("/api/project/trash/session/s-a", json={}).json()
    assert m["terminalClosed"] is False and store.read_binding("s-a") is None  # the binding goes to the trash with it
    # Restoring brings the same binding back: the same native session, nothing re-bound.
    assert c.post(f"/api/project/trash/{m['trashId']}/restore").json()["binding"]["nativeId"] == native


# ——— headless routing ———
class FakeBackend:
    name = "codex"

    def __init__(self, calls):
        self.calls = calls

    async def run(self, req):
        self.calls.append(req)
        yield {"t": "start", "at": 1, "backend": "codex", "model": None, "session": req.options.session}
        yield {"t": "tool_use", "at": 2, "id": "x", "name": "shell", "input": {"command": "agora canvas read"}}
        yield {"t": "result", "at": 3, "raw": "改好了", "usage": {"costUsd": None}, "session": req.options.session or "t-new", "backend": "codex"}


async def drain(q, until, timeout=10.0):
    got = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ev = await asyncio.wait_for(q.get(), 0.2)
        except TimeoutError:
            continue
        got.append(ev)
        if until(ev):
            return got
    raise AssertionError(f"timed out; saw {[e.get('t') for e in got]}")


async def test_headless_turn_in_project_dir_learns_codex_id(store, tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    calls = []
    hub = AgentHub(store, backend_factory=lambda kind: FakeBackend(calls))
    store.bind("s-1", agent="codex", model="gpt-6-sol", effort="low")
    sub = hub.subscribe(executor=False)
    try:
        r = hub.send("s-1", agora_prompt("把 Redis 改成集群", canvas_id="c1", canvas_name="架构图"))
        assert r["route"] == "headless"
        evs = await drain(sub.q, lambda e: e.get("t") == "done")
        done = evs[-1]
        assert done["text"] == "改好了" and done["sendId"] == r["sendId"] and done["route"] == "headless"
        req = calls[0]
        assert req.cwd == str(store.root) and req.schema is None
        assert req.options.model == "gpt-6-sol" and req.options.effort == "low" and req.options.session is None
        assert req.env == {"AGORA_PROJECT": str(store.root), "AGORA_SESSION": "s-1", "AGORA_CANVAS": "c1"}
        assert req.prompt.startswith("把 Redis 改成集群\n\n" + MARKER)
        assert store.read_binding("s-1")["nativeId"] == "t-new"
        last_status = [e for e in evs if e["t"] == "status"][-1]
        assert last_status["running"] is False
        assert store.read_binding("s-1")["started"] is True  # it ran: from now on only ever resumed
        # The next turn resumes the id Codex handed out (its rollout is on disk).
        rollout = tmp_path / "codex-home" / "sessions" / "2026" / "09" / "28" / "rollout-2026-09-28T10-00-00-t-new.jsonl"
        rollout.parent.mkdir(parents=True)
        rollout.write_text("")
        hub.send("s-1", "再加一个")
        await drain(sub.q, lambda e: e.get("t") == "done")
        assert calls[1].options.session == "t-new"
    finally:
        await hub.close()


# ——— canvas bridge ———
async def test_read_falls_back_to_files_and_apply_needs_a_page(store):
    hub = AgentHub(store)
    got = await hub.canvas_read(None, None)
    assert got["source"] == "file" and got["canvas"] == {"id": "c1", "name": "架构图"}
    assert got["scene"]["nodes"] == [{"id": "redis", "type": "rectangle", "label": "Redis", "x": 10, "y": 20, "width": 160, "height": 64}]
    saved = json.loads((store.run_dir / "reads" / f"{got['base']}.json").read_text())
    assert saved["versions"] == {"redis": "3.2", "redis-t": "2"}
    with pytest.raises(NoPage):
        await hub.canvas_apply(None, None, got["base"], [{"op": "update_text", "id": "redis", "text": "Redis 集群"}], None)
    with pytest.raises(ValueError, match="unknown base"):
        await hub.canvas_apply(None, None, "r-1-nope", [], None)
    bad = await hub.canvas_anim(None, None, {"title": "x", "nodes": [], "steps": []})
    assert bad["status"] == "invalid" and bad["errors"]  # structural check before any page is involved


async def test_apply_goes_to_the_newest_page_and_back(store):
    hub = AgentHub(store)
    old = hub.subscribe(executor=True)
    page = hub.subscribe(executor=True)
    viewer = hub.subscribe(executor=False)
    seen = []

    async def act():
        # The newest page answers: a live read (its own versions), then the apply.
        while True:
            req = (await drain(page.q, lambda e: e.get("t") == "bridge"))[-1]
            seen.append(req["kind"])
            if req["kind"] == "read":
                hub.bridge_result(req["rid"], {"canvasId": "c1", "name": "架构图", "scene": {"nodes": [], "arrows": [], "frames": []}, "versions": {"redis": "4.2"}})
                continue
            assert req["kind"] == "apply" and req["canvasId"] == "c1" and req["sessionId"] == "s-1"
            assert req["versions"] == {"redis": "4.2"} and req["plan"]["note"] == "改名"
            hub.bridge_result(req["rid"], {"status": "applied", "summary": ["改文字"], "turnId": "t-1", "batchId": "b-1"})
            return

    task = asyncio.create_task(act())
    got = await hub.canvas_read("架构图", None)  # by name
    assert got["source"] == "page"
    res = await hub.canvas_apply(None, "s-1", got["base"], [{"op": "update_text", "id": "redis", "text": "Redis 集群"}], "改名")
    await task
    assert res["status"] == "applied" and res["batchId"] == "b-1" and seen == ["read", "apply"]
    for other in (old, viewer):
        assert not any(e.get("t") == "bridge" for e in [other.q.get_nowait() for _ in range(other.q.qsize())])


def test_resolve_canvas(store):
    assert resolve_canvas(store) == "c1"
    assert resolve_canvas(store, "架构图") == "c1"
    with pytest.raises(ValueError, match="unknown canvas"):
        resolve_canvas(store, "nope")


# ——— terminal pane: delivery and log following ———
@pytest.mark.skipif(shutil.which("tmux") is None, reason="needs tmux")
async def test_terminal_pane_both_directions(store, tmp_path, monkeypatch):
    log = tmp_path / "native.jsonl"
    monkeypatch.setattr(agents, "locate_log", lambda kind, nid, root=None, home=None, hint=None: agents.LogLookup("found", log, (log,)) if nid else agents.LogLookup("missing"))
    monkeypatch.setattr(agents, "interactive_argv", lambda *a, **k: [sys.executable, str(TUI), str(log)])
    hub = AgentHub(store)
    store.bind("s-t", agent="pi", native_id="n-1")
    sub = hub.subscribe(executor=False)
    hub.ensure_started()
    try:
        opened = await asyncio.to_thread(hub.open_terminal, "s-t", launch=False)
        assert opened["created"] and hub.terms.socket in opened["attach"] and "attach -t agora-s-t" in opened["attach"]
        assert "agora-s-t" in hub.terms.sessions()
        for _ in range(50):
            if "fake agent ready" in hub.terms.capture("s-t"):
                break
            await asyncio.sleep(0.1)

        # Agora → terminal: the message is pasted into the pane, the pane's log shows it, the turn ends.
        r = hub.send("s-t", agora_prompt("从面板发的一句", canvas_id="c1", canvas_name="架构图"))
        assert r["route"] == "terminal"
        evs = await drain(sub.q, lambda e: e.get("t") == "done", timeout=20)
        assert any(e["t"] == "delivered" and e["route"] == "terminal" for e in evs)
        assert evs[-1]["text"] == "echo: 从面板发的一句" and evs[-1]["sendId"] == r["sendId"]
        users = [i for e in evs if e["t"] == "transcript" for i in e["items"] if i["kind"] == "user"]
        assert users[-1]["text"] == "从面板发的一句" and users[-1]["source"] == "agora"

        # Terminal → Agora: typing in the pane shows up in the transcript as a terminal message.
        subprocess.run([hub.terms.tmux, "-L", hub.terms.socket, "send-keys", "-t", "=agora-s-t:", "-l", "在终端里打的字"], check=True)
        subprocess.run([hub.terms.tmux, "-L", hub.terms.socket, "send-keys", "-t", "=agora-s-t:", "Enter"], check=True)
        evs = await drain(sub.q, lambda e: e.get("t") == "transcript" and any(i.get("text") == "echo: 在终端里打的字" for i in e["items"]), timeout=20)
        typed = [i for e in evs if e["t"] == "transcript" for i in e["items"] if i["kind"] == "user"]
        assert typed[-1] == {**typed[-1], "text": "在终端里打的字", "source": "terminal"}

        # While the agent is answering, a new message waits instead of being typed over it.
        lv = hub.live["s-t"]
        lv.state.busy = True
        hub.send("s-t", "排队的一句")
        await hub._tick_async()
        assert lv.pane and hub.status("s-t")["held"].startswith("agent 正在回复")
        lv.state.busy = False
        evs = await drain(sub.q, lambda e: e.get("t") == "done", timeout=20)
        assert evs[-1]["text"] == "echo: 排队的一句"

        # The pane ends → the next message goes headless (checked via routing only).
        assert hub.terms.socket_path().exists()
        await asyncio.to_thread(hub.close_terminal, "s-t")
        assert not hub.terms.alive("s-t") and hub.status("s-t")["terminal"]["alive"] is False
    finally:
        await hub.close()
        hub.terms.kill_server()
    assert hub.terms.sessions() == [] and not hub.terms.socket_path().exists()


class FakeSeedmux:
    """Seedmux's team bridge (``GET /panes``, ``POST /spawn``) over a private tmux server: a spawned
    pane is a tmux session ``smx-<id>`` whose shell gets ``launch`` typed in, like the app does."""

    def __init__(self, tmux: str):
        import tempfile
        import threading
        import uuid
        from http.server import BaseHTTPRequestHandler, HTTPServer

        self.dir = Path(tempfile.mkdtemp(prefix="smx", dir="/tmp"))  # tmux socket paths must be short
        self.sock, self.tmux, self.spawned = self.dir / "s.sock", tmux, []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.headers.get("X-Token") != "tok":
                    return self._send(401, {"ok": False})
                self._send(200, {"ok": True, "panes": [{"paneId": p} for p in fake.spawned]})

            def do_POST(self):
                if self.headers.get("X-Token") != "tok" or self.path != "/spawn":
                    return self._send(401, {"ok": False})
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                pane = str(uuid.uuid4()).upper()
                t = [fake.tmux, "-S", str(fake.sock), "-f", "/dev/null"]
                subprocess.run([*t, "new-session", "-d", "-s", f"smx-{pane}", "-x", "160", "-y", "40", "-c", body["cwd"], "/bin/sh"], check=True)
                subprocess.run([*t, "send-keys", "-t", f"=smx-{pane}:", "-l", body["launch"]], check=True)
                subprocess.run([*t, "send-keys", "-t", f"=smx-{pane}:", "Enter"], check=True)
                fake.spawned.append(pane)
                fake.bodies.append(body)
                self._send(200, {"ok": True, "paneId": pane})

        self.bodies: list[dict] = []
        self.http = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.cfg = self.dir / "team-bridge.json"
        self.cfg.write_text(json.dumps({"port": self.http.server_address[1], "token": "tok"}))

    def sessions(self) -> list[str]:
        r = subprocess.run([self.tmux, "-S", str(self.sock), "list-sessions", "-F", "#{session_name}"], capture_output=True)
        return r.stdout.decode().split() if r.returncode == 0 else []

    def close(self):
        self.http.shutdown()
        subprocess.run([self.tmux, "-S", str(self.sock), "kill-server"], capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


@pytest.mark.skipif(shutil.which("tmux") is None, reason="needs tmux")
async def test_terminal_in_seedmux_both_directions(store, tmp_path, monkeypatch):
    from server.canvas.seedmux import Seedmux
    from server.canvas.terminal import Terminals

    log = tmp_path / "native.jsonl"
    monkeypatch.setattr(agents, "locate_log", lambda kind, nid, root=None, home=None, hint=None: agents.LogLookup("found", log, (log,)) if nid else agents.LogLookup("missing"))
    monkeypatch.setattr(agents, "interactive_argv", lambda *a, **k: [sys.executable, str(TUI), str(log)])
    fake = FakeSeedmux(shutil.which("tmux"))
    terms = Terminals(store.root, store.run_dir, seedmux=Seedmux(fake.cfg, fake.sock, fake.tmux))
    hub = AgentHub(store, terminals=terms)
    store.bind("s-x", agent="pi", native_id="n-1")
    sub = hub.subscribe(executor=False)
    hub.ensure_started()
    try:
        assert terms.seedmux_status() == {"available": True}
        opened = await asyncio.to_thread(hub.open_terminal, "s-x", launch=True, app="seedmux")
        pane = opened["paneId"]
        assert opened["launched"] == "seedmux" and opened["created"] and fake.spawned == [pane]
        # The launch line: in the project, becomes the CLI (exec), Agora's env, the pane's own PATH kept.
        launch = fake.bodies[0]["launch"]
        assert fake.bodies[0]["cwd"] == str(store.root) and " exec env " in launch and 'AGORA_SESSION=s-x' in launch and ':"$PATH"' in launch
        # No pane in Agora's own tmux server: the Seedmux pane is the only holder.
        assert "agora-s-x" not in terms.sessions()
        for _ in range(80):
            if "fake agent ready" in terms.capture("s-x"):
                break
            await asyncio.sleep(0.1)
        assert terms.holder("s-x") == {"app": "seedmux", "paneId": pane}
        st = hub.status("s-x")["terminal"]
        assert st["alive"] and st["app"] == "seedmux" and st["paneId"] == pane

        # Agora → Seedmux pane.
        r = hub.send("s-x", agora_prompt("发到 Seedmux 的一句", canvas_id="c1", canvas_name="架构图"))
        assert r["route"] == "terminal"
        evs = await drain(sub.q, lambda e: e.get("t") == "done", timeout=20)
        assert evs[-1]["text"] == "echo: 发到 Seedmux 的一句" and evs[-1]["route"] == "terminal"

        # Seedmux pane → Agora.
        t = [fake.tmux, "-S", str(fake.sock)]
        subprocess.run([*t, "send-keys", "-t", f"=smx-{pane}:", "-l", "在 Seedmux 里打的字"], check=True)
        subprocess.run([*t, "send-keys", "-t", f"=smx-{pane}:", "Enter"], check=True)
        evs = await drain(sub.q, lambda e: e.get("t") == "transcript" and any(i.get("text") == "echo: 在 Seedmux 里打的字" for i in e["items"]), timeout=20)
        typed = [i for e in evs if e["t"] == "transcript" for i in e["items"] if i["kind"] == "user"]
        assert typed[-1]["text"] == "在 Seedmux 里打的字" and typed[-1]["source"] == "terminal"

        # Opening again reuses the pane; Kitty can't open a second CLI on the same session.
        again = await asyncio.to_thread(hub.open_terminal, "s-x", launch=False, app="seedmux")
        assert again["paneId"] == pane and not again["created"] and len(fake.spawned) == 1
        with pytest.raises(Exception, match="Seedmux"):
            await asyncio.to_thread(hub.open_terminal, "s-x", launch=False)

        # Review P2-6: `agora down` after .agora/run/ was lost (git clean -fdx) still closes the
        # Seedmux pane: its holder record is mirrored under $AGORA_STATE_DIR.
        shutil.rmtree(store.run_dir / "seedmux")
        down = Terminals(store.root, store.run_dir, seedmux=Seedmux(fake.cfg, fake.sock, fake.tmux))
        assert down.holder("s-x") == {"app": "seedmux", "paneId": pane}
        down.shutdown()
        assert f"smx-{pane}" not in fake.sessions() and not terms.alive("s-x")
        pane = (await asyncio.to_thread(hub.open_terminal, "s-x", launch=False, app="seedmux"))["paneId"]

        # Closing from Agora ends only that pane.
        await asyncio.to_thread(hub.close_terminal, "s-x")
        assert f"smx-{pane}" not in fake.sessions() and not terms.alive("s-x")
        assert not (store.run_dir / "seedmux").exists() or not list((store.run_dir / "seedmux").iterdir())

        # Agora's tmux pane holds it → Seedmux opens one more window attached to it (no second CLI).
        await asyncio.to_thread(hub.open_terminal, "s-x", launch=False)
        viewer = await asyncio.to_thread(hub.open_terminal, "s-x", launch=True, app="seedmux")
        assert viewer["attached"] and not viewer["created"] and "attach -t agora-s-x" in fake.bodies[-1]["launch"] and "-u TMUX" in fake.bodies[-1]["launch"]
        assert terms.holder("s-x") == {"app": "tmux"}
    finally:
        await hub.close()
        terms.shutdown()
        fake.close()
    assert terms.sessions() == []


def test_seedmux_unavailable_is_reported(tmp_path):
    from server.canvas.seedmux import Seedmux, SeedmuxError

    smx = Seedmux(tmp_path / "missing.json", tmp_path / "s.sock", "tmux")
    st = smx.check()
    assert st["available"] is False and "Seedmux" in st["reason"]
    with pytest.raises(SeedmuxError):
        smx.spawn("true", tmp_path)
    assert smx.state("NOPE") == "gone"


# ——— the `agora canvas` / `agora skill` CLI ———
def agora(*args, cwd, env=None):
    e = {**os.environ, "PYTHONPATH": str(REPO), **(env or {})}
    e.pop("AGORA_PROJECT", None)
    return subprocess.run([sys.executable, "-m", "agora_cli", *args], cwd=cwd, env=e, capture_output=True, text=True, timeout=60)


def test_canvas_cli_without_server(store):
    sub = store.root / "src" / "deep"
    sub.mkdir(parents=True)
    r = agora("canvas", "read", cwd=sub)  # finds the project from a subdirectory
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out["source"] == "file" and out["scene"]["nodes"][0]["label"] == "Redis" and out["base"].startswith("r-")
    r = agora("canvas", "apply", "--base", out["base"], "--json", '[{"op":"delete","id":"redis"}]', cwd=store.root)
    assert r.returncode == 3 and "agora open" in json.loads(r.stdout)["error"]
    r = agora("canvas", "schema", "ops", cwd=store.root)
    assert r.returncode == 0 and "update_text" in r.stdout
    r = agora("canvas", "list", cwd=store.root)
    assert json.loads(r.stdout)["canvases"] == [{"id": "c1", "name": "架构图"}]
    r = agora("canvas", "read", "--canvas", "nope", cwd=store.root)
    assert r.returncode == 2 and "unknown canvas" in json.loads(r.stdout)["error"]


def test_skill_install_cli(store):
    r = agora("skill", "install", "--agent", "codex", cwd=store.root)
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)["installed"]
    assert got[0]["path"].endswith(".agents/skills/agora-canvas") and got[0]["state"] == "created"
    assert (store.root / ".agents" / "skills" / "agora-canvas" / "references" / "ops.md").exists()
