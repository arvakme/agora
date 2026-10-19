"""What a CLI in a terminal pane tells Agora about itself.

Pasting into a pane only works when the CLI is up and waiting at its prompt: pasted into a loading CLI, a
permission dialog or a "trust this folder" menu the text is lost. A guessed boot time cannot know that, so a CLI
that can say it does: its own hooks (Pi: an extension) report ``idle`` / ``running`` / ``waiting`` (for the person)
/ ``exited`` to the server (``bin/agora-state``, ``pane_state_pi.ts``), and delivery waits for ``idle``.

Only CLIs listed in ``ARGS`` report (Codex only from its first turn on). The others are delivered to once ``SCREEN_READY``
sees their input box at the moment a message is to go in; whether a turn is over is the log's to say. A CLI with neither is delivered to on the boot timer
(``sessions.PANE_BOOT_S``).
"""

from __future__ import annotations

import json
import shlex
from collections.abc import Callable
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "bin" / "agora-state"
PI_EXTENSION = Path(__file__).with_name("pane_state_pi.ts")

STATES = ("idle", "running", "waiting", "exited")
HOOK_TIMEOUT_S = 10

# Hook event → the state it reports. Tool-call events are left out on purpose: they would add a process per tool
# call, and delivery only needs to know when the CLI is idle (``Stop`` and ``SessionStart``).
EVENTS = {
    "SessionStart": "idle",
    "UserPromptSubmit": "running",
    "PermissionRequest": "waiting",
    "Stop": "idle",
    "SessionEnd": "exited",
}
CODEX_EVENTS = {k: v for k, v in EVENTS.items() if k != "SessionEnd"}  # Codex has no such event


def command(state: str) -> str:
    return f"{shlex.quote(str(SCRIPT))} {state}"


def _claude() -> list[str]:
    hooks = {ev: [{"hooks": [{"type": "command", "command": command(state), "timeout": HOOK_TIMEOUT_S}]}] for ev, state in EVENTS.items()}
    return ["--settings", json.dumps({"hooks": hooks}, separators=(",", ":"))]


def _codex() -> list[str]:
    args = ["--enable", "hooks"]
    for ev, state in CODEX_EVENTS.items():
        # TOML string: the command has no quote or backslash that needs escaping beyond what json.dumps does
        args += ["-c", f"hooks.{ev}=[{{hooks=[{{type=\"command\",command={json.dumps(command(state))},timeout={HOOK_TIMEOUT_S}}}]}}]"]
    return args


def _pi() -> list[str]:
    return ["-e", str(PI_EXTENSION)]


ARGS: dict[str, Callable[[], list[str]]] = {"claude": _claude, "codex": _codex, "pi": _pi}


# A CLI that says nothing until its first turn (Codex runs ``SessionStart`` with the first prompt) or cannot be told to
# report at all (Grok, Cursor, Devin: no flag injects a hook, and writing the person's own config is not ours to do) is
# up when its screen shows the input box: not a menu (trust this folder, review hooks), which has none. The Grok, Cursor
# and Devin markers are text those CLIs print around the box because of the flags Agora starts them with
# (``agents.interactive_argv``); Cursor's changes once a turn has run, so it has two. The screen is looked at again for
# every message, and only its bottom lines, from the screen as it is now (not the scrollback). A screen that does not match is never "ready" (the message waits and the person is told), so a changed
# screen costs a wait, not a lost message.
def _shows(*markers: str) -> Callable[[str], bool]:
    return lambda screen: any(m in screen for m in markers)


SCREEN_READY: dict[str, Callable[[str], bool]] = {
    "codex": _shows("? for shortcuts"),
    "grok": _shows("always-approve"),
    "cursor": _shows("Run Everything", "Add a follow-up"),
    "devin": _shows("bypass permissions on"),
}


SCREEN_TAIL_LINES = 10  # the input box and its footer are at the bottom: what is printed above is not the box


def bottom(screen: str) -> str:
    """The last non-blank lines of a screen: where an input box is, if there is one."""
    return "\n".join([line for line in screen.splitlines() if line.strip()][-SCREEN_TAIL_LINES:])


def reports(kind: str) -> bool:
    return kind in ARGS


def with_hooks(kind: str, argv: list[str]) -> list[str]:
    """``argv`` (a CLI's interactive command) with the flags that make that CLI report its state."""
    return [argv[0], *ARGS[kind](), *argv[1:]] if reports(kind) else argv
