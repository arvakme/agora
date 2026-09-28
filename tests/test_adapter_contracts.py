"""Contract tests: every recorded fixture of every CLI version (tests/fixtures/agents/<kind>/<version>/)
must still be understood by its adapter (web/docs/cli-adapters.md §6).

Per fixture: the adapter finds the session in a temporary HOME; the log projects into at least one
user → … → end turn; every record type is one the adapter knows, except those the fixture's
``meta.json`` lists in ``expected_unknown`` (that is how a new CLI version's drift is written down);
and whatever ``meta.json`` ``expected`` promises (written files, a shell command, sub-agents) holds.
A new CLI version is covered by adding its folder — no test code changes.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from server.canvas import adapters
from server.canvas.adapters import drift
from server.canvas.transcript import State, project
from tests.agent_fixtures import all_fixtures, meta

from server.canvas.adapters import registry

# Every recorded fixture, including v2 adapters behind a flag: the test turns the flag on (review P2-10).
KNOWN = {c().kind for c in registry.BUILTIN} | set(registry.EXPERIMENTAL)
FIXTURES = [(k, v) for k, v in all_fixtures() if k in KNOWN]
IDS = [f"{k}-{v.name}" for k, v in FIXTURES]
# Tools that run a shell command, per CLI (a fixture's meta.json may name its own: command_tools).
SHELL_TOOLS = {"claude": ["Bash"], "codex": ["shell"], "pi": ["bash"], "grok": ["run_terminal_command"]}


@pytest.fixture()
def flags(monkeypatch):
    """Enable the experimental adapters for this test, and restore the registry afterwards."""
    monkeypatch.setenv("AGORA_EXPERIMENTAL", ",".join(registry.EXPERIMENTAL))
    registry.refresh()
    yield
    monkeypatch.delenv("AGORA_EXPERIMENTAL")
    registry.refresh()


def log_of(folder: Path) -> Path | None:
    for name in ("log.jsonl", "updates.jsonl"):
        if (folder / name).exists():
            return folder / name
    return None


def install(kind: str, folder: Path, home: Path, cwd: str, nid: str) -> Path:
    """Put the fixture's log where the CLI keeps it (the adapter's Locator must find it there)."""
    a = adapters.need(kind)
    place = getattr(a, "fixture_place", None)
    if place is not None:
        return place(folder, home, cwd, nid)
    src = log_of(folder)
    assert src is not None
    if kind == "claude":
        dst = home / ".claude" / "projects" / a.log_dir_name(cwd) / f"{nid}.jsonl"
    elif kind == "pi":
        dst = home / ".pi" / "agent" / "sessions" / a.log_dir_name(cwd) / f"2026-09-28T00-00-00-000Z_{nid}.jsonl"
    elif kind == "codex":
        dst = home / ".codex" / "sessions" / "2026" / "09" / "28" / f"rollout-2026-09-28T00-00-00-{nid}.jsonl"
    else:
        pytest.skip(f"no placement rule for {kind}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dst)
    if kind == "claude" and (folder / "subagents").is_dir():  # <dir>/<id>/subagents/agent-*.jsonl
        shutil.copytree(folder / "subagents", dst.parent / nid / "subagents")
    if kind == "codex" and (folder / "children").is_dir():  # child threads are rollouts of their own
        for c in (folder / "children").glob("*.jsonl"):
            shutil.copy(c, dst.parent / f"rollout-2026-09-28T00-00-01-{c.stem}.jsonl")
    return dst


@pytest.fixture()
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    for v in ("CODEX_HOME", "PI_CODING_AGENT_SESSION_DIR", "GROK_HOME"):
        monkeypatch.delenv(v, raising=False)
    return h


def replay(kind: str, log: Path, root: str) -> tuple[list[dict], list[dict], State]:
    st = State(root=root)
    items: dict[str, dict] = {}
    turns: list[dict] = []
    for line in log.read_text().splitlines():
        if not line.strip():
            continue
        its, tcs = project(kind, json.loads(line), st)
        for it in its:
            prev = items.get(it["id"], {})
            items[it["id"]] = {**prev, **it, "tool": {**prev.get("tool", {}), **it.get("tool", {})}} if it["kind"] == "tool" else {**prev, **it}
        turns += tcs
    return list(items.values()), turns, st


@pytest.mark.parametrize("kind,folder", FIXTURES, ids=IDS)
def test_fixture_contract(kind, folder, home, flags):
    check_contract(kind, folder, home)


def check_contract(kind, folder, home):
    m = meta(folder)
    log = log_of(folder)
    if log is None:
        pytest.skip("stream-only fixture")
    cwd = m.get("cwd") or "/work/project"
    nid = m.get("native_id") or "00000000-aaaa-bbbb-cccc-000000000001"
    install(kind, folder, home, cwd, nid)
    a = adapters.need(kind)

    # 1. found where the CLI keeps it
    look = a.locate(nid, cwd, home)
    assert look.state == "found", look

    # 2. a user → … → end turn
    items, turns, st = replay(kind, look.path, cwd)
    kinds = [i["kind"] for i in items]
    assert "user" in kinds and "end" in kinds or any(t["turn"] == "end" for t in turns), kinds
    assert any(t["turn"] == "start" for t in turns)

    # 3. no record type the adapter does not know, beyond what the fixture declares
    got = drift.scan(a, look.path)["unknown"]
    assert set(got) == set(m.get("expected_unknown") or []), f"unknown record types {got} — add them to the adapter or to meta.json expected_unknown"

    # 4. what the recording promises
    exp = m.get("expected") or {}
    tools = [i["tool"] for i in items if i["kind"] == "tool"]
    # Written by the session or any of its sub-agents (the whole run tree).
    from server.canvas.adapters import runs as runs_mod
    from server.canvas.adapters.base import NativeRef

    tree = runs_mod.build(NativeRef(kind, nid, look.path, cwd), root=cwd, depth=None, home=home, receipts=False)
    written = {s.get("path") for r in tree["runs"] for s in r["timeline"]["segments"] if s["kind"] == "write"}
    for path in exp.get("files", []):
        assert path in written, (path, written)
    if exp.get("commands"):
        shell = exp.get("command_tools") or SHELL_TOOLS[kind]
        ran = [t for t in tools if t.get("name") in shell and t.get("activity") in ("commands", "read", "search")]
        assert len(ran) >= exp["commands"], (shell, [t.get("name") for t in tools])
    for act in exp.get("activities", []):
        assert any(t.get("activity") == act for t in tools), act
    if exp.get("subagents"):
        subs = getattr(a, "children", None)
        assert subs is not None, "fixture has sub-agents but the adapter has no Subagents capability"
        from server.canvas.adapters.base import NativeRef

        kids = subs(NativeRef(kind, nid, look.path, cwd), home)
        assert len(kids) >= exp["subagents"], kids
        assert all(k.parent is not None and k.parent.via == "native" for k in kids)


def test_every_adapter_has_a_fixture(flags):
    have = {k for k, _ in FIXTURES}
    assert set(adapters.ADAPTERS) == KNOWN
    for k, a in adapters.ADAPTERS.items():
        if adapters.implemented_tier(a) in ("T1", "T2") and not getattr(a, "stub", False):
            assert k in have, f"{k} has no recorded fixture under tests/fixtures/agents/{k}/"


def test_the_shell_command_check_can_fail(home, flags, tmp_path):
    """Review P2-10: the command check used to default to every tool name, so it could never fail."""
    import shutil

    src = next(v for k, v in FIXTURES if k == "claude" and (v / "stream.jsonl").exists() and v.name != "unversioned")
    f = tmp_path / "claude-no-shell"
    shutil.copytree(src, f)
    m = json.loads((f / "meta.json").read_text())
    m["expected"]["command_tools"] = ["NoSuchTool"]
    (f / "meta.json").write_text(json.dumps(m))
    with pytest.raises(AssertionError):
        check_contract("claude", f, home)
