"""Per-project storage (.agora/): format, atomic versioned writes, conflicts, routes, isolation."""

import json
import threading
from pathlib import Path

import httpx
import pytest
from fastapi import APIRouter

from server.canvas.project import GITIGNORE, Conflict, NotEmpty, ProjectStore, fold_session, version_of
from server.canvas.project_router import create_project_app, exec_options

EL = {"id": "a", "type": "rectangle", "x": 1, "y": 2, "width": 3, "height": 4, "isDeleted": False}


def store(tmp_path: Path, name="p") -> ProjectStore:
    s = ProjectStore(tmp_path / name)
    s.root.mkdir(parents=True, exist_ok=True)
    s.init()
    return s


def client(root: Path) -> httpx.AsyncClient:
    app = create_project_app(root, canvas_router=APIRouter(), dist=root / "no-dist")
    # A local Host: the owner app refuses other names (DNS rebinding, project_router.LocalHostOnly).
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1")


# ——— layout ———
def test_init_creates_layout_config_and_gitignore(tmp_path):
    s = store(tmp_path)
    assert {p.name for p in s.dir.iterdir()} >= {"config.toml", ".gitignore", "canvases", "threads", "sessions", "run"}
    assert (s.dir / ".gitignore").read_text() == GITIGNORE
    ignored = [l for l in GITIGNORE.splitlines() if l and not l.startswith("#")]
    assert ignored == ["sessions/", "run/", "shares/", "local/", "trash/", "*.tmp", "*.lock"]
    cfg = s.config()
    assert cfg["project"]["name"] == "p" and cfg["server"]["port"] == 0 and "pi" not in cfg  # sessions bind their own agent
    first_id = cfg["project"]["id"]
    assert s.init() is False and s.config()["project"]["id"] == first_id  # idempotent, never rewrites config


def test_gitignore_is_honoured_by_git(tmp_path):
    import subprocess

    s = store(tmp_path)
    subprocess.run(["git", "init", "-q", str(s.root)], check=True)
    s.write("canvas", "c1", {"elements": [EL]}, base=None)
    s.write("threads", "c1", {"threads": [], "seq": 0}, base=None)
    s.write("workspace", None, {"v": 2}, base=None)
    s.append_session("s1", [{"t": "session", "session": {"id": "s1"}}], base=None)
    out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=s.root, capture_output=True, text=True).stdout
    tracked = sorted(l[3:] for l in out.splitlines())
    assert tracked == [
        ".agora/.gitignore",
        ".agora/canvases/c1.excalidraw",
        ".agora/config.toml",
        ".agora/threads/c1.json",
        ".agora/workspace.json",
    ]


# ——— canvas format ———
def test_canvas_is_stable_excalidraw_json(tmp_path):
    s = store(tmp_path)
    s.write("canvas", "c1", {"elements": [{"y": 2, "id": "a", "x": 1}, {"id": "gone", "isDeleted": True}]}, base=None)
    text = (s.dir / "canvases" / "c1.excalidraw").read_text()
    doc = json.loads(text)
    assert doc["type"] == "excalidraw" and doc["version"] == 2 and doc["files"] == {}
    assert [e["id"] for e in doc["elements"]] == ["a"]  # deleted elements are not stored
    assert text.endswith("\n") and '\n  "appState"' in text  # indented
    assert text.index('"id": "a"') < text.index('"x": 1') < text.index('"y": 2')  # sorted keys
    # Same content in a different key order → same bytes, same version, no rewrite.
    v1 = version_of(text.encode())
    assert s.write("canvas", "c1", {"elements": [{"x": 1, "id": "a", "y": 2}]}, base="stale") == v1


# ——— atomic writes and conflicts ———
def test_versioned_write_detects_conflict(tmp_path):
    s = store(tmp_path)
    v1 = s.write("workspace", None, {"n": 1}, base=None)
    v2 = s.write("workspace", None, {"n": 2}, base=v1)  # writer A
    with pytest.raises(Conflict) as e:  # writer B still holds v1
        s.write("workspace", None, {"n": 3}, base=v1)
    assert e.value.current == v2 and e.value.file == "workspace.json"
    assert s.read("workspace") == ({"n": 2}, v2)
    v3 = s.write("workspace", None, {"n": 3}, base=v1, force=True)  # "keep mine"
    assert s.read("workspace") == ({"n": 3}, v3)
    with pytest.raises(Conflict):  # creating over an existing file also conflicts
        s.write("workspace", None, {"n": 4}, base=None)


def test_external_edit_is_a_conflict(tmp_path):
    s = store(tmp_path)
    v = s.write("threads", "c1", {"threads": [], "seq": 0}, base=None)
    (s.dir / "threads" / "c1.json").write_text('{"threads": [], "seq": 9}\n')  # e.g. git checkout
    with pytest.raises(Conflict):
        s.write("threads", "c1", {"threads": [], "seq": 1}, base=v)


def test_writes_are_atomic_and_leave_no_temp_files(tmp_path, monkeypatch):
    s = store(tmp_path)
    v = s.write("canvas", "c1", {"elements": [EL]}, base=None)
    before = (s.dir / "canvases" / "c1.excalidraw").read_bytes()

    import server.canvas.project as proj

    real_replace = proj.os.replace

    def boom(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(proj.os, "replace", boom)
    with pytest.raises(OSError):
        s.write("canvas", "c1", {"elements": [{**EL, "x": 99}]}, base=v)
    monkeypatch.setattr(proj.os, "replace", real_replace)
    assert (s.dir / "canvases" / "c1.excalidraw").read_bytes() == before  # old file intact
    assert not list(s.dir.rglob("*.tmp"))


def test_concurrent_writers_one_wins_rest_conflict(tmp_path):
    s = store(tmp_path)
    v0 = s.write("workspace", None, {"n": 0}, base=None)
    results: list[str] = []

    def writer(i: int):
        try:
            s.write("workspace", None, {"n": i}, base=v0)
            results.append("ok")
        except Conflict:
            results.append("conflict")

    ts = [threading.Thread(target=writer, args=(i,)) for i in range(1, 9)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sorted(results) == ["conflict"] * 7 + ["ok"]


def test_invalid_ids_rejected(tmp_path):
    s = store(tmp_path)
    for bad in ("../x", ".hidden", "a/b", ""):
        with pytest.raises(ValueError):
            s.write("canvas", bad, {"elements": []}, base=None)


# ——— sessions ———
def test_session_log_appends_and_folds(tmp_path):
    s = store(tmp_path)
    v1 = s.append_session("s1", [{"t": "session", "session": {"id": "s1", "canvasId": "c1", "turnIds": []}}], base=None)
    v2 = s.append_session(
        "s1",
        [
            {"t": "session", "session": {"id": "s1", "canvasId": "c1", "turnIds": ["t1"]}},
            {"t": "turn", "turn": {"id": "t1", "status": "running", "steps": []}},
        ],
        base=v1,
    )
    v3 = s.append_session(
        "s1",
        [{"t": "turn", "turn": {"id": "t1", "status": "applied", "steps": [{"id": "st1"}]}}, {"t": "batch", "id": "b1", "batch": {"before": [], "after": []}}],
        base=v2,
    )
    lines = (s.dir / "sessions" / "s1.jsonl").read_text().splitlines()
    assert len(lines) == 5  # append-only: history kept
    state, v = s.read_session("s1")
    assert v == v3
    assert state["session"]["turnIds"] == ["t1"] and state["turns"]["t1"]["status"] == "applied" and "b1" in state["batches"]
    with pytest.raises(Conflict):
        s.append_session("s1", [{"t": "turn", "turn": {"id": "t2"}}], base=v2)
    with pytest.raises(ValueError):
        s.append_session("s1", [{"t": "nope"}], base=v3)


def test_torn_last_line_is_ignored(tmp_path):
    s = store(tmp_path)
    s.append_session("s1", [{"t": "turn", "turn": {"id": "t1"}}], base=None)
    with open(s.dir / "sessions" / "s1.jsonl", "a") as fh:
        fh.write('{"t":"turn","turn":{"id":')
    assert fold_session(s._session_lines((s.dir / "sessions" / "s1.jsonl").read_bytes()))["turns"] == {"t1": {"id": "t1"}}


# ——— import ———
def test_import_only_into_empty_project(tmp_path):
    s = store(tmp_path)
    assert s.is_empty()
    s.import_all(
        {
            "workspace": {"v": 2, "docs": []},
            "canvases": {"c1": {"scene": {"elements": [EL]}, "threads": {"threads": [], "seq": 0}}},
            "sessions": {"s1": [{"t": "session", "session": {"id": "s1"}}]},
        }
    )
    snap = s.snapshot()
    assert not snap["empty"] and snap["canvases"]["c1"]["scene"]["elements"][0]["id"] == "a"
    assert snap["sessions"]["s1"]["state"]["session"] == {"id": "s1"}
    with pytest.raises(NotEmpty):
        s.import_all({"workspace": {}})


# ——— routes ———
async def test_routes_roundtrip_and_409(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    async with client(root) as c:
        info = (await c.get("/api/project")).json()
        assert info["name"] == "proj" and info["empty"] is True and info["me"]["id"] and info["me"]["name"]
        r = await c.put("/api/project/canvases/c1", json={"data": {"elements": [EL]}, "base": None})
        v1 = r.json()["version"]
        r = await c.put("/api/project/threads/c1", json={"data": {"threads": [{"id": "t", "messages": []}], "seq": 1}, "base": None})
        assert r.status_code == 200
        r = await c.put("/api/project/canvases/c1", json={"data": {"elements": [{**EL, "x": 5}]}, "base": v1})
        v2 = r.json()["version"]
        r = await c.put("/api/project/canvases/c1", json={"data": {"elements": [{**EL, "x": 6}]}, "base": v1})
        assert r.status_code == 409 and r.json() == {"conflict": True, "file": "canvases/c1.excalidraw", "current": v2, "base": v1}
        r = await c.put("/api/project/canvases/c1", json={"data": {"elements": [{**EL, "x": 6}]}, "base": v1, "force": True})
        assert r.status_code == 200
        ws = await c.put("/api/project/workspace", json={"data": {"v": 2, "docs": [{"id": "c1"}]}, "base": None})
        assert ws.status_code == 200
        a = await c.post("/api/project/sessions/s1/append", json={"records": [{"t": "session", "session": {"id": "s1"}}], "base": None})
        b = await c.post("/api/project/sessions/s1/append", json={"records": [{"t": "turn", "turn": {"id": "t1"}}], "base": a.json()["version"]})
        assert b.status_code == 200
        snap = (await c.get("/api/project/snapshot")).json()
        assert snap["empty"] is False
        assert snap["canvases"]["c1"]["scene"]["elements"][0]["x"] == 6
        assert snap["canvases"]["c1"]["threads"]["data"]["seq"] == 1
        assert snap["sessions"]["s1"]["state"]["turns"] == {"t1": {"id": "t1"}}
        assert (await c.put("/api/project/canvases/..bad", json={"data": {}, "base": None})).status_code == 400
        assert (await c.post("/api/project/trash/canvas/c1", json={})).status_code == 200  # deleting = into the trash
        assert not (root / ".agora" / "threads" / "c1.json").exists()
        assert (await c.post("/api/project/trash/session/s1", json={})).status_code == 200
        assert not (root / ".agora" / "sessions" / "s1.jsonl").exists()
        assert (await c.post("/api/project/import", json={"workspace": {}})).status_code == 409  # workspace.json exists
        assert "前端还没有构建" in (await c.get("/")).text


async def test_two_projects_are_isolated(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(), b.mkdir()
    async with client(a) as ca, client(b) as cb:
        await ca.put("/api/project/canvases/c1", json={"data": {"elements": [EL]}, "base": None})
        await ca.put("/api/project/workspace", json={"data": {"owner": "a"}, "base": None})
        # Same ids in project b: no conflict (different files), different content.
        rb = await cb.put("/api/project/workspace", json={"data": {"owner": "b"}, "base": None})
        assert rb.status_code == 200
        sa, sb = (await ca.get("/api/project/snapshot")).json(), (await cb.get("/api/project/snapshot")).json()
    assert sa["workspace"]["data"] == {"owner": "a"} and sb["workspace"]["data"] == {"owner": "b"}
    assert "c1" in sa["canvases"] and sb["canvases"] == {}
    assert sa["id"] != sb["id"] and sa["root"] != sb["root"]


def test_exec_options_from_config(tmp_path):
    s = store(tmp_path)
    cfg = (s.dir / "config.toml").read_text().replace('model = "claude-sonnet-5"', 'model = "m-x"').replace('effort = ""', 'effort = "high"')
    (s.dir / "config.toml").write_text(cfg)
    o = exec_options(s, env={})
    assert (o.model, o.effort, o.backend) == ("m-x", "high", "claude-cli")
    assert exec_options(s, env={"AGORA_CANVAS_MODEL": "env-m"}).model == "env-m"
