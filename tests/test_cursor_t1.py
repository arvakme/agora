"""Cursor (``cursor-agent``) as a session agent (T1): the headless command and its stream, the interactive command,
the model list, and how a running pane is matched to its chat. The streams in tests/fixtures/cursor-headless/ are
real ``cursor-agent -p --output-format stream-json`` runs (2026-09-29, sanitized); tests/fixtures/agents/cursor/
2026.9.26/stream.jsonl is the shared contract fixture."""

import asyncio
import json
import os
import sys
import textwrap
from pathlib import Path

import pytest

from server.canvas import adapters, agents
from server.canvas.adapters.common import State
from server.canvas.adapters.cursor import CursorStream, cursor_catalog, list_models, slug
from server.canvas.agents import CursorBackend
from server.canvas.runner import ExecOptions, RunRequest
from server.canvas.sessions import agora_prompt
from server.canvas.transcript import project

FIX = Path(__file__).parent / "fixtures" / "cursor-headless"
CONTRACT = Path(__file__).parent / "fixtures" / "agents" / "cursor" / "2026.9.26" / "stream.jsonl"
CHAT = "4bb59945-a775-4619-b355-03d373e7d35c"


def cursor():
    return adapters.need("cursor")


def lines(path: Path) -> list[dict]:
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]


def feed(path: Path, model=None, session=None):
    m = CursorStream(model, session)
    evs = []
    for i, rec in enumerate(lines(path)):
        evs += m.feed(rec, 1000 + i)
    return m, evs


def req(prompt="hi", **o):
    return RunRequest(schema=None, system=None, prompt=prompt, options=ExecOptions(backend="cursor", **o), cwd="/work/p")


# ——— tier and registry ———
def test_cursor_is_a_session_agent():
    a = cursor()
    assert adapters.implemented_tier(a) == "T1" and a.max_tier == "T1" and "cursor" in adapters.session_kinds()
    assert a.assigns_id == "cli" and a.can_fork_headless is False and a.survives_move is False
    assert a.asked_mode == "run-everything" and a.project_skill_dir == ".cursor/skills"
    assert agents.SKILL_DIRS["cursor"] == ".cursor/skills" and "cursor" in agents.BACKEND_CLASSES
    info = adapters.registry.info(a, installed=True)
    assert info["tier"] == "T1" and info["caps"]["headless"] and info["caps"]["terminal"] and info["caps"]["catalog"]


# ——— headless ———
def test_headless_command_line():
    a = cursor()
    base = ["cursor-agent", "-p", "--output-format", "stream-json", "--force", "--trust"]  # --force: 「默认不加边界」
    assert a.headless_args(["cursor-agent"], req(model="")) == base
    assert a.headless_args(["cursor-agent"], req(session=CHAT, model="composer-2.5")) == [*base, "--resume", CHAT, "--model", "composer-2.5"]
    assert a.headless_args(["cursor-agent"], req(model="", effort="high")) == base  # the effort is part of the model id: nothing to pass
    with pytest.raises(ValueError):
        a.headless_args(["cursor-agent"], req(fork_from="x"))


def test_the_prompt_goes_on_stdin_not_in_the_argv():
    b = CursorBackend()
    assert b.stdin(req("-rf 这不是选项")) == "-rf 这不是选项".encode()
    assert "-rf 这不是选项" not in b.args(req("-rf 这不是选项"))


def test_stream_read_a_file():
    m, evs = feed(FIX / "read-readme.jsonl", "auto")
    kinds = [e["t"] for e in evs]
    assert kinds == ["session", "mode", "text", "tool_use", "tool_result", "text", "usage"]
    assert evs[0]["session"] == "cc11cc11-0000-4000-8000-000000000001" and m.session == evs[0]["session"]  # the chat id comes from init
    assert evs[1]["mode"] == "run-everything"  # init itself says "default": Agora reports what it asked for
    assert evs[3]["name"] == "Read" and evs[3]["input"]["path"].endswith("README.md")
    assert evs[4]["id"] == evs[3]["id"] and "tiny demo" in evs[4]["text"] and evs[4]["isError"] is False
    assert m.done and m.error is None and m.text.strip()
    u = m.final_usage(5)
    assert u["inputTokens"] and u["outputTokens"] and u["cacheReadTokens"] is not None


def test_a_rejected_shell_call_is_an_error_result():
    """Without --force a shell call comes back ``rejected`` (print mode cannot ask): it must not read as success."""
    _, evs = feed(FIX / "rejected-shell.jsonl")
    results = [e for e in evs if e["t"] == "tool_result"]
    assert results and all(r["isError"] and r["text"].startswith("rejected") for r in results)
    assert {e["name"] for e in evs if e["t"] == "tool_use"} == {"Shell"}


def test_reconnect_notices_are_not_shown_and_the_turn_still_ends():
    m, evs = feed(FIX / "reconnect-through-proxy.jsonl")
    assert m.done and m.error is None
    assert {e["t"] for e in evs} <= {"session", "mode", "text", "tool_use", "tool_result", "usage"}


def test_contract_stream_maps_reads_shell_and_edits():
    m, evs = feed(CONTRACT)
    assert [e["name"] for e in evs if e["t"] == "tool_use"] == ["Read", "Shell", "Edit"]
    assert m.done and m.error is None


def test_a_failed_result_is_the_turns_error():
    m = CursorStream(None, None)
    m.feed({"type": "result", "subtype": "error", "is_error": True, "result": "boom"}, 1)
    assert m.done and m.error == "cursor: boom"


def test_backend_runs_a_turn_through_a_fake_cli(tmp_path):
    fake = tmp_path / "fake-cursor"
    fake.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import sys
        sys.stdin.read()
        sys.stdout.write(open({str(FIX / 'read-readme.jsonl')!r}).read())
        """))
    fake.chmod(0o755)

    async def run():
        r = RunRequest(schema=None, system=None, prompt="读 README.md", options=ExecOptions(backend="cursor", model="auto"), cwd=str(tmp_path))
        return [ev async for ev in CursorBackend(cmd=[str(fake)]).run(r)]

    evs = asyncio.run(run())
    assert [e["t"] for e in evs][:3] == ["start", "spawned", "session"]
    res = evs[-1]
    assert res["t"] == "result" and not res.get("error") and res["session"] == "cc11cc11-0000-4000-8000-000000000001" and res["raw"]
    assert "--force" in evs[1]["argv"] and "--output-format" in evs[1]["argv"]


# ——— interactive ———
def test_interactive_command_line():
    a = cursor()
    assert a.interactive_argv(CHAT, None, None) == ["cursor-agent", "--force", "--trust", "--resume", CHAT]
    assert a.interactive_argv(None, "composer-2.5", "high", new=True) == ["cursor-agent", "--force", "--trust", "--model", "composer-2.5"]
    assert agents.interactive_argv("cursor", CHAT, "auto", None) == ["cursor-agent", "--force", "--trust", "--resume", CHAT, "--model", "auto"]


def test_a_pane_is_matched_to_its_chat_by_the_store_it_holds_open(tmp_path):
    """lsof of a running cursor-agent shows ``~/.cursor/chats/<hash>/<chat id>/store.db(-wal|-shm)``."""
    a = cursor()
    chats = tmp_path / ".cursor" / "chats" / "81620f0ac339be3bd79be634f612fba9" / CHAT
    chats.mkdir(parents=True)
    for n in ("store.db", "store.db-wal", "store.db-shm"):
        (chats / n).write_text("")
    other = tmp_path / "elsewhere" / CHAT
    other.mkdir(parents=True)
    (other / "store.db").write_text("")
    assert a.claims_by_open_file
    assert a.native_from_open_files([str(chats / "store.db-wal"), "/tmp/x.log"], tmp_path) == CHAT
    assert a.native_from_open_files([str(other / "store.db"), "/tmp/x.log"], tmp_path) is None
    assert a.native_from_open_files([], tmp_path) is None


def test_a_chat_started_after_the_pane_opened_is_found(tmp_path):
    a = cursor()
    root = "/work/p"
    for cid in ("aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"):
        d = tmp_path / ".cursor" / "projects" / slug(root) / "agent-transcripts" / cid
        d.mkdir(parents=True)
        (d / f"{cid}.jsonl").write_text('{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n')
    now = os.stat(tmp_path / ".cursor").st_mtime
    taken = {"aaaaaaaa-0000-4000-8000-000000000001"}
    assert a.new_since(root, now - 60, taken, tmp_path) == "bbbbbbbb-0000-4000-8000-000000000002"
    assert a.new_since(root, now + 3600, set(), tmp_path) is None


# ——— catalog ———
LIST_MODELS = """Available models

auto - Auto (current, default)
gpt-5.3-codex-low - Codex 5.3 Low
gpt-5.3-codex - Codex 5.3 (current)
grok-4.7-low-fast - Grok 4.7  Low Fast​​
claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking

Tip: use --model <id> to switch
"""


def test_the_model_list_is_read_from_the_clis_own_output():
    ids, names, default = list_models(LIST_MODELS)
    assert ids == ["auto", "gpt-5.3-codex-low", "gpt-5.3-codex", "grok-4.7-low-fast", "claude-sonnet-5-thinking-high"]
    assert default == "auto" and names["auto"] == "Auto" and names["gpt-5.3-codex"] == "Codex 5.3" and names["grok-4.7-low-fast"] == "Grok 4.7  Low Fast"
    cat = cursor_catalog(ids, names, default, "cursor-agent --list-models")
    assert cat["default"] == "auto" and cat["allowed"] == ids and cat["efforts"] == [] and cat["modelEfforts"]["auto"] == []
    assert cursor_catalog([], {}, "", "none")["allowed"] is None  # no list (not logged in / offline): nothing is refused


def test_catalog_asks_the_cli(monkeypatch, tmp_path):
    import subprocess

    fake = tmp_path / "cursor-agent"
    fake.write_text(f"#!/bin/sh\ncat <<'EOF'\n{LIST_MODELS}EOF\n")
    fake.chmod(0o755)
    monkeypatch.setattr(type(cursor()), "installed", lambda self: str(fake))
    cat = cursor().catalog({"PATH": os.environ["PATH"]}, None)
    assert cat["models"][0] == "auto" and cat["scope"]["source"] == "cursor-agent --list-models"
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("gone")))
    assert cursor().catalog({}, None)["models"] == []


# ——— the dispatch marker in a Cursor transcript ———
def test_a_dispatch_footer_is_recognised_in_the_native_log():
    """Real transcript record (headless run, 2026-09-29): the footer survives inside <user_query>."""
    did = "11111111-2222-3333-4444-555555555555"
    body = agora_prompt("只回复一个字：好", canvas_id="c1", canvas_name="总图", extra=f"dispatch={did} from=s-x agora-req-{did}", session_id="s-1")
    rec = {"role": "user", "message": {"content": [{"type": "text", "text": f"<timestamp>Tuesday, Sep 29, 2026, 5:20 PM (UTC+8)</timestamp>\n<user_query>\n{body}\n</user_query>"}]}}
    items, turns = project("cursor", rec, State(root="/work/p"))
    assert items[0]["kind"] == "user" and items[0]["dispatch"] == did and "只回复一个字" in items[0]["text"]


def test_a_new_prompt_ends_the_turn_whose_end_record_the_cli_dropped():
    """Resumed in its terminal, cursor-agent rewrites the transcript without the ``turn_ended`` of earlier turns
    (measured 2026-09-29): the second prompt must not be folded into the first turn."""
    def user(t):
        return {"role": "user", "message": {"content": [{"type": "text", "text": f"<timestamp>Tuesday, Sep 29, 2026, 5:3{t} PM (UTC+8)</timestamp>\n<user_query>\nq{t}\n</user_query>"}]}}

    def says(t):
        return {"role": "assistant", "message": {"content": [{"type": "text", "text": f"a{t}"}]}}

    st = State(root="/work/p")
    marks = []
    for rec in (user(1), says(1), user(6), says(6), {"type": "turn_ended", "status": "success"}):
        _, turns = project("cursor", rec, st)
        marks += [t["turn"] for t in turns]
    assert marks == ["start", "end", "start", "end"] and not st.busy


def test_tool_items_say_their_length_is_a_guess():
    """The transcript has no times, so ``endAt`` is spread over the turn: the page must not read a 1 s guess as a short read."""
    rec = {"role": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"path": "/work/p/server/app.py"}}]}, "_at": 1000, "_end": 2100}
    items, _ = project("cursor", rec, State(root="/work/p"))
    assert items[0]["kind"] == "tool" and items[0]["durationInferred"] is True and items[0]["endAt"] > items[0]["at"]
