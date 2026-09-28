"""Phase 3 of the session / canvas lifecycle plan: 会话历史 and finding lost sessions in the native
logs (registry → hidden footer → working directory), Agora's trajectory snapshot and carrying a lost
session on with a summary, local file versions and daily backups outside the project, and
``agora doctor`` putting back what ``git clean -fdx`` removed."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from server.canvas import agents
from server.canvas.backup import Backups, FileHistory
from server.canvas.discover import footer_ids, scan_log, session_history
from server.canvas.local import Local
from server.canvas.project import ProjectStore
from server.canvas.project_router import create_project_app
from server.canvas.sessions import AgentHub, agora_prompt
from server.canvas.trash import Trash

REPO = Path(__file__).resolve().parents[1]
NID = "65b04644-6b78-49c7-b0df-b94f9d79a2fc"


@pytest.fixture(autouse=True)
def _no_cli_catalog(monkeypatch):
    monkeypatch.setattr(agents, "check_binding", lambda *a: None)


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setattr(Path, "home", lambda: h)
    monkeypatch.setenv("HOME", str(h))
    monkeypatch.delenv("PI_CODING_AGENT_SESSION_DIR", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    return h


@pytest.fixture
def store(tmp_path):
    s = ProjectStore(tmp_path / "proj")
    s.init()
    Local(s).reconcile()
    s.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "A"}, {"id": "c2", "kind": "canvas", "title": "架构 B"}], "root": {}, "focused": "c1"}, base=None)
    s.write("canvas", "c1", {"elements": [{"id": "box1"}]}, base=None)
    s.write("canvas", "c2", {"elements": []}, base=None)
    return s


def claude_log(home: Path, root: Path | str, nid: str, turns: list[tuple[str, str]], *, footer: dict | None = None, days_ago: float = 0) -> Path:
    p = home / ".claude" / "projects" / agents.claude_dir_name(root) / f"{nid}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    t0 = time.time() - days_ago * 86400
    for i, (q, a) in enumerate(turns):
        text = agora_prompt(q, canvas_id=footer.get("canvas"), canvas_name="架构 B", session_id=footer.get("session"), project_id=footer.get("project")) if footer else q
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0 + i * 60))
        lines.append({"type": "user", "uuid": f"u{i}-{nid[:4]}", "timestamp": ts, "cwd": str(root), "message": {"role": "user", "content": text}})
        lines.append({"type": "assistant", "uuid": f"a{i}-{nid[:4]}", "timestamp": ts, "message": {"id": f"m{i}-{nid[:4]}", "model": "claude-haiku-4-5", "content": [{"type": "text", "text": a}], "stop_reason": "end_turn", "usage": {"input_tokens": 3, "output_tokens": 2}}})
    p.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in lines))
    if days_ago:
        os.utime(p, (t0, t0))
    return p


def pid8(store: ProjectStore) -> str:
    return store.info()["id"].replace("-", "")[:8]


# ——— discovery ———
def test_footer_ids_are_read_back_from_a_native_log(store, home):
    log = claude_log(home, store.root, NID, [("加 Kafka", "好")], footer={"canvas": "c2", "session": "s-9", "project": store.info()["id"]})
    assert footer_ids(log.read_text()) == {"canvas": "c2", "session": "s-9", "project": pid8(store)}
    got = scan_log("claude", log)
    assert got["turns"] == 1 and got["firstMessage"] == "加 Kafka" and got["agora"] and got["model"] == "claude-haiku-4-5"


def test_history_lists_every_kind_of_session_and_finds_lost_ones(store, home, tmp_path):
    loc = Local(store)
    pid = store.info()["id"]
    # listed and bound
    store.bind("s-live", agent="claude", model="haiku", native_id="live-1", started=True)
    store.append_session("s-live", [{"t": "session", "session": {"id": "s-live", "canvasId": "c1", "createdAt": 5, "turnIds": []}}], base=None)
    claude_log(home, store.root, "live-1", [("第一句", "嗯"), ("第二句", "好")])
    # deleted then purged: its native log still names the project and the session (footer)
    claude_log(home, store.root, "lost-1", [("讨论 Kafka 分区", "三个分区")], footer={"canvas": "c2", "session": "s-gone", "project": pid})
    # a log with only the canvas in its footer (older builds)
    claude_log(home, store.root, "old-1", [("旧的讨论", "好")], footer={"canvas": "c1"})
    # a terminal session in the project directory that never went through Agora
    claude_log(home, store.root, "term-1", [("随便问问", "好")])
    # a Pi session from before the project moved (history root from the registry)
    old_root = tmp_path / "old-place"
    loc.registry.append("root", projectId=pid, instanceId=loc.instance_id(), root=str(store.root), **{"from": str(old_root)})
    pi = home / ".pi" / "agent" / "sessions" / agents.pi_dir_name(old_root) / f"2026-09-20T00-00-00-000Z_pi-9.jsonl"
    pi.parent.mkdir(parents=True)
    pi.write_text(json.dumps({"type": "session", "id": "pi-9", "cwd": str(old_root)}) + "\n")
    # known only to the registry
    loc.note("bind", sessionId="s-reg", agent="codex", nativeId="cx-1", canvasId="c1", topic="压测")
    # in the trash
    store.bind("s-tr", agent="pi", native_id="pi-tr", started=True)
    Trash(store).put("session", "s-tr", title="Pi · 旧会话", entry={"id": "p-s-tr", "kind": "session", "sessionId": "s-tr", "title": "", "canvasId": "c2"})

    h = TestClient(create_project_app(store.root, canvas_router=APIRouter())).get("/api/project/history").json()
    rows = {r["sessionId"]: r for r in h["rows"]}
    assert rows["s-live"]["state"] == "listed" and rows["s-live"]["turns"] == 2 and rows["s-live"]["firstMessage"] == "第一句"
    assert rows["s-tr"]["state"] == "trash" and rows["s-tr"]["daysLeft"] == 30
    assert rows["s-reg"]["state"] == "registry" and rows["s-reg"]["topic"] == "压测"
    found = {r["nativeId"]: r for r in h["found"]}
    assert found["lost-1"]["source"] == "footer" and found["lost-1"]["sessionId"] == "s-gone" and found["lost-1"]["canvasId"] == "c2"
    assert found["old-1"]["source"] == "agora" and found["old-1"]["sessionId"] is None
    assert found["term-1"]["source"] == "cwd"
    assert found["pi-9"]["agent"] == "pi" and found["pi-9"]["root"] == str(old_root)
    assert "live-1" not in found  # bound sessions are rows, not finds
    assert [r["source"] for r in h["found"]] == ["footer", "agora", "cwd", "cwd"]  # cwd-only ones last

    # Full text finds what was said, in the native log or — when the log is gone — the snapshot.
    c = TestClient(create_project_app(store.root, canvas_router=APIRouter()))
    hits = {m["key"]: m["snippet"] for m in c.get("/api/project/history/search", params={"q": "kafka"}).json()["matches"]}
    assert set(hits) == {"s-gone"} and "Kafka 分区" in hits["s-gone"]


def test_import_binds_the_found_native_session_under_its_old_id(store, home):
    """Importing is an ordinary binding with the native id and started: it resumes, never re-creates."""
    claude_log(home, store.root, "lost-1", [("讨论 Kafka", "好")], footer={"canvas": "c2", "session": "s-gone", "project": store.info()["id"]})
    c = TestClient(create_project_app(store.root, canvas_router=APIRouter()))
    b = c.put("/api/agent/sessions/s-gone", json={"agent": "claude", "model": "haiku", "nativeId": "lost-1", "started": True}).json()
    assert b["nativeId"] == "lost-1" and b["started"] is True
    h = c.get("/api/project/history").json()
    assert "lost-1" not in {r["nativeId"] for r in h["found"]}
    ev = Local(store).registry.events(store.info()["id"], "import")
    assert ev and ev[-1]["nativeId"] == "lost-1"


# ——— trajectory snapshot, summary, restart ———
async def test_snapshot_keeps_the_trajectory_and_the_session_carries_on_with_a_summary(store, home):
    log = claude_log(home, store.root, NID, [("还记得暗号 PAPAYA-7 吗", "记得")])
    store.bind("s-1", agent="claude", model="haiku", native_id=NID, started=True)
    hub = AgentHub(store)
    hub._follow("s-1", hub._get("s-1"))
    snap = store.dir / "sessions" / "snapshots" / "s-1.jsonl"
    kept = [json.loads(x) for x in snap.read_text().splitlines()]
    assert {"user", "assistant"} <= {i["kind"] for i in kept}
    size = snap.stat().st_size
    hub._follow("s-1", hub._get("s-1"))
    assert snap.stat().st_size == size  # nothing new, nothing appended

    log.unlink()  # Claude's 30-day cleanup
    again = AgentHub(store)  # a restart: the snapshot is what is left
    st = again.status("s-1")
    again._follow("s-1", again._get("s-1"))
    st = again.status("s-1")
    assert st["native"]["state"] == "missing" and st["snapshot"] is True
    assert any(i.get("text") == "记得" for i in again._get("s-1").items.values())
    text = again.summary("s-1")
    assert "用户：还记得暗号 PAPAYA-7 吗" in text and "助手：记得" in text
    b = again.restart("s-1")
    assert b["nativeId"] != NID and b["started"] is False and [n["id"] for n in b["natives"]][0] == NID
    assert again.status("s-1")["native"] is None  # the next message starts the new native session
    claude_log(home, store.root, b["nativeId"], [("x", "y")])
    with pytest.raises(ValueError):
        again.restart("s-1")  # its log is there: nothing to restart


def test_a_claude_session_idle_for_20_days_warns_about_the_30_day_cleanup(store, home):
    claude_log(home, store.root, NID, [("hi", "hello")], days_ago=25)
    store.bind("s-1", agent="claude", native_id=NID, started=True)
    hub = AgentHub(store)
    hub._follow("s-1", hub._get("s-1"))
    assert hub.status("s-1")["stale"]["days"] == 25


# ——— file versions and backups ———
def test_file_versions_are_kept_outside_the_project_at_most_every_10_minutes(store):
    now = [1_800_000_000.0]
    h = FileHistory(Local(store), clock=lambda: now[0])
    store.on_overwrite = h.keep
    before = (store.dir / "canvases" / "c1.excalidraw").read_bytes()
    store.write("canvas", "c1", {"elements": [{"id": "v2"}]}, base=None, force=True)
    store.write("canvas", "c1", {"elements": [{"id": "v3"}]}, base=None, force=True)  # within 10 minutes: not kept
    assert [v["at"] for v in h.versions("canvases/c1.excalidraw")] == [1_800_000_000_000]
    assert h.read("canvases/c1.excalidraw", 1_800_000_000_000) == before
    assert not str(h.dir).startswith(str(store.root))
    for i in range(60):
        now[0] += 601
        store.write("canvas", "c1", {"elements": [{"id": f"v{i}"}]}, base=None, force=True)
    assert len(h.versions("canvases/c1.excalidraw")) == 50
    now[0] += 31 * 86400
    store.write("canvas", "c1", {"elements": [{"id": "late"}]}, base=None, force=True)
    assert len(h.versions("canvases/c1.excalidraw")) == 1  # older than 30 days: gone


def test_daily_backup_keeps_seven_and_restores_only_missing_files(store):
    now = [1_800_000_000.0]
    b = Backups(store, Local(store), clock=lambda: now[0])
    store.append_session("s-1", [{"t": "session", "session": {"id": "s-1"}}], base=None)
    assert b.make() is not None and b.make() is None  # once a day
    for _ in range(9):
        now[0] += 86400
        b.make()
    assert len(b.list()) == 7
    (store.dir / "sessions" / "s-1.jsonl").unlink()
    (store.dir / "local" / "instance.json").write_text((store.dir / "local" / "instance.json").read_text())  # still there
    got = b.restore()
    assert "sessions/s-1.jsonl" in got and "local/instance.json" not in got
    assert (store.dir / "sessions" / "s-1.jsonl").exists()


# ——— agora doctor after git clean -fdx ———
def agora(*args: str, cwd: Path, home: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(REPO), "HOME": str(home)}
    return subprocess.run([sys.executable, "-m", "agora_cli", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=90)


def test_doctor_puts_back_bindings_and_records_after_git_clean(store, home):
    store.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "A"}, {"id": "p-s-1", "kind": "session", "sessionId": "s-1", "title": "", "canvasId": "c1", "agent": "claude"}], "root": {}, "focused": "c1"}, base=None, force=True)
    store.append_session("s-1", [{"t": "session", "session": {"id": "s-1", "canvasId": "c1"}}, {"t": "turn", "turn": {"id": "t-1"}}], base=None)
    store.bind("s-1", agent="claude", model="haiku", native_id=NID, started=True)
    AgentHub(store).note_bind("s-1", "bind")
    claude_log(home, store.root, NID, [("hi", "hello")], days_ago=22)
    iid = Local(store).instance_id()
    assert agora("backup", cwd=store.root, home=home).returncode == 0
    before = {p.name: p.read_bytes() for p in (store.dir / "sessions").glob("*.*")}
    shutil.rmtree(store.dir / "sessions")
    shutil.rmtree(store.dir / "local")
    shutil.rmtree(store.dir / "run")  # git clean -fdx

    check = agora("doctor", cwd=store.root, home=home)
    assert check.returncode == 1 and "agora doctor --fix" in check.stdout, check.stdout
    shutil.rmtree(store.root / ".claude", ignore_errors=True)  # the skill link is an ignored file too
    fixed = agora("doctor", "--fix", cwd=store.root, home=home)
    assert "放回了" in fixed.stdout and "cleanupPeriodDays" in fixed.stdout and "重新链接了 agora-canvas skill" in fixed.stdout, fixed.stdout
    assert (store.root / ".claude" / "skills" / "agora-canvas").is_symlink()
    assert Local(ProjectStore(store.root)).instance_id() == iid  # same copy: socket, tunnel, backups line up
    after = {p.name: p.read_bytes() for p in (store.dir / "sessions").glob("*.*")}
    assert after == before  # records and binding exactly as they were
    js = json.loads(agora("doctor", "--json", cwd=store.root, home=home).stdout)
    assert not [f for f in js if f["what"] in ("records", "bindings") and f["level"] in ("warn", "error")]


def test_doctor_restores_a_binding_from_the_registry_when_there_is_no_backup(store, home):
    store.write("workspace", None, {"v": 2, "docs": [{"id": "c1", "kind": "canvas", "title": "A"}, {"id": "p-s-1", "kind": "session", "sessionId": "s-1", "title": ""}], "root": {}, "focused": "c1"}, base=None, force=True)
    store.bind("s-1", agent="pi", model="deepseek/deepseek-flash", native_id="pi-1", started=True)
    AgentHub(store).note_bind("s-1", "bind")
    (store.dir / "sessions" / "s-1.agent.json").unlink()
    r = agora("doctor", "--fix", cwd=store.root, home=home)
    assert "从本机注册表恢复了 1 个会话的绑定" in r.stdout, r.stdout
    b = store.read_binding("s-1")
    assert (b["agent"], b["model"], b["nativeId"], b["started"]) == ("pi", "deepseek/deepseek-flash", "pi-1", True)


def test_history_cli_lists_and_restores_a_version_and_keeps_the_one_it_replaces(store, home):
    """Review P2: the version a restore replaces is kept even inside the 10-minute window (before,
    a v3 written right after v2 was lost when v1 was restored)."""
    h = FileHistory(Local(store))
    store.on_overwrite = h.keep
    store.write("canvas", "c1", {"elements": [{"id": "v2"}]}, base=None, force=True)  # keeps box1 (v1)
    store.write("canvas", "c1", {"elements": [{"id": "v3"}]}, base=None, force=True)  # within 10 min: v2 not kept
    listing = agora("history", "canvases/c1.excalidraw", cwd=store.root, home=home)
    at = listing.stdout.split()[0]
    assert "before a write" in listing.stdout
    r = agora("history", "canvases/c1.excalidraw", "--restore", at, cwd=store.root, home=home)
    assert r.returncode == 0, r.stderr
    assert json.loads((store.dir / "canvases" / "c1.excalidraw").read_text())["elements"][0]["id"] == "box1"
    kept = [json.loads(h.read("canvases/c1.excalidraw", v["at"]))["elements"][0]["id"] for v in h.versions("canvases/c1.excalidraw")]
    assert kept[0] == "v3" and "box1" in kept  # the replaced v3 is there, newest


def test_a_log_deleted_while_followed_is_reported_missing(store, home, monkeypatch):
    """Claude's cleanup can run while the server is up: the follower notices within a relocation."""
    from server.canvas import sessions

    log = claude_log(home, store.root, NID, [("hi", "hello")])
    store.bind("s-1", agent="claude", native_id=NID, started=True)
    hub = AgentHub(store)
    lv = hub._get("s-1")
    hub._follow("s-1", lv)
    assert hub.status("s-1")["native"] is None
    log.unlink()
    monkeypatch.setattr(sessions, "RELOCATE_S", 0)
    hub._follow("s-1", lv)
    st = hub.status("s-1")
    assert st["native"]["state"] == "missing" and st["native"]["blocking"] is True
    assert any(i.get("text") == "hello" for i in lv.items.values())  # what was shown stays


def test_history_does_not_list_a_copy_s_fork_as_this_project_s_session(store, home):
    """Copies share session ids: the registry row for a session is this copy's record, not a fork's."""
    loc = Local(store)
    pid = store.info()["id"]
    claude_log(home, store.root, "orig-1", [("讨论", "好")], footer={"canvas": "c1", "session": "s-x", "project": pid})
    loc.note("bind", sessionId="s-x", agent="claude", nativeId="orig-1")
    loc.registry.append("rebind", projectId=pid, instanceId="another-copy", root="/elsewhere", sessionId="s-x", agent="claude", nativeId="fork-9")
    h = session_history(store, loc, Trash(store))
    rows = [r for r in h["rows"] if r.get("sessionId") == "s-x"]
    assert len(rows) == 1 and rows[0]["nativeId"] == "orig-1" and rows[0]["turns"] == 1
    assert "orig-1" not in {r["nativeId"] for r in h["found"]}  # one row, not a registry row plus a find

