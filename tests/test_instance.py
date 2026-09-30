"""Phase 1 of the session / canvas lifecycle plan: which copy of a project this is (instance id),
the machine registry outside every project, and what happens when a project is moved, copied or
freshly cloned — Pi logs follow a move, a copy's sessions are read-only until forked, sessions made
elsewhere are recognised instead of re-created. Experiments A1–A3 / B2 / B6 (2026-09-28)."""

from __future__ import annotations

import asyncio
import json
import shutil
import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.agents import ClaudeCodeBackend, PiBackend, interactive_argv, locate_log, migrate_pi_log, pi_dir_name
from server.canvas.local import Local, Registry, legacy_socket, session_origins, socket_name
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app
from server.canvas.runner import ExecOptions, RunRequest
from server.canvas.sessions import AgentHub, Copied
from server.canvas.share import ShareManager

NID = "2e5e7d73-db76-455d-b211-669efbe93cbe"


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setattr(Path, "home", lambda: h)
    monkeypatch.delenv("PI_CODING_AGENT_SESSION_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    return h


def project(root: Path, sessions: list[dict] | None = None) -> ProjectStore:
    s = ProjectStore(root)
    s.init()
    docs = [{"id": "c1", "kind": "canvas", "title": "A"}, {"id": "c2", "kind": "canvas", "title": "B"}] + [
        {"id": f"p-{x['sessionId']}", "kind": "session", "title": "", **x} for x in sessions or []
    ]
    s.write("workspace", None, {"v": 2, "docs": docs, "root": {}, "focused": "c1"}, base=None)
    return s


def pi_log(home: Path, root: Path | str, nid: str = NID, extra: str = '{"type":"message","text":"LYCHEE-9"}\n') -> Path:
    p = home / ".pi" / "agent" / "sessions" / pi_dir_name(root) / f"2026-09-28T05-19-21-739Z_{nid}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"type": "session", "version": 3, "id": nid, "cwd": str(root)}) + "\n" + extra)
    return p


def claude_log(home: Path, root: Path | str, nid: str = NID) -> Path:
    p = home / ".claude" / "projects" / agents.claude_dir_name(root) / f"{nid}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{"type":"user"}\n')
    return p


# ——— registry ———
def test_registry_appends_filters_and_skips_bad_lines(tmp_path):
    r = Registry(tmp_path / "state")
    r.append("instance", projectId="p1", instanceId="i1", root="/a")
    r.append("bind", projectId="p1", instanceId="i1", root="/a", sessionId="s1", agent="claude", nativeId="n1")
    r.append("bind", projectId="p2", instanceId="i2", root="/b", sessionId="s9", agent="pi", nativeId="n9")
    with open(r.path, "ab") as fh:
        fh.write(b'{"t": "torn\n[1,2]\n')
    r.append("root", projectId="p1", instanceId="i1", root="/c", **{"from": "/a"})
    assert [e["t"] for e in r.events("p1")] == ["instance", "bind", "root"]
    assert r.binds("p1")["s1"]["nativeId"] == "n1" and "s9" not in r.binds("p1")
    assert r.roots("p1", "i1") == ["/a", "/c"]
    assert r.instance_at("p1", "/c") == "i1" and r.instance_at("p1", "/a") is None
    assert r.by_native()["n9"]["sessionId"] == "s9"


def test_registry_concurrent_appends_keep_whole_lines(tmp_path):
    r = Registry(tmp_path / "state")

    def burst(k: int) -> None:
        for i in range(40):
            r.append("bind", projectId="p", sessionId=f"s{k}-{i}", agent="pi", topic="x" * 300)

    ts = [threading.Thread(target=burst, args=(k,)) for k in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    lines = r.path.read_bytes().splitlines()
    assert len(lines) == 240 and all(json.loads(line)["t"] == "bind" for line in lines)


# ——— reconcile: new / same / moved / copied / fresh ———
def test_new_project_gets_an_instance_and_keeps_it(tmp_path):
    s = project(tmp_path / "proj")
    loc = Local(s)
    first = loc.reconcile()
    assert first["kind"] == "new" and loc.change() is None  # nothing to tell the page about
    iid = loc.instance_id()
    assert iid and loc.reconcile() == {"kind": "same"} and loc.instance_id() == iid
    assert (s.dir / "local" / ".gitignore").read_text().strip().endswith("*")  # never committed
    assert loc.socket() == socket_name(iid) != legacy_socket(s.root)


def test_move_keeps_the_instance_and_moves_pi_logs_along(tmp_path, home):
    s = project(tmp_path / "orig" / "pi-repo")
    loc = Local(s)
    loc.reconcile()
    iid = loc.instance_id()
    s.bind("s-pi", agent="pi", model="deepseek/deepseek-flash", native_id=NID, started=True)
    s.bind("s-cc", agent="claude", native_id="c-1", started=True)
    old_log = pi_log(home, s.root)
    claude_log(home, s.root, "c-1")

    new_root = tmp_path / "moved" / "pi-repo-new"
    new_root.parent.mkdir()
    shutil.move(str(s.root), str(new_root))
    moved = Local(ProjectStore(new_root))
    change = moved.reconcile()

    assert change["kind"] == "moved" and change["from"] == str(tmp_path / "orig" / "pi-repo")
    assert moved.instance_id() == iid  # same copy, new place: the socket and tunnel names don't change
    dst = home / ".pi" / "agent" / "sessions" / pi_dir_name(new_root) / old_log.name
    assert change["migrated"] == [{"sessionId": "s-pi", "nativeId": NID, "path": str(dst)}]
    head, rest = dst.read_text().split("\n", 1)
    assert json.loads(head)["cwd"] == str(new_root) and rest == '{"type":"message","text":"LYCHEE-9"}\n'
    assert not old_log.exists() and old_log.with_name(old_log.name + ".agora-moved.bak").exists()
    assert locate_log("pi", NID, new_root).path == dst  # --session-id finds it from the new root now
    assert locate_log("claude", "c-1", new_root).state == "found"  # Claude needs nothing
    assert moved.store.read_binding("s-pi")["log"]["path"] == str(dst)
    reg = [e["t"] for e in moved.registry.events(moved.project_id())]
    assert reg[-2:] == ["rebind", "root"] and moved.historical_roots() == [str(tmp_path / "orig" / "pi-repo"), str(new_root)]
    assert moved.reconcile() == {"kind": "same"}  # idempotent
    assert moved.change()["kind"] == "moved"
    moved.ack()
    assert moved.change() is None


def test_move_leaves_a_pi_log_whose_terminal_is_still_open(tmp_path, home):
    s = project(tmp_path / "a")
    Local(s).reconcile()
    s.bind("s-pi", agent="pi", native_id=NID, started=True)
    old_log = pi_log(home, s.root)
    shutil.move(str(s.root), str(tmp_path / "b"))
    change = Local(ProjectStore(tmp_path / "b")).reconcile(alive=lambda sid: sid == "s-pi")
    assert change["migrated"] == [] and change["failed"][0]["sessionId"] == "s-pi" and old_log.exists()


def test_move_leaves_a_pi_log_already_in_the_new_folder_alone(tmp_path, home):
    """The new root's folder already has a log with this id (Pi was run there by hand): that one is
    what `--session-id` resumes, so nothing is moved and nothing is marked to fork."""
    s = project(tmp_path / "a")
    Local(s).reconcile()
    s.bind("s-pi", agent="pi", native_id=NID, started=True)
    old_log = pi_log(home, s.root)
    pi_log(home, tmp_path / "b", extra="")  # something already sits where it would go
    shutil.move(str(s.root), str(tmp_path / "b"))
    moved = ProjectStore(tmp_path / "b")
    change = Local(moved).reconcile()
    assert change["migrated"] == [] and change["failed"] == []
    assert old_log.exists() and "pendingFork" not in moved.read_binding("s-pi")


def test_migrate_pi_log_refuses_an_existing_destination_and_leaves_the_original(tmp_path, home):
    src = pi_log(home, tmp_path / "a")
    taken = home / ".pi" / "agent" / "sessions" / pi_dir_name(tmp_path / "b") / src.name
    taken.parent.mkdir(parents=True)
    taken.write_text("x")
    before = src.read_bytes()
    with pytest.raises(ValueError):
        migrate_pi_log(src, tmp_path / "b")
    assert src.read_bytes() == before and taken.read_text() == "x"


def test_migrate_pi_log_rolls_back_when_the_old_file_cannot_be_set_aside(tmp_path, home, monkeypatch):
    src = pi_log(home, tmp_path / "a")
    real = __import__("os").replace
    calls = []

    def flaky(a, b):
        calls.append((a, b))
        if str(b).endswith(".agora-moved.bak"):
            raise OSError("disk full")
        return real(a, b)

    monkeypatch.setattr("server.canvas.agents.os.replace", flaky)
    with pytest.raises(OSError):
        migrate_pi_log(src, tmp_path / "b")
    assert src.exists() and not (home / ".pi" / "agent" / "sessions" / pi_dir_name(tmp_path / "b") / src.name).exists()


def test_move_failure_marks_the_session_to_fork_on_its_next_run(tmp_path, home, monkeypatch):
    s = project(tmp_path / "a")
    Local(s).reconcile()
    s.bind("s-pi", agent="pi", native_id=NID, started=True)
    old_log = pi_log(home, s.root)

    def boom(*a, **k):
        raise OSError("read-only file system")

    monkeypatch.setattr(agents, "migrate_pi_log", boom)
    shutil.move(str(s.root), str(tmp_path / "b"))
    moved = ProjectStore(tmp_path / "b")
    change = Local(moved).reconcile()
    assert change["failed"][0]["fallback"] == "fork"
    fork = moved.read_binding("s-pi")["pendingFork"]
    assert fork["from"] == NID and fork["path"] == str(old_log)
    req = RunRequest(schema=None, system=None, prompt="hi", options=ExecOptions(backend="pi", session=None, fork_from=fork["from"], fork_path=fork["path"]), cwd=str(moved.root))
    assert PiBackend().args(req)[4:6] == ["--fork", str(old_log)]


def test_copy_gets_its_own_instance_and_its_sessions_are_read_only_until_forked(tmp_path, home):
    s = project(tmp_path / "orig", [{"sessionId": "s-cc", "agent": "claude", "canvasId": "c2"}])
    Local(s).reconcile()
    s.bind("s-cc", agent="claude", model="haiku", native_id="c-1", started=True)
    claude_log(home, s.root, "c-1")
    shutil.copytree(s.root, tmp_path / "copy")
    copy = ProjectStore(tmp_path / "copy")
    loc = Local(copy)
    change = loc.reconcile()
    assert change["kind"] == "copied" and change["from"] == str(s.root) and change["sessions"] == ["s-cc"]
    assert loc.instance_id() != Local(s).instance_id() and Local(s).reconcile() == {"kind": "same"}
    assert session_origins(copy, loc)["s-cc"]["state"] == "copy"

    hub = AgentHub(copy, local=loc)

    async def send():
        hub.send("s-cc", "hello")

    with pytest.raises(Copied):
        asyncio.run(send())
    assert hub.status("s-cc")["copy"]["from"] == str(s.root)
    b = hub.fork("s-cc")
    assert b["pendingFork"]["from"] == "c-1" and "s-cc" not in loc.copies()
    req = RunRequest(schema=None, system=None, prompt="hi", options=ExecOptions(backend="claude", fork_from="c-1"), cwd=str(copy.root))
    assert ClaudeCodeBackend().args(req)[11:14] == ["--resume", "c-1", "--fork-session"]
    assert interactive_argv("claude", "c-1", "haiku", None, fork=b["pendingFork"])[:4] == ["claude", "--resume", "c-1", "--fork-session"]
    assert interactive_argv("codex", "x", None, None, fork={"from": "x"})[:3] == ["codex", "fork", "x"]
    hub.adopt_fork("s-cc", "c-2")
    after = copy.read_binding("s-cc")
    assert after["nativeId"] == "c-2" and after["started"] is True and "pendingFork" not in after
    assert [n["id"] for n in after["natives"]] == ["c-1", "c-2"]


def test_headless_fork_adopts_the_new_native_id(tmp_path, home):
    s = project(tmp_path / "p")
    Local(s).reconcile()
    s.bind("s-pi", agent="pi", native_id=NID, started=True)
    src = pi_log(home, tmp_path / "elsewhere")
    s.set_fork("s-pi", NID, str(src), reason="copy")

    class Forking:
        seen: list = []

        async def run(self, req):
            Forking.seen.append(req.options)
            yield {"t": "start", "at": 0}
            yield {"t": "result", "at": 1, "raw": "ok", "session": "new-pi-id", "usage": None}

    hub = AgentHub(s, backend_factory=lambda kind: Forking())

    async def go():
        hub.send("s-pi", "continue")
        for _ in range(100):
            await asyncio.sleep(0.02)
            if (s.read_binding("s-pi") or {}).get("nativeId") == "new-pi-id":
                break
        await hub.close()

    asyncio.run(go())
    o = Forking.seen[0]
    assert (o.fork_from, o.fork_path, o.session) == (NID, str(src), None)
    assert s.read_binding("s-pi")["nativeId"] == "new-pi-id" and "pendingFork" not in s.read_binding("s-pi")


def test_fresh_clone_sessions_are_foreign_not_blank_pickers(tmp_path):
    s = project(tmp_path / "clone", [{"sessionId": "s-1", "agent": "claude", "canvasId": "c2", "topic": "加 Kafka", "nativeId": "n-1"}])
    loc = Local(s)
    assert loc.reconcile()["kind"] == "fresh"
    o = session_origins(s, loc)["s-1"]
    assert o == {"state": "foreign", "agent": "claude", "canvasId": "c2", "topic": "加 Kafka", "nativeId": "n-1"}


def test_git_clean_reuses_the_instance_and_the_binding_is_recoverable(tmp_path, home):
    s = project(tmp_path / "proj", [{"sessionId": "s-1", "agent": "claude", "canvasId": "c2"}])
    loc = Local(s)
    loc.reconcile()
    iid = loc.instance_id()
    s.bind("s-1", agent="claude", model="haiku", native_id="n-1", started=True)
    AgentHub(s, local=loc).note_bind("s-1", "bind")
    claude_log(home, s.root, "n-1")
    shutil.rmtree(s.dir / "sessions")
    shutil.rmtree(s.dir / "local")  # git clean -fdx
    again = Local(ProjectStore(s.root))
    assert again.reconcile()["kind"] == "reattached" and again.instance_id() == iid
    o = session_origins(again.store, again)["s-1"]
    assert o["state"] == "recoverable" and o["nativeId"] == "n-1" and o["model"] == "haiku" and o["log"] == "found"


def test_a_session_another_copy_on_this_machine_owns_can_be_forked_here(tmp_path, home):
    a = project(tmp_path / "a", [{"sessionId": "s-1", "agent": "pi"}])
    la = Local(a)
    la.reconcile()
    a.bind("s-1", agent="pi", native_id=NID, started=True)
    AgentHub(a, local=la).note_bind("s-1", "bind")
    pi_log(home, a.root)
    shutil.copytree(a.root, tmp_path / "b", ignore=shutil.ignore_patterns("sessions", "local"))  # a second clone
    b = ProjectStore(tmp_path / "b")
    lb = Local(b)
    lb.reconcile()
    o = session_origins(b, lb)["s-1"]
    assert o["state"] == "other-copy" and o["root"] == str(a.root)
    hub = AgentHub(b, local=lb)
    got = hub.fork("s-1", {"agent": o["agent"], "model": o.get("model"), "effort": o.get("effort"), "nativeId": o["nativeId"]})
    assert got["pendingFork"]["from"] == NID and got["started"] is False


def test_down_names_every_socket_the_instance_had(tmp_path):
    s = project(tmp_path / "a")
    Local(s).reconcile()
    shutil.move(str(s.root), str(tmp_path / "b"))
    loc = Local(ProjectStore(tmp_path / "b"))
    loc.reconcile()
    assert loc.legacy_sockets() == sorted({legacy_socket(tmp_path / "a"), legacy_socket(tmp_path / "b")})


def test_tunnel_names_differ_between_copies(tmp_path):
    a = project(tmp_path / "a")
    Local(a).reconcile()
    shutil.copytree(a.root, tmp_path / "b")
    b = ProjectStore(tmp_path / "b")
    Local(b).reconcile()
    na, nb = ShareManager(a).tunnel_name, ShareManager(b).tunnel_name
    assert na != nb and na.startswith(ShareManager(a).legacy_tunnel_name + "-")


def test_codex_rollout_found_through_its_own_index_when_it_left_the_dated_folders(tmp_path, home):
    codex = home / ".codex"
    codex.mkdir()
    moved = tmp_path / "archive" / f"rollout-2026-09-28T13-17-07-{NID}.jsonl"
    moved.parent.mkdir()
    moved.write_text("{}\n")
    con = sqlite3.connect(codex / "state_5.sqlite")
    con.execute("create table threads (id text primary key, rollout_path text, cwd text)")
    con.execute("insert into threads values (?, ?, ?)", (NID, str(moved), "/x"))
    con.commit()
    con.close()
    look = locate_log("codex", NID, None)
    assert look.state == "found" and look.path == moved


def test_workspace_session_entries_are_what_the_page_saved_and_the_app_reports_the_change(tmp_path, home):
    s = project(tmp_path / "p", [{"sessionId": "s-1", "agent": "claude", "canvasId": "c2"}])
    c = TestClient(create_project_app(s.root, canvas_router=APIRouter()))
    snap = c.get("/api/project/snapshot").json()
    assert snap["local"]["change"]["kind"] == "fresh" and snap["origins"]["s-1"]["state"] == "foreign"
    assert c.get("/api/project").json()["instanceId"] == Local(s).instance_id()
    assert c.post("/api/project/local/ack").json() == {"ok": True}
    assert c.get("/api/project/snapshot").json()["local"]["change"] is None
