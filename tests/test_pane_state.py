"""What a CLI in a terminal pane tells Agora about itself (server/canvas/pane_state.py, bin/agora-state):
the script a CLI's hook runs, and how each CLI is started so that its own hooks run it."""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from server.canvas import agents, pane_state

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "bin" / "agora-state"


class Sink:
    """A tiny server that keeps the POSTs it gets."""

    def __init__(self) -> None:
        self.got: list[tuple[str, dict]] = []
        got = self.got

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                got.append((self.path, json.loads(self.rfile.read(n) or b"{}")))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *a):
                pass

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.srv.shutdown()
        self.srv.server_close()


@pytest.fixture
def sink():
    s = Sink()
    yield s
    s.close()


def run_hook(state: str, stdin: str = "{}", *, url: str | None, session: str | None = "s-1", event: str | None = None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("AGORA_")}
    if url:
        env["AGORA_URL"] = url
    if session:
        env["AGORA_SESSION"] = session
    return subprocess.run([str(SCRIPT), state, *([event] if event else [])], input=stdin, env=env, capture_output=True, text=True, timeout=15)


# ——— the script ———
def test_the_script_tells_the_server_which_state_which_session(sink):
    r = run_hook("idle", url=sink.url)
    assert (r.returncode, r.stdout, r.stderr) == (0, "", "")
    assert sink.got == [("/api/agent/sessions/s-1/cli-state", {"state": "idle"})]


def test_a_sub_agent_does_not_speak_for_the_session(sink):
    # Claude Code names the sub-agent in the hook's JSON: its tool calls are not the session's turn
    r = run_hook("running", '{"hook_event_name":"PreToolUse","agent_id":"a-77","session_id":"x"}', url=sink.url)
    assert r.returncode == 0 and sink.got == []
    run_hook("running", '{"hook_event_name":"UserPromptSubmit","agent_id":null}', url=sink.url)
    assert [b["state"] for _, b in sink.got] == ["running"]


@pytest.mark.parametrize("url,session", [(None, "s-1"), ("http://127.0.0.1:1", None)])
def test_without_a_session_or_a_server_it_does_nothing_and_says_nothing(url, session):
    t = time.monotonic()
    r = run_hook("idle", url=url, session=session)
    assert (r.returncode, r.stdout, r.stderr) == (0, "", "")
    assert time.monotonic() - t < 5  # a CLI waits for its hook: never for long


def test_a_server_that_is_not_there_never_fails_the_cli():
    r = run_hook("idle", url="http://127.0.0.1:1")
    assert (r.returncode, r.stdout, r.stderr) == (0, "", "")


def test_only_known_states_are_sent(sink):
    run_hook("nonsense", url=sink.url)
    assert sink.got == []


# ——— how each CLI is started ———
def hook_commands(settings: dict) -> dict[str, str]:
    return {ev: groups[0]["hooks"][0]["command"] for ev, groups in settings["hooks"].items()}


def test_claude_gets_its_hooks_inline_and_only_when_asked():
    plain = agents.interactive_argv("claude", "u-1", "sonnet", "", new=False)
    assert "--settings" not in plain
    hooked = agents.interactive_argv("claude", "u-1", "sonnet", "", new=False, hooks=True)
    i = hooked.index("--settings")
    assert hooked[:i] + hooked[i + 2:] == plain  # only the settings pair is added
    settings = json.loads(hooked[hooked.index("--settings") + 1])
    cmds = hook_commands(settings)
    assert {ev: c.rsplit(" ", 1)[1] for ev, c in cmds.items()} == {
        "SessionStart": "idle", "UserPromptSubmit": "running", "PermissionRequest": "waiting", "Stop": "idle", "SessionEnd": "exited",
    }
    assert all(str(SCRIPT) in c for c in cmds.values())


def test_codex_gets_its_hooks_as_config_overrides_before_the_subcommand():
    plain = agents.interactive_argv("codex", "t-9", "", "")
    assert plain == ["codex", "resume", "t-9"]
    hooked = agents.interactive_argv("codex", "t-9", "", "", hooks=True)
    assert hooked[0] == "codex" and hooked[-2:] == ["resume", "t-9"]
    joined = " ".join(hooked)
    for ev in ("SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"):
        assert f"hooks.{ev}=" in joined
    assert str(SCRIPT) in joined


def test_pi_gets_an_extension_that_reports_its_lifecycle():
    hooked = agents.interactive_argv("pi", "u-2", "", "", hooks=True)
    path = Path(hooked[hooked.index("-e") + 1])
    src = path.read_text()
    assert path.is_absolute() and path.exists()
    for needle in ("session_start", "agent_start", "agent_settled", "session_shutdown", "/cli-state"):
        assert needle in src


def test_a_cli_without_a_way_to_report_is_started_as_before():
    for kind in ("grok", "cursor", "devin"):
        assert agents.interactive_argv(kind, "x-1", "", "", hooks=True) == agents.interactive_argv(kind, "x-1", "", "")
        assert not pane_state.reports(kind)
    assert all(pane_state.reports(k) for k in ("claude", "codex", "pi"))


# ——— what delivery makes of it ———
def test_delivery_waits_for_idle_and_silence_is_not_ready():
    from server.canvas.sessions import SIGNAL_WAIT_S, cli_hold

    assert cli_hold("idle", 0, 1e9) is None
    for state in ("running", "waiting", "exited"):
        assert cli_hold(state, 0, 1e9, force=True)  # a CLI in a dialog or busy is not about who holds the input
    assert "等 CLI 就绪" in cli_hold(None, 100, 100 + SIGNAL_WAIT_S - 1)
    late = cli_hold(None, 100, 100 + SIGNAL_WAIT_S)
    assert late and "确认" in late  # it tells the person what is probably going on
    assert cli_hold(None, 100, 100 + SIGNAL_WAIT_S, force=True) is None


# Screens of Codex 0.159.3 as captured from a pane: the menus it opens with (nothing may be pasted into them) and the input box.
CODEX_TRUST_MENU = """  Folder access
  /Users/me/proj
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Quit
  enter continue · esc quit"""
CODEX_HOOKS_MENU = """  Hooks need review
  4 hooks are new or changed.
› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)
  enter confirm · esc skip"""
CODEX_INPUT_BOX = """  >_ OpenAI Codex (v0.159.3)
     /Users/me/proj
› Ask Codex to do anything
  GPT-6.1-Sol default · /Users/me/proj
  ? for shortcuts"""


def test_codex_is_up_when_its_screen_shows_the_input_box_and_not_in_a_menu():
    ready = pane_state.SCREEN_READY["codex"]
    assert ready(CODEX_INPUT_BOX)
    assert not ready(CODEX_TRUST_MENU) and not ready(CODEX_HOOKS_MENU) and not ready("")


# The start screens of the CLIs that cannot be told to report (captured from the real ones, started the way Agora starts them).
GROK_INPUT_BOX = """ /p/t/proj
               │  Grok Build  1.0.44
               │  Resume session                         ctrl+r
 ╭──────────────────────────────────────────────╮
 │ ❯                                            │
 ╰──────────────────────── Grok 4.7 (high) · always-approve ─╯"""
CURSOR_INPUT_BOX = """  Cursor Agent
  v2026.09.28-64d2043
  → Plan, search, build anything
  Auto                                      Run Everything
  /private/tmp/proj · main"""
DEVIN_INPUT_BOX = """⠀⠛⠿⠟⠻⣶⣾⣶⡄  Devin CLI
Pro · 100% remaining
──────────────────────── (bypass permissions on) ─
❭ Ask Devin to build features, fix bugs, or work on your code
──────────────────────────────────────────────────
SWE-2 Max"""


@pytest.mark.parametrize("kind, box", [("grok", GROK_INPUT_BOX), ("cursor", CURSOR_INPUT_BOX), ("devin", DEVIN_INPUT_BOX)])
def test_a_cli_that_cannot_report_is_up_when_its_screen_shows_its_input_box(kind, box):
    ready = pane_state.SCREEN_READY[kind]
    assert ready(box)
    assert not ready("") and not ready("Loading…") and not ready(CODEX_TRUST_MENU)


def test_every_cli_either_reports_or_has_a_screen_that_says_it_is_up():
    from server.canvas import agents

    assert all(pane_state.reports(k) or k in pane_state.SCREEN_READY for k in agents.NAMES)
