"""A native session log (Claude / Pi / Codex JSONL) as one transcript shape, followed live.

The CLI's own log is the conversation's source of truth: whatever was said in a headless
turn Agora ran, or typed into the terminal after "在终端打开", lands there. ``project``
maps one log record to transcript upserts plus turn-state changes; ``Tail`` reads a log
incrementally (partial last lines are kept for the next read).

Transcript item (upserted by ``id``)::

    user       {id, kind, text, at, source: "agora" | "terminal"}
    assistant  {id, kind, text, at, msg?}
    tool       {id, kind, at, endAt?, msg?,
                tool: {name, input (one line), args (full input), output?, isError?,
                       files?: [{path, op: "edit" | "write" | "add" | "delete"}]}}
    usage      {id, kind, at, usage: {model, inputTokens, outputTokens, cacheReadTokens,
                                      cacheWriteTokens, costUsd}}   one model request
    context    {id, kind, at, model?, effort?}                     model / effort in effect
    end        {id, kind, at, turn, durationMs?, error?}            the agent finished a turn

``msg`` groups an assistant message's text and tool calls (one model request = one step in
the trajectory). ``files`` are the files a tool call writes, relative to the project root
when inside it (``State.root``) — they drive the progress pointer (web/docs/progress-pointer.md).
Only what the log records is reported: no usage, duration or effort is made up.

Turn state: ``{"turn": "start"}`` when a user prompt is taken, ``{"turn": "end", "text", "error"?}``
when the agent has finished answering it (no pending tool calls).
"""

from __future__ import annotations

from typing import Any

from server.canvas import adapters
from server.canvas.adapters import claude as _claude
from server.canvas.adapters import codex as _codex
from server.canvas.adapters import pi as _pi

# Moved to server/canvas/adapters/ (common.py and one module per CLI); re-exported here.
from server.canvas.adapters.common import (  # noqa: F401
    MARKER,
    MAX_FULL,
    MAX_TEXT,
    MAX_TOOL,
    PASTE_TAG,
    Out,
    State,
    Tail,
    _clip,
    _end,
    _full,
    _ms,
    _start,
    _summary,
    _usage,
    end_item,
    rel_path,
    split_agora,
    user_item,
)

# ——— files a tool call writes (the progress pointer's input) ———
# Claude Code: Edit / MultiEdit / Write / NotebookEdit (``file_path`` / ``notebook_path``);
# Pi: edit / write (``path``); Codex: FileChange items (``changes`` keyed by path).
CLAUDE_WRITES = _claude.WRITES
PI_WRITES = _pi.WRITES
CODEX_CHANGE = _codex.CHANGE
claude_files = _claude.files
pi_files = _pi.files
codex_files = _codex.files
codex_diff = _codex.diff

project_claude = _claude.project
project_pi = _pi.project
project_codex = _codex.project

PROJECT = {"claude": project_claude, "pi": project_pi, "codex": project_codex}


def project(kind: str, rec: dict[str, Any], st: State) -> Out:
    """One log record of a ``kind`` CLI → (item upserts, turn changes): its adapter's ``Projector``."""
    return adapters.need(kind).project(rec, st)
