"""The adapter move is behaviour-neutral: the frozen pre-adapter modules (tests/legacy/, commit
12f78eb) and the adapters give identical results on every recorded fixture.

Covered: log projection (every record, with and without a project root, and the parse state it
leaves), headless stream mapping (events, text, errors, session, usage), log lookup (every
state: found / missing / ambiguous / elsewhere, hints, Codex's index fallback), new-session
discovery, headless and interactive command lines, write-file extraction, history discovery.

Fields the adapters add later on purpose (tool facts: ``activity``, ``reads``, ``waitsUser``,
``spawn``) are stripped from the new output before comparing — they are additions, never changes.
``AGORA_PARITY_REAL=1`` additionally replays the newest real logs on this machine (read-only).
"""

from __future__ import annotations

import copy
import glob
import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

from server.canvas import agents, discover, transcript
from server.canvas.runner import ExecOptions, RunRequest
from tests.agent_fixtures import all_fixtures
from tests.legacy import agents_v0, discover_v0, transcript_v0

T1 = ("claude", "pi", "codex")
ADDED_TOOL_KEYS = ("activity", "reads", "waitsUser", "spawn")
STATE_FIELDS = ("busy", "pending", "last_text", "root", "turn", "turn_at", "codex_usage_records")


def strip_added(items: list[dict]) -> list[dict]:
    # Codex ``spawn_agent`` (SubAgentActivity started) is a new item: the old projection skipped it.
    out = [it for it in copy.deepcopy(items) if not (it.get("kind") == "tool" and (it.get("tool") or {}).get("name") == "spawn_agent" and (it.get("tool") or {}).get("activity") == "subagents")]
    for it in out:
        tool = it.get("tool")
        if isinstance(tool, dict):
            for k in ADDED_TOOL_KEYS:
                tool.pop(k, None)
    return out


def same_state(a, b) -> None:
    assert {f: getattr(a, f) for f in STATE_FIELDS} == {f: getattr(b, f) for f in STATE_FIELDS}


def lk(x):
    """A LogLookup as plain data (the frozen copy has its own LogLookup class)."""
    return (x.state, x.path, x.candidates)


def records(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


FIXTURES = [(k, v) for k, v in all_fixtures() if k in T1]


def replay_both(kind: str, recs: list[dict], root: str | None) -> None:
    old, new = transcript_v0.State(root=root), transcript.State(root=root)
    for i, rec in enumerate(recs):
        o = transcript_v0.project(kind, copy.deepcopy(rec), old)
        n = transcript.project(kind, copy.deepcopy(rec), new)
        assert (strip_added(n[0]), n[1]) == o, f"{kind} record {i} differs"
        same_state(old, new)


@pytest.mark.parametrize("root", [None, "/work/project"])
@pytest.mark.parametrize("kind,folder", FIXTURES, ids=[f"{k}-{v.name}" for k, v in FIXTURES])
def test_projection_is_identical(kind, folder, root):
    log = folder / "log.jsonl"
    if not log.exists():
        pytest.skip("no session log in this fixture")
    replay_both(kind, records(log), root)


MAPPERS = {"claude": ("ClaudeStream", "sonnet", "00000000-0000-0000-0000-000000000001"), "pi": ("PiStream", None, "p-1"), "codex": ("CodexStream", "gpt-5", None)}


@pytest.mark.parametrize("kind,folder", FIXTURES, ids=[f"{k}-{v.name}" for k, v in FIXTURES])
def test_stream_mapping_is_identical(kind, folder):
    stream = folder / "stream.jsonl"
    if not stream.exists():
        pytest.skip("no headless stream in this fixture")
    cls, model, session = MAPPERS[kind]
    old, new = getattr(agents_v0, cls)(model, session), getattr(agents, cls)(model, session)
    for i, rec in enumerate(records(stream)):
        assert new.feed(copy.deepcopy(rec), 1000 + i) == old.feed(copy.deepcopy(rec), 1000 + i)
    for attr in ("model", "session", "text", "error", "usage", "done"):
        assert getattr(new, attr) == getattr(old, attr), attr
    assert new.final_usage(1234) == old.final_usage(1234)


def test_usage_helpers_are_identical():
    samples = [None, {}, {"input": 5, "output": 7, "cacheRead": 3, "cacheWrite": 1, "cost": {"total": 0.25}}, {"input_tokens": 10, "cached_input_tokens": 4, "output_tokens": 2}, {"input_tokens": 3}]
    for u in samples:
        assert agents.pi_usage(u, "m") == agents_v0.pi_usage(u, "m")
        assert agents.codex_usage(u, "m") == agents_v0.codex_usage(u, "m")
    a, b = agents.pi_usage(samples[2], "m"), agents.codex_usage(samples[3], "x")
    assert agents.add_usage(a, b) == agents_v0.add_usage(a, b)


def test_text_of_and_files_are_identical():
    for c in ["plain", [{"type": "text", "text": "a"}, {"type": "input_text", "text": "b"}, {"type": "image"}], None, 3]:
        assert agents.text_of(c) == agents_v0.text_of(c)
    root = "/work/project"
    for name in ("Edit", "MultiEdit", "Write", "NotebookEdit", "Read", "Bash"):
        for inp in ({"file_path": "/work/project/a.py"}, {"notebook_path": "/elsewhere/n.ipynb"}, {"file_path": ""}, "x", None):
            assert transcript.claude_files(name, inp, root) == transcript_v0.claude_files(name, inp, root)
    for name in ("edit", "write", "multi_edit", "MultiEdit", "read", "bash"):
        for inp in ({"path": "src/a.ts"}, {"file_path": "/work/project/b.ts"}, {}, None):
            assert transcript.pi_files(name, inp, root) == transcript_v0.pi_files(name, inp, root)
    changes = {"/work/project/a.py": {"type": "update", "unified_diff": "@@"}, "new.txt": {"type": "add", "content": "x"}, "/tmp/z": {"type": "delete"}, "w": None}
    assert transcript.codex_files(changes, root) == transcript_v0.codex_files(changes, root)
    assert transcript.codex_diff(changes) == transcript_v0.codex_diff(changes)
    assert transcript.codex_diff("raw") == transcript_v0.codex_diff("raw")
    for p in ("/work/project/x/y.py", "rel/./z.py", "/other/q", ""):
        assert transcript.rel_path(p, root) == transcript_v0.rel_path(p, root)


# ——— locating logs ———
NID = "11111111-2222-3333-4444-555555555555"
CX = "01a0e3b5-c627-77a3-8ebf-d10f61f21007"


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    monkeypatch.setenv("HOME", str(h))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.delenv("PI_CODING_AGENT_SESSION_DIR", raising=False)
    return h


def put(p: Path, text: str = "{}\n") -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


def build_home(home: Path) -> dict[str, str]:
    roots = {"a": "/work/a", "b": "/work/b", "c": "/work/c.d e"}
    cl = home / ".claude" / "projects"
    put(cl / agents_v0.claude_dir_name(roots["a"]) / f"{NID}.jsonl")
    put(cl / agents_v0.claude_dir_name(roots["b"]) / f"{NID}.jsonl")  # a duplicate elsewhere
    put(cl / agents_v0.claude_dir_name(roots["c"]) / "solo-1.jsonl")
    pi = home / ".pi" / "agent" / "sessions"
    put(pi / agents_v0.pi_dir_name(roots["a"]) / f"2026-09-28T01-00-00_{NID}.jsonl", json.dumps({"type": "session", "version": 3, "id": NID, "cwd": roots["a"]}) + "\n")
    put(pi / agents_v0.pi_dir_name(roots["b"]) / "2026-09-28T01-00-00_pi-elsewhere.jsonl")
    put(pi / agents_v0.pi_dir_name(roots["a"]) / "2026-09-28T01-00-00_pi-twice.jsonl")
    put(pi / agents_v0.pi_dir_name(roots["a"]) / "2026-09-29T01-00-00_pi-twice.jsonl")
    cx = home / ".codex" / "sessions" / "2026" / "09" / "28"
    put(cx / f"rollout-2026-09-28T01-00-00-{CX}.jsonl", json.dumps({"type": "session_meta", "payload": {"id": CX, "cwd": roots["a"]}}) + "\n")
    put(cx / "rollout-2026-09-28T02-00-00-cx-other.jsonl", json.dumps({"type": "session_meta", "payload": {"id": "cx-other", "cwd": roots["b"]}}) + "\n")
    archived = put(home / "archive" / "rollout-2026-09-01T00-00-00-cx-archived.jsonl", json.dumps({"type": "session_meta", "payload": {"id": "cx-archived", "cwd": roots["a"]}}) + "\n")
    db = home / ".codex" / "state_5.sqlite"
    con = sqlite3.connect(db)
    con.execute("create table threads (id text primary key, rollout_path text, cwd text)")
    con.executemany("insert into threads values (?,?,?)", [(CX, str(cx / f"rollout-2026-09-28T01-00-00-{CX}.jsonl"), roots["a"]), ("cx-archived", str(archived), roots["a"]), ("cx-gone", str(home / "nowhere.jsonl"), roots["a"])])
    con.commit()
    con.close()
    return roots


def test_log_lookup_is_identical(home):
    roots = build_home(home)
    ids = [NID, "solo-1", "pi-elsewhere", "pi-twice", CX, "cx-other", "cx-archived", "cx-gone", "nobody", None, ""]
    for kind in T1:
        for nid in ids:
            for root in [None, *roots.values(), "/work/none"]:
                for hint in (None, str(home / "archive" / "rollout-2026-09-01T00-00-00-cx-archived.jsonl"), str(home / "missing.jsonl")):
                    assert lk(agents.locate_log(kind, nid, root, home, hint)) == lk(agents_v0.locate_log(kind, nid, root, home, hint)), (kind, nid, root, hint)
        for nid in ids:
            if nid:
                assert agents.find_log(kind, nid, roots["a"]) == agents_v0.find_log(kind, nid, roots["a"])
                assert lk(agents.check_native(kind, nid, False, roots["a"])) == lk(agents_v0.check_native(kind, nid, False, roots["a"]))
    assert agents.codex_state_rollout("cx-archived", home) == agents_v0.codex_state_rollout("cx-archived", home)
    with pytest.raises(ValueError):
        agents.locate_log("nope", NID)


def test_new_session_discovery_is_identical(home):
    roots = build_home(home)
    since = time.time() - 60
    for kind in T1:
        for root in roots.values():
            for taken in (set(), {NID, CX}, {"solo-1", "pi-twice"}):
                assert agents.new_native_since(kind, root, since, taken, home) == agents_v0.new_native_since(kind, root, since, taken, home)
            assert agents.new_native_since(kind, root, time.time() + 3600, set(), home) == agents_v0.new_native_since(kind, root, time.time() + 3600, set(), home)
    for root in roots.values():
        assert agents.codex_rollouts_since(Path(root), since, home) == agents_v0.codex_rollouts_since(Path(root), since, home)


def test_history_discovery_is_identical(home):
    roots = build_home(home)
    rs = list(roots.values())
    key = lambda r: (r["agent"], r["nativeId"], str(r["path"]), r.get("cwd"))  # noqa: E731
    assert sorted(map(key, discover.native_sessions(rs, home))) == sorted(map(key, discover_v0.native_sessions(rs, home)))
    for kind, folder in FIXTURES:
        log = folder / "log.jsonl"
        if log.exists():
            assert discover.scan_log(kind, log, want="Redis") == discover_v0.scan_log(kind, log, want="Redis")
            assert discover.scan_log(kind, log) == discover_v0.scan_log(kind, log)


# ——— command lines ———
def requests(cwd: str) -> list[RunRequest]:
    out = []
    for session in (None, NID):
        for new in (True, False):
            for fork in (None, ("src-1", "/logs/src.jsonl")):
                for model, effort in (("", None), ("haiku", "low")):
                    o = ExecOptions(backend="x", model=model, effort=effort, session=session, new_session=new, fork_from=fork[0] if fork else None, fork_path=fork[1] if fork else None)
                    out.append(RunRequest(schema=None, system=None, prompt="hi there", options=o, cwd=cwd))
    return out


def test_headless_args_are_identical(home):
    roots = build_home(home)
    for name in ("ClaudeCodeBackend", "PiBackend", "CodexBackend"):
        for req in requests(roots["a"]) + requests("/work/none"):
            new_b, old_b = getattr(agents, name)(), getattr(agents_v0, name)()
            try:
                want = old_b.args(req)
            except ValueError as e:
                with pytest.raises(ValueError, match=str(e)):
                    new_b.args(req)
                continue
            assert new_b.args(req) == want
            assert new_b.stdin(req) == old_b.stdin(req)


def test_interactive_argv_is_identical(home):
    roots = build_home(home)
    for kind in T1:
        for nid in (None, NID, "fresh-1"):
            for model, effort in (("", ""), (None, None), ("opus", "high")):
                for new in (True, False):
                    for root in (None, roots["a"], "/work/none"):
                        assert agents.interactive_argv(kind, nid, model, effort, new=new, root=root) == agents_v0.interactive_argv(kind, nid, model, effort, new=new, root=root)
            for fork in ({"from": "src-1"}, {"from": "src-1", "path": "/logs/src.jsonl"}):
                assert agents.interactive_argv(kind, None, "m", "e", fork=fork) == agents_v0.interactive_argv(kind, None, "m", "e", fork=fork)


def test_registry_constants_are_identical(monkeypatch):
    assert agents.KINDS == agents_v0.KINDS
    assert agents.NAMES == agents_v0.NAMES
    assert agents.SKILL_DIRS == agents_v0.SKILL_DIRS
    from server.canvas import agent_models

    monkeypatch.setattr(agent_models, "SOURCES", {k: (lambda env, root, k=k: {"default": f"{k}-m", "models": [f"{k}-m"]}) for k in T1})
    monkeypatch.setattr(agents, "_catalog_cache", {})
    monkeypatch.setattr(agents_v0, "_catalog_cache", {})
    new, old = agents.catalog(None), agents_v0.catalog(None)
    assert new == old


# ——— real logs on this machine (opt-in, read-only) ———
REAL = os.environ.get("AGORA_PARITY_REAL") == "1"


@pytest.mark.skipif(not REAL, reason="AGORA_PARITY_REAL=1 replays real local logs")
@pytest.mark.parametrize("kind,pattern", [("claude", "~/.claude/projects/*/*.jsonl"), ("pi", "~/.pi/agent/sessions/*/*.jsonl"), ("codex", "~/.codex/sessions/*/*/*/rollout-*.jsonl")])
def test_real_logs_project_identically(kind, pattern):
    n = int(os.environ.get("AGORA_PARITY_REAL_N", "40"))
    files = sorted(glob.glob(os.path.expanduser(pattern)), key=os.path.getmtime, reverse=True)[:n]
    if not files:
        pytest.skip(f"no {kind} logs here")
    for f in files:
        with open(f, "rb") as fh:
            raw = fh.read(20 * 1024 * 1024)
        recs = []
        for line in raw.split(b"\n"):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict):
                recs.append(r)
        replay_both(kind, recs, "/work/project")
