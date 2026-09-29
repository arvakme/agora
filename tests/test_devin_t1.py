"""Devin as a session agent (T1): headless through a small wrapper (``devin -p`` prints only the final
text, the turn itself lives in the CLI's SQLite log), the interactive command, the model catalog, and
following the database as a live log. The facts come from tests/../round-04 evidence T1-devin/spike.md;
the fake ``devin`` here stands in for the CLI so no model runs."""

import json
import os
import signal
import sqlite3
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from server.canvas import adapters, agents
from server.canvas.adapters import registry
from server.canvas.adapters import devin as devin_module
from server.canvas.adapters.base import Binding, Catalog, Headless, Interactive
from server.canvas.adapters.common import State
from server.canvas.adapters.devin import DevinAdapter, DevinStream, catalog_from
from server.canvas.runner import ExecOptions, RunRequest
from tests.agent_fixtures import fixture
from tests.native_logs import DevinSession, devin_db

CWD = "/work/p"
T0 = 1790500000000
WRAPPER = Path(devin_module.__file__).with_name("devin_run.py")
YES = ["--permission-mode", "dangerous", "--respect-workspace-trust", "false"]


def devin():
    return adapters.need("devin")


def req(prompt="hi", **o) -> RunRequest:
    return RunRequest(schema=None, system=None, prompt=prompt, options=ExecOptions(backend="devin", model=o.pop("model", ""), **o), cwd=CWD)


# ——— the tier ———
def test_devin_is_a_session_agent_now():
    a = devin()
    assert a.max_tier == "T1" and registry.implemented_tier(a) == "T1"
    assert isinstance(a, Headless) and isinstance(a, Interactive) and isinstance(a, Catalog) and isinstance(a, Binding)
    assert "devin" in agents.KINDS and agents.NAMES["devin"] == "Devin"
    got = next(i for i in registry.adapter_infos(with_versions=False) if i["kind"] == "devin")
    assert got["tier"] == "T1" and got["caps"]["headless"] and got["caps"]["terminal"] and got["caps"]["catalog"]


def test_devin_reads_project_skills_from_agents_skills_like_codex():
    assert devin().project_skill_dir == ".agents/skills" and agents.SKILL_DIRS["devin"] == ".agents/skills"


# ——— headless argv: a wrapper runs devin, the prompt after «--» ———
def test_new_session_argv_asks_for_no_boundary_and_puts_the_prompt_last():
    argv = agents.BACKEND_CLASSES["devin"]().args(req("读 README.md\n只回一句", model="swe-2-medium"))
    assert argv[0] == sys.executable and Path(argv[1]) == WRAPPER
    assert argv[2:] == ["devin", "-p", *YES, "--model", "swe-2-medium", "--", "读 README.md\n只回一句"]


def test_resume_argv_names_the_session_before_the_prompt_and_a_dash_prompt_is_safe():
    argv = agents.BACKEND_CLASSES["devin"]().args(req("--help 是什么", session="harvest-breadfruit"))
    assert argv[2:] == ["devin", "-p", *YES, "-r", "harvest-breadfruit", "--", "--help 是什么"]


def test_the_prompt_goes_in_the_argv_not_on_stdin():
    b = agents.BACKEND_CLASSES["devin"]()
    assert b.stdin(req("x")) is None  # ``devin -p`` does not read stdin (spike §1)


def test_a_fork_is_only_possible_in_a_terminal():
    with pytest.raises(ValueError, match="分叉"):
        agents.BACKEND_CLASSES["devin"]().args(req("x", fork_from="old"))


# ——— interactive ———
def test_interactive_argv_starts_or_resumes_without_the_trust_dialog():
    assert agents.interactive_argv("devin", None, None, None, new=True) == ["devin", *YES]
    assert agents.interactive_argv("devin", "harvest-breadfruit", "swe-2-medium", "high") == ["devin", *YES, "-r", "harvest-breadfruit", "--model", "swe-2-medium"]  # the model name carries the strength: no separate effort


def test_the_pane_process_does_not_name_its_session():
    assert devin().claims_by_open_file is False and devin().native_from_open_files(["/x/.local/share/devin/cli/logs/devin_1_2.log"]) is None


# ——— catalog ———
def test_catalog_lists_the_model_variants_the_cli_offers():
    cat = catalog_from(json.loads(fixture("devin", "models.json", "3000.10.21").read_text()), {})
    assert cat["models"][0] == "adaptive" and "claude-opus-5-5-high" in cat["models"] and "swe-2-medium" in cat["models"]
    assert cat["names"]["claude-opus-5-5-high"] == "Claude Opus 5.5 High"
    assert cat["featured"] == ["adaptive", "swe-2-medium", "claude-opus-5-5-medium", "gpt-6-astra-medium"]  # each family once, at medium
    assert cat["efforts"] == [] and cat["modelEfforts"][""] == [] and cat["defaultEffort"] == ""
    assert cat["default"] == "" and cat["allowed"] is not None and set(cat["models"]) <= set(cat["allowed"])
    assert cat["scope"]["source"] == "devin models list"


def test_catalog_without_the_cli_is_empty_but_valid():
    cat = catalog_from(None, {})
    assert cat["models"] == [] and cat["allowed"] is None and cat["scope"]["source"] == "none"


# ——— the wrapper's events → the host's events ———
def feed(m, *events):
    out = []
    for i, e in enumerate(events):
        out += m.feed(e, 1000 + i)
    return out


def test_stream_reports_the_permission_mode_the_session_id_and_the_answer():
    m = DevinStream("swe-2-medium", None)
    evs = feed(m, {"type": "init", "mode": "dangerous", "model": "swe-2-medium"}, {"type": "session", "id": "harvest-breadfruit"}, {"type": "text", "text": "这是一个演示项目。"}, {"type": "turn_end", "code": 0, "stderr": ""})
    assert [e["t"] for e in evs] == ["mode", "session", "text"]
    assert evs[0]["mode"] == "dangerous" and evs[1]["session"] == "harvest-breadfruit"
    assert m.session == "harvest-breadfruit" and m.text == "这是一个演示项目。" and m.done and m.error is None


def test_a_recorded_run_maps_to_mode_session_text_and_done():
    """The wrapper's output for a real ``devin -p`` turn (recorded 2026-09-29, devin 3000.10.21)."""
    lines = [json.loads(line) for line in fixture("devin", "stream.jsonl", "3000.10.21").read_text().splitlines() if line.strip()]
    m = DevinStream("swe-2-medium", None)
    evs = feed(m, *lines)
    assert [e["t"] for e in evs] == ["mode", "session", "text"] and evs[0]["mode"] == "dangerous"
    assert m.session == "piquant-aquarius" and m.text.startswith("这是一个") and m.done and m.error is None


def test_a_failed_exit_is_an_error_with_the_cli_words():
    m = DevinStream("nope", None)
    feed(m, {"type": "init", "mode": "dangerous"}, {"type": "turn_end", "code": 1, "stderr": "Error: Unknown model: 'nope'"})
    assert m.done and m.error == "devin: Error: Unknown model: 'nope'"


def test_an_interrupted_turn_is_marked_and_is_no_error():
    m = DevinStream(None, "s1")
    feed(m, {"type": "init", "mode": "dangerous"}, {"type": "interrupted"})
    assert m.interrupted and m.error is None and m.done


def test_the_asked_mode_is_dangerous_not_auto():
    assert devin().asked_mode == "dangerous" and adapters.need("claude").asked_mode == "auto"


# ——— the wrapper itself, with a fake devin ———
FAKE = textwrap.dedent(
    """\
    #!{py}
    import json, os, sqlite3, subprocess, sys, time
    args = sys.argv[1:]
    open(os.environ["FAKE_ARGS"], "w").write(json.dumps(args))
    mode = os.environ.get("FAKE_MODE", "ok")
    if "-r" not in args:
        con = sqlite3.connect(os.path.expanduser("~/.local/share/devin/cli/sessions.db"))
        time.sleep(float(os.environ.get("FAKE_DELAY", "0.8")))
        con.execute("insert into sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, hidden) values (?,?,'windsurf','swe-2-medium','bypass',?,?,0)", ("fresh-otter", os.getcwd(), int(time.time()), int(time.time())))
        con.commit()
    if mode == "fail":
        sys.stderr.write("Error: Unknown model: 'x'\\n")
        sys.exit(1)
    if mode == "hang":
        child = subprocess.Popen(["sleep", "60"], start_new_session=True)  # like devin's exec: its own process group
        open(os.environ["FAKE_CHILD"], "w").write(str(child.pid))
        time.sleep(60)
    print("最终回答")
    """
)


@pytest.fixture()
def fake(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    devin_db(home)
    (tmp_path / "proj").mkdir()
    exe = tmp_path / "devin"
    exe.write_text(FAKE.format(py=sys.executable))
    exe.chmod(0o755)
    monkeypatch.setenv("FAKE_ARGS", str(tmp_path / "args.json"))
    monkeypatch.setenv("FAKE_CHILD", str(tmp_path / "child.pid"))
    return exe, tmp_path / "proj", tmp_path


def run_wrapper(exe, proj, *args, timeout=20):
    p = subprocess.run([sys.executable, str(WRAPPER), str(exe), *args], cwd=proj, capture_output=True, text=True, timeout=timeout)
    return p, [json.loads(line) for line in p.stdout.splitlines() if line.strip()]


def test_wrapper_finds_the_new_session_by_directory_and_reports_the_answer(fake):
    exe, proj, tmp = fake
    p, evs = run_wrapper(exe, proj, "-p", *YES, "--", "hi")
    assert p.returncode == 0
    assert [e["type"] for e in evs] == ["init", "session", "text", "turn_end"]
    assert evs[0]["mode"] == "dangerous" and evs[1]["id"] == "fresh-otter" and evs[2]["text"] == "最终回答" and evs[3]["code"] == 0
    assert json.loads((tmp / "args.json").read_text()) == ["-p", *YES, "--", "hi"]  # devin got exactly what it was given


def test_wrapper_knows_a_resumed_session_at_once_and_ignores_other_directories(fake):
    exe, proj, tmp = fake
    con = sqlite3.connect(Path(os.environ["HOME"]) / ".local/share/devin/cli/sessions.db")
    con.execute("insert into sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, hidden) values ('other-session', '/somewhere/else', 'windsurf', 'm', 'bypass', ?, ?, 0)", (int(time.time()), int(time.time())))
    con.commit()
    p, evs = run_wrapper(exe, proj, "-p", *YES, "-r", "kept-session", "--", "hi")
    assert [e["type"] for e in evs][:2] == ["init", "session"] and evs[1]["id"] == "kept-session"


def test_wrapper_passes_a_failure_on_with_the_stderr_tail(fake, monkeypatch):
    exe, proj, tmp = fake
    monkeypatch.setenv("FAKE_MODE", "fail")
    p, evs = run_wrapper(exe, proj, "-p", *YES, "--model", "x", "--", "hi")
    end = evs[-1]
    assert end["type"] == "turn_end" and end["code"] == 1 and "Unknown model" in end["stderr"]
    assert not any(e["type"] == "text" for e in evs)


def test_stopping_the_wrapper_stops_devin_and_the_processes_it_left_in_their_own_groups(fake, monkeypatch):
    exe, proj, tmp = fake
    monkeypatch.setenv("FAKE_MODE", "hang")
    p = subprocess.Popen([sys.executable, str(WRAPPER), str(exe), "-p", *YES, "--", "hi"], cwd=proj, stdout=subprocess.PIPE, text=True, start_new_session=True)
    for _ in range(100):
        if (tmp / "child.pid").exists() and (tmp / "child.pid").read_text():
            break
        time.sleep(0.1)
    child = int((tmp / "child.pid").read_text())
    time.sleep(1.0)  # the wrapper notices the process while the turn runs
    os.kill(child, 0)  # alive
    t = time.time()
    os.killpg(p.pid, signal.SIGTERM)
    p.wait(timeout=10)
    assert time.time() - t < 8
    for _ in range(50):
        try:
            os.kill(child, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        os.kill(child, signal.SIGKILL)
        pytest.fail("devin's exec child was left running")
    assert any(json.loads(line).get("type") == "interrupted" for line in p.stdout.read().splitlines() if line.strip())


# ——— finding a session an interactive run created ———
def test_new_since_claims_the_newest_unclaimed_session_of_the_directory(tmp_path):
    home = tmp_path
    DevinSession(home, "old-one", CWD, T0).save()
    DevinSession(home, "mine-1", CWD, T0 + 60_000).save()
    DevinSession(home, "elsewhere", "/other", T0 + 70_000).save()
    a = DevinAdapter()
    assert a.new_since(CWD, T0 / 1000 + 30, set(), home) == "mine-1"
    assert a.new_since(CWD, T0 / 1000 + 30, {"mine-1"}, home) is None
    assert a.new_since(CWD, T0 / 1000 + 90, set(), home) is None


# ——— following the database as a live log ———
def test_tail_gives_only_what_the_session_gained_since_the_last_read(tmp_path):
    home = tmp_path
    s = DevinSession(home, "live-1", CWD, T0)
    s.system(0, "sys-1")
    s.user(1, "u-1", "读 README.md")
    s.save()
    a = DevinAdapter()
    tail = a.tail(a.locate("live-1", CWD, home).path)
    first = tail.read()
    assert [r["role"] for r in first] == ["system", "user"]
    assert tail.read() == []  # nothing new
    s.call(3, "a-1", [("c1", "read", {"file_path": f"{CWD}/README.md"})])
    s.result(3.2, "t-1", "c1", "# Demo")
    s.reply(4, "a-2", "这是一个演示项目。")
    s.save()
    got = tail.read()
    assert [r["role"] for r in got] == ["assistant", "tool", "assistant"]
    st = State(root=CWD)
    turns = [t for r in first + got for t in a.project(r, st)[1]]
    assert [t["turn"] for t in turns] == ["start", "end"]
    assert tail.read() == []


# ——— the dispatch footer in the CLI's own record of the user message ———
def test_the_dispatch_footer_in_the_users_message_names_the_dispatch(tmp_path):
    rid = "1a336359-d48b-40b1-a325-f90d3d569272"
    body = "读 README.md，回答项目讲什么。"
    footer = f"\n\n[[agora]] dispatch={rid} · 用 agora reply 交回 · agora-req-{rid}"
    s = DevinSession(tmp_path, "worker-1", CWD, T0)
    s.user(0, "u-1", body + footer)
    s.save()
    a = DevinAdapter()
    recs = a.read_records(a.locate("worker-1", CWD, tmp_path).path)
    items, _ = a.project(recs[0], State(root=CWD))
    assert items[0]["kind"] == "user" and items[0].get("dispatch") == rid


# ——— dispatch to it ———
def test_a_dispatch_can_name_devin_as_its_target():
    from native_protocol import NativeSession  # the contract's adapter kind
    from server.canvas import dispatch

    assert dispatch.ADAPTER["devin"] == "devin" and dispatch.PERMISSION["devin"]["mode"] == "headless"
    assert "devin" in NativeSession.model_fields["adapter"].annotation.__args__


# ——— a stopped turn: Devin's log just stops after a tool call (spike §1), the host closes it ———
async def test_a_stopped_turn_is_closed_by_the_host_because_the_log_never_ends_it(tmp_path, monkeypatch):
    import asyncio

    from server.canvas.project import ProjectStore
    from server.canvas.sessions import AgentHub

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    root = tmp_path / "proj"
    store = ProjectStore(root)
    store.init()
    store.append_session("s-1", [{"t": "session", "session": {"id": "s-1", "canvasId": "c1", "createdAt": 1, "turnIds": []}}], base=None)
    store.bind("s-1", agent="devin", model="swe-2-medium", native_id="stopped-one", started=True)
    s = DevinSession(home, "stopped-one", str(root), T0)
    s.user(0, "u-1", "在 shell 里运行 sleep 41")
    s.call(2, "a-1", [("c1", "exec", {"command": "sleep 41", "workdir": str(root)})])
    s.save()  # ← nothing after the call: no result, no end
    gate = asyncio.Event()

    class Hangs:
        async def run(self, req):
            yield {"t": "start", "at": 0}
            await gate.wait()

    hub = AgentHub(store, backend_factory=lambda kind: Hangs())
    seen: list[dict] = []
    hub.listeners.append(seen.append)
    lv = hub._get("s-1")
    hub._follow("s-1", lv)
    assert lv.state.busy and lv.state.pending == {"c1"}  # what the log alone says: still working
    hub.close_stopped_turn("s-1", lv)
    assert not lv.state.busy and not lv.state.pending
    call = lv.items["c1"]
    assert call["tool"]["isError"] is True and call["endAt"] and "停止" in call["tool"]["output"]
    notes = [i for i in lv.items.values() if i.get("kind") == "notice"]
    assert notes and notes[-1]["tone"] == "interrupted" and "停止" in notes[-1]["text"]
    assert any(e.get("t") == "transcript" and any(i.get("id") == "c1" for i in e["items"]) for e in seen)
    hub._follow("s-1", lv)  # reading the log again does not bring the turn back
    assert not lv.state.busy
