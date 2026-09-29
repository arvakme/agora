"""Terminal layer (server/canvas/terminal.py): who holds a pane's input, whether the registered CLI is
really there, and which Codex rollout a pane's process owns.

Rules are pure functions; the rest runs a fake CLI (tests/fake_native_cli.py, tests/fake_agent_tui.py)
in real tmux on a private ``-L`` socket that every test closes."""

from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pty
import shlex
import shutil
import struct
import subprocess
import sys
import termios
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from uuid import uuid4

import pytest

from native_protocol import SessionGate
from server.canvas import agents
from server.canvas.adapters.codex import CodexAdapter, rollout_thread
from server.canvas.project import ProjectStore
from server.canvas.sessions import AgentHub
from server.canvas.terminal import Client, Terminals, gate_hold, judge, make_gate, open_files, parse_clients, process_tree
from tests.fake_native_cli import wait_bytes, wait_file

HERE = Path(__file__).resolve().parent
FAKE = HERE / "fake_native_cli.py"
TUI = HERE / "fake_agent_tui.py"
needs_tmux = pytest.mark.skipif(shutil.which("tmux") is None, reason="needs tmux")


# ——— pure rules ———
def test_gate_pauses_for_a_takeover_and_for_foreign_writers_only():
    assert gate_hold(make_gate(None, 0)) is None
    held = gate_hold(make_gate({"right": "human"}, 0))
    assert held and "接管" in held
    writer = gate_hold(make_gate(None, 1))
    assert writer and "可写" in writer
    g = make_gate({"right": "human"}, 0)
    assert isinstance(g, SessionGate) and g.input_right == "human" and g.paused and g.unmanaged_writers == 0
    g = make_gate(None, 2)
    assert g.input_right == "host" and not g.paused and g.unmanaged_writers == 2


def test_clients_are_parsed_with_their_rights():
    raw = "/dev/ttys001|0|0\n/dev/ttys002|1|0\nclient-77|0|1\n\n"
    assert parse_clients(raw) == [Client("/dev/ttys001", False, False), Client("/dev/ttys002", True, False), Client("client-77", False, True)]


@pytest.mark.parametrize(
    "rec,dead,pid,started,want",
    [
        ({"pid": 10, "started": "Mon Sep 29 10:00:00 2026"}, False, 10, "Mon Sep 29 10:00:00 2026", "running"),
        ({"pid": 10, "started": "Mon Sep 29 10:00:00 2026"}, True, 10, "Mon Sep 29 10:00:00 2026", "gone"),  # tmux says the CLI exited
        ({"pid": 10, "started": "Mon Sep 29 10:00:00 2026"}, False, None, None, "gone"),  # no pane
        ({"pid": 10, "started": "Mon Sep 29 10:00:00 2026"}, False, 11, "Mon Sep 29 10:00:00 2026", "gone"),  # another process in the pane
        ({"pid": 10, "started": "Mon Sep 29 10:00:00 2026"}, False, 10, "Mon Sep 29 12:00:00 2026", "gone"),  # the pid was reused
        ({"pid": 10, "started": "Mon Sep 29 10:00:00 2026"}, False, 10, None, "gone"),  # ps knows no such process
        (None, False, 10, "Mon Sep 29 10:00:00 2026", "unknown"),  # a pane nobody registered: there, but not proven
    ],
)
def test_the_registered_pane_and_cli_decide_liveness(rec, dead, pid, started, want):
    assert judge(rec, dead=dead, pid=pid, started=started) == want


def _rollout(home: Path, thread: str, day: str = "2026/09/29", cwd: str = "/work/p") -> Path:
    p = home / ".codex" / "sessions" / day / f"rollout-2026-09-29T10-00-00-{thread}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"type": "session_meta", "payload": {"id": thread, "cwd": cwd}}) + "\n")
    return p


def test_codex_claims_the_rollout_the_process_has_open(tmp_path):
    a, b = str(uuid4()), str(uuid4())
    ra, rb = _rollout(tmp_path, a), _rollout(tmp_path, b)
    other = tmp_path / "notes" / "rollout-x.jsonl"
    other.parent.mkdir()
    other.write_text("{}")
    codex = CodexAdapter()
    # Both rollouts were created in the same directory at the same moment: the files a process holds decide.
    assert codex.native_from_open_files([str(other), str(rb), "/dev/null"], tmp_path) == b
    assert codex.native_from_open_files([str(ra)], tmp_path) == a
    assert codex.native_from_open_files([str(other), "/dev/null"], tmp_path) is None
    assert codex.native_from_open_files([], tmp_path) is None


def test_a_rollout_without_a_readable_header_is_named_by_its_file_name(tmp_path):
    thread = str(uuid4())
    p = tmp_path / f"rollout-2026-09-29T10-00-00-{thread}.jsonl"
    p.write_text("")
    assert rollout_thread(p) == thread
    assert rollout_thread(tmp_path / "rollout-nothing.jsonl") is None


# ——— real tmux ———
@pytest.fixture
def terms(tmp_path) -> Iterator[Terminals]:
    root = tmp_path / "proj"
    (root / ".agora" / "run").mkdir(parents=True)
    t = Terminals(root, root / ".agora" / "run", socket=f"agora-t-{uuid4().hex[:8]}")
    try:
        yield t
    finally:
        t.kill_server()
        assert not t.socket_path().exists()


def _fake(tmp: Path, name: str) -> tuple[list[str], Path, Path]:
    recv, ready = tmp / f"{name}.bin", tmp / f"{name}.ready"
    return [sys.executable, str(FAKE), str(recv), str(tmp / f"{name}.jsonl"), str(ready)], recv, ready


def _attach(t: Terminals, sid: str, *, readonly: bool) -> tuple[subprocess.Popen, int]:
    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    proc = subprocess.Popen(shlex.split(t.attach_command(sid, readonly=readonly)), stdin=slave, stdout=slave, stderr=slave, env={**env, "TERM": "xterm-256color"}, close_fds=True)
    os.close(slave)
    for _ in range(50):
        if any(c for c in t.list_clients(sid)):
            break
        time.sleep(0.1)
    return proc, master


def _detach(h: tuple[subprocess.Popen, int]) -> None:
    proc, fd = h
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=1)
    os.close(fd)


def _open(t: Terminals, tmp: Path, sid: str = "s-1") -> tuple[Path, Path]:
    argv, recv, ready = _fake(tmp, sid)
    assert t.open(sid, argv, cwd=tmp, env={}) is True
    wait_file(ready)
    return recv, ready


@needs_tmux
def test_paste_still_lands_when_a_read_only_viewer_attached_last(terms, tmp_path):
    recv, _ = _open(terms, tmp_path)
    viewer = _attach(terms, "s-1", readonly=True)
    try:
        os.write(viewer[1], b"FROM-READONLY\r")  # a viewer cannot type
        terms.paste("s-1", "HELLO-PASTE")
        data = wait_bytes(recv, b"HELLO-PASTE")
        assert data == b"\x1b[200~HELLO-PASTE\x1b[201~\r" and b"FROM-READONLY" not in data
        assert terms.gate("s-1").unmanaged_writers == 0 and terms.clients("s-1") == 1
    finally:
        _detach(viewer)


@needs_tmux
def test_a_writable_client_pauses_delivery_until_it_is_gone(terms, tmp_path):
    _open(terms, tmp_path)
    assert terms.gate("s-1").unmanaged_writers == 0
    terms.paste("s-1", "warm up")  # Agora's own control client is not a foreign writer
    assert terms.gate("s-1").unmanaged_writers == 0 and terms.clients("s-1") == 0
    writer = _attach(terms, "s-1", readonly=False)
    try:
        g = terms.gate("s-1")
        assert g.unmanaged_writers == 1 and gate_hold(g)
        assert terms.clients("s-1") == 1
    finally:
        _detach(writer)
    for _ in range(30):
        if not terms.gate("s-1").unmanaged_writers:
            break
        time.sleep(0.1)
    assert gate_hold(terms.gate("s-1")) is None  # nobody was kicked; it simply ended


@needs_tmux
def test_takeover_holds_through_detach_a_lost_control_connection_and_a_restart(terms, tmp_path):
    recv, _ = _open(terms, tmp_path)
    assert terms.input_right("s-1") is None
    terms.takeover("s-1")
    assert terms.gate("s-1").input_right == "human" and terms.gate("s-1").paused
    viewer = _attach(terms, "s-1", readonly=False)
    _detach(viewer)  # detach is not a hand-back
    assert gate_hold(terms.gate("s-1"))
    terms.paste("s-1", "before")  # Agora's own client is up …
    control = terms._controls[terms.name("s-1")]
    control.proc.kill()  # … and its connection dies abnormally
    control.proc.wait()
    assert gate_hold(terms.gate("s-1"))
    again = Terminals(terms.root, terms.run_dir, socket=terms.socket)  # a new server process reads the same facts
    assert again.input_right("s-1") is not None and gate_hold(again.gate("s-1"))
    assert again.give_back("s-1") is True and again.give_back("s-1") is False
    assert gate_hold(terms.gate("s-1")) is None
    terms.paste("s-1", "after")  # the lost control connection is replaced, delivery resumes
    wait_bytes(recv, b"after")


@needs_tmux
def test_a_new_pane_starts_with_the_host_holding_input(terms, tmp_path):
    _open(terms, tmp_path)
    terms.takeover("s-1")
    terms.kill("s-1")
    assert terms.input_right("s-1") is None
    _open(terms, tmp_path)
    assert terms.gate("s-1").input_right == "host"


@needs_tmux
def test_liveness_needs_the_registered_pane_and_cli(terms, tmp_path):
    _open(terms, tmp_path)
    assert terms.state("s-1") == "running" and terms.alive("s-1")
    reg = terms._file("panes", "s-1")
    rec = json.loads(reg.read_text())
    assert rec["pid"] == terms.pane_pid("s-1") and rec["started"]
    reg.write_text(json.dumps({**rec, "started": "Thu Jan  1 00:00:00 1970"}))  # not the process that was registered
    assert terms.state("s-1") == "gone" and not terms.alive("s-1")
    reg.unlink()  # nothing registered (older build, lost .agora/run/): there, but unproven
    assert terms.state("s-1") == "unknown" and terms.alive("s-1")
    reg.write_text(json.dumps(rec))
    assert terms.state("s-1") == "running"
    os.kill(rec["pid"], 9)  # the CLI dies
    for _ in range(50):
        if terms.state("s-1") == "gone":
            break
        time.sleep(0.1)
    assert terms.state("s-1") == "gone" and not terms.alive("s-1")


@needs_tmux
def test_two_codex_panes_started_together_each_claim_their_own_rollout(terms, tmp_path):
    home = tmp_path / "home"
    script = tmp_path / "codexish.py"
    # Opens its rollout in a child shell process (a launcher that starts the real CLI) and keeps it open.
    script.write_text(
        "import json, sys, time\n"
        "thread, home = sys.argv[1], sys.argv[2]\n"
        "import pathlib\n"
        "p = pathlib.Path(home) / '.codex' / 'sessions' / '2026' / '09' / '29' / f'rollout-2026-09-29T10-00-00-{thread}.jsonl'\n"
        "p.parent.mkdir(parents=True, exist_ok=True)\n"
        "f = open(p, 'a')\n"
        "f.write(json.dumps({'type': 'session_meta', 'payload': {'id': thread, 'cwd': '/work/p'}}) + '\\n'); f.flush()\n"
        "print('up', flush=True)\n"
        "time.sleep(60)\n"
    )
    a, b = str(uuid4()), str(uuid4())
    for sid, thread in (("s-a", a), ("s-b", b)):
        launcher = ["sh", "-c", f"{shlex.quote(sys.executable)} {shlex.quote(str(script))} {thread} {shlex.quote(str(home))}; true"]
        assert terms.open(sid, launcher, cwd=tmp_path, env={}) is True
    codex = CodexAdapter()
    got: dict[str, str | None] = {}
    for _ in range(100):
        got = {sid: codex.native_from_open_files(terms.process_files(sid), home) for sid in ("s-a", "s-b")}
        if all(got.values()):
            break
        time.sleep(0.1)
    assert got == {"s-a": a, "s-b": b}
    pid = terms.pane_pid("s-a")
    assert pid in process_tree(pid) and len(process_tree(pid)) >= 2  # the shell's child holds the file
    assert any(p.endswith(f"{a}.jsonl") for p in open_files(process_tree(pid)))


# ——— through the hub ———
@pytest.fixture
async def hub(tmp_path, monkeypatch) -> AsyncIterator[AgentHub]:
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)
    s = ProjectStore(tmp_path / "proj")
    s.init()
    log = tmp_path / "native.jsonl"
    monkeypatch.setattr(agents, "locate_log", lambda kind, nid, root=None, home=None, hint=None: agents.LogLookup("found", log, (log,)) if nid else agents.LogLookup("missing"))
    monkeypatch.setattr(agents, "interactive_argv", lambda *a, **k: [sys.executable, str(TUI), str(log)])
    h = AgentHub(s, terminals=Terminals(s.root, s.run_dir, socket=f"agora-t-{uuid4().hex[:8]}"))
    s.bind("s-t", agent="pi", native_id="n-1")
    yield h
    await h.close()
    h.terms.kill_server()
    assert not h.terms.socket_path().exists()


async def _until(pred, timeout=20.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return
        await asyncio.sleep(0.1)
    raise AssertionError("condition not reached")


async def _held(hub, sid, needle):
    """The hub's own loop ticks; wait until it says why the queue waits."""
    await _until(lambda: needle in (hub.status(sid)["held"] or ""))


@needs_tmux
async def test_takeover_pauses_the_queue_and_giving_back_delivers_it(hub):
    hub.ensure_started()
    await asyncio.to_thread(hub.open_terminal, "s-t", launch=False)
    await _until(lambda: "fake agent ready" in hub.terms.capture("s-t"))
    lv = hub.live["s-t"]
    lv.pane_since = time.time() - 60  # past the boot grace

    hub.takeover("s-t")
    assert hub.status("s-t")["terminal"]["inputRight"] == "human"
    hub.send("s-t", "排队的一句")
    await _held(hub, "s-t", "接管")
    await asyncio.sleep(1.0)  # several ticks later: still held, not dropped, not typed
    assert len(lv.pane) == 1 and not lv.awaiting and "排队的一句" not in hub.terms.capture("s-t")

    res = hub.give_back("s-t")
    assert res["inputRight"] == "host" and res["wasHeld"] is True
    await _until(lambda: not lv.pane)
    await _until(lambda: "排队的一句" in hub.terms.capture("s-t"))


@needs_tmux
async def test_a_writable_attach_holds_delivery_and_a_read_only_one_does_not(hub):
    hub.ensure_started()
    await asyncio.to_thread(hub.open_terminal, "s-t", launch=False)
    await _until(lambda: "fake agent ready" in hub.terms.capture("s-t"))
    lv = hub.live["s-t"]
    lv.pane_since = time.time() - 60

    viewer = await asyncio.to_thread(_attach, hub.terms, "s-t", readonly=True)
    try:
        hub.send("s-t", "只读窗口不挡")
        await _until(lambda: not lv.pane)  # a viewer takes no input right: it went in
        await _until(lambda: "只读窗口不挡" in hub.terms.capture("s-t"))
    finally:
        _detach(viewer)
    await _until(lambda: not lv.state.busy and not lv.awaiting, timeout=30)

    writer = await asyncio.to_thread(_attach, hub.terms, "s-t", readonly=False)
    try:
        hub.send("s-t", "可写窗口在时等着")
        await _held(hub, "s-t", "可写")
        await asyncio.sleep(1.0)
        assert len(lv.pane) == 1 and "可写窗口在时等着" not in hub.terms.capture("s-t")
    finally:
        _detach(writer)
    await _until(lambda: not lv.pane)  # it simply ended; nobody was kicked
    await _until(lambda: "可写窗口在时等着" in hub.terms.capture("s-t"))


@needs_tmux
async def test_a_cli_that_exits_mid_turn_is_reported_as_unknown_not_done(hub):
    from server.canvas.sessions import Pending

    hub.ensure_started()
    sub = hub.subscribe(executor=False)
    await asyncio.to_thread(hub.open_terminal, "s-t", launch=False)
    await _until(lambda: "fake agent ready" in hub.terms.capture("s-t"))
    lv = hub.live["s-t"]
    lv.pane_alive = True
    # One turn is open in the log with no end record; another message was pasted but never showed up in the log.
    lv.current = Pending(send_id="m-open", prompt="x", at=time.time())
    lv.awaiting.append(Pending(send_id="m-unseen", prompt="y", at=time.time(), delivered_at=time.time()))
    lv.state.busy = True
    os.kill(hub.terms.pane_pid("s-t"), 9)
    await _until(lambda: not hub.terms.alive("s-t"))
    await asyncio.to_thread(hub._tick_sync)
    seen = []
    while not sub.q.empty():
        seen.append(sub.q.get_nowait())
    done = {e["sendId"]: e for e in seen if e.get("t") == "done"}
    assert set(done) == {"m-open", "m-unseen"}
    assert all(e["outcome"] == "unknown" and e["text"] == "" and e["error"] for e in done.values())
    assert "结果未知" in done["m-open"]["error"] and "不知道" in done["m-unseen"]["error"]
    assert lv.current is None and not lv.awaiting and not lv.state.busy


@needs_tmux
async def test_a_codex_session_is_claimed_from_the_panes_own_process(hub, tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    mine, theirs = str(uuid4()), str(uuid4())
    _rollout(home, theirs)  # someone else's session in the same directory, created first
    hub.store.bind("s-c", agent="codex")
    script = tmp_path / "codexish.py"
    script.write_text(
        "import json, pathlib, sys, time\n"
        f"p = pathlib.Path({str(home)!r}) / '.codex' / 'sessions' / '2026' / '09' / '29' / 'rollout-2026-09-29T10-00-01-{mine}.jsonl'\n"
        "f = open(p, 'a'); f.write(json.dumps({'type': 'session_meta', 'payload': {'id': %r, 'cwd': %r}}) + '\\n'); f.flush()\n"
        "time.sleep(60)\n" % (mine, str(hub.store.root))
    )
    since = time.time() - 30
    assert hub._claim_native("s-c", hub.store.read_binding("s-c"), since, set()) is None  # no pane yet: nothing to claim
    monkeypatch.setattr(agents, "interactive_argv", lambda *a, **k: [sys.executable, str(script)])
    await asyncio.to_thread(hub.open_terminal, "s-c", launch=False)
    got = None
    for _ in range(100):
        got = hub._claim_native("s-c", hub.store.read_binding("s-c"), since, set())
        if got:
            break
        await asyncio.sleep(0.1)
    assert got == mine  # not "the first unclaimed rollout in the directory"
    assert hub._claim_native("s-c", hub.store.read_binding("s-c"), since, {mine}) is None  # already owned by a session
