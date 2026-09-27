"""A native session log (Claude / Pi / Codex JSONL) as one transcript shape, followed live.

The CLI's own log is the conversation's source of truth: whatever was said in a headless
turn Agora ran, or typed into the terminal after "在终端打开", lands there. ``project``
maps one log record to transcript upserts plus turn-state changes; ``Tail`` reads a log
incrementally (partial last lines are kept for the next read).

Transcript item (upserted by ``id``)::

    {id, kind: "user" | "assistant" | "tool", text, at, source?: "agora" | "terminal",
     tool?: {name, input, output?, isError?}}

Turn state: ``{"turn": "start"}`` when a user prompt is taken, ``{"turn": "end", "text", "error"?}``
when the agent has finished answering it (no pending tool calls).
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from server.canvas.agents import text_of

# Prompts Agora sends end with a context footer starting with this marker; it tells the
# transcript which user messages came from Agora and is hidden when displayed.
MARKER = "[[agora]]"
MAX_TEXT = 4000
MAX_TOOL = 1500


def split_agora(text: str) -> tuple[str, bool]:
    """(what the person wrote, whether Agora sent it)."""
    i = text.find(MARKER)
    if i < 0:
        return text, False
    return text[:i].rstrip(), True


def _ms(ts: Any) -> int:
    if isinstance(ts, (int, float)):
        return int(ts if ts > 1e11 else ts * 1000)
    if isinstance(ts, str):
        try:
            return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            pass
    return int(time.time() * 1000)


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _summary(inp: Any) -> str:
    """A tool input as one readable line (commands as-is, objects as compact JSON)."""
    if isinstance(inp, dict):
        for k in ("command", "cmd", "file_path", "path", "pattern", "query", "url"):
            v = inp.get(k)
            if isinstance(v, str) and v:
                return _clip(v, MAX_TOOL)
            if isinstance(v, list) and v:
                return _clip(" ".join(map(str, v)), MAX_TOOL)
        return _clip(json.dumps(inp, ensure_ascii=False), MAX_TOOL)
    if isinstance(inp, list):
        return _clip(" ".join(map(str, inp)), MAX_TOOL)
    return _clip(str(inp or ""), MAX_TOOL)


# Claude Code records a long terminal paste wrapped in <pasted_content id="…"> tags.
PASTE_TAG = re.compile(r"</?pasted_content[^>]*>")


def user_item(id: str, text: str, at: int) -> dict[str, Any]:
    body, from_agora = split_agora(PASTE_TAG.sub("", text).strip())
    return {"id": id, "kind": "user", "text": _clip(body, MAX_TEXT), "at": at, "source": "agora" if from_agora else "terminal"}


@dataclass
class State:
    """Per-log parse state: pending tool calls in the current turn, whether a turn is open."""

    busy: bool = False
    pending: set[str] = field(default_factory=set)
    last_text: str = ""


Out = tuple[list[dict[str, Any]], list[dict[str, Any]]]  # (item upserts, turn changes)


def _start(st: State, turns: list[dict[str, Any]]) -> None:
    st.busy = True
    st.pending.clear()
    st.last_text = ""
    turns.append({"turn": "start"})


def _end(st: State, turns: list[dict[str, Any]], error: str | None = None) -> None:
    if not st.busy:
        return
    st.busy = False
    st.pending.clear()
    turns.append({"turn": "end", "text": st.last_text, **({"error": error} if error else {})})


def project_claude(rec: dict[str, Any], st: State) -> Out:
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    if rec.get("isSidechain") or rec.get("isMeta"):
        return items, turns
    t = rec.get("type")
    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
    at = _ms(rec.get("timestamp"))
    if t == "user":
        content = msg.get("content")
        blocks = content if isinstance(content, list) else []
        results = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"]
        if results and len(results) == len(blocks):
            for b in results:
                tid = str(b.get("tool_use_id"))
                st.pending.discard(tid)
                out = text_of(b.get("content")) or (b.get("content") if isinstance(b.get("content"), str) else "")
                items.append({"id": tid, "kind": "tool", "at": at, "tool": {"output": _clip(str(out), MAX_TOOL), "isError": bool(b.get("is_error"))}})
            return items, turns
        text = text_of(content)
        if not text.strip() or text.lstrip().startswith(("<command-", "<local-command", "<system-reminder>", "<bash-")):
            return items, turns
        if text.startswith("[Request interrupted"):
            _end(st, turns, "interrupted")
            return items, turns
        items.append(user_item(str(rec.get("uuid")), text, at))
        _start(st, turns)
    elif t == "assistant":
        blocks = msg.get("content") if isinstance(msg.get("content"), list) else []
        text = "".join(str(b.get("text", "")) for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        if text.strip():
            st.last_text = text
            items.append({"id": str(rec.get("uuid")), "kind": "assistant", "text": _clip(text, MAX_TEXT), "at": at})
        for b in blocks:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                tid = str(b.get("id"))
                st.pending.add(tid)
                items.append({"id": tid, "kind": "tool", "at": at, "tool": {"name": str(b.get("name")), "input": _summary(b.get("input"))}})
        if rec.get("isApiErrorMessage") or (isinstance(rec.get("error"), str) and rec.get("error")):
            _end(st, turns, str(rec.get("error") or "api_error"))
        elif msg.get("stop_reason") == "end_turn" and not st.pending and text.strip():
            _end(st, turns)
    return items, turns


def project_pi(rec: dict[str, Any], st: State) -> Out:
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    if rec.get("type") != "message" or not isinstance(rec.get("message"), dict):
        return items, turns
    m = rec["message"]
    at = _ms(m.get("timestamp") or rec.get("timestamp"))
    role = m.get("role")
    if role == "user":
        text = text_of(m.get("content"))
        if text.strip():
            items.append(user_item(str(rec.get("id")), text, at))
            _start(st, turns)
    elif role == "assistant":
        blocks = m.get("content") if isinstance(m.get("content"), list) else []
        text = "".join(str(b.get("text", "")) for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        if text.strip():
            st.last_text = text
            items.append({"id": str(rec.get("id")), "kind": "assistant", "text": _clip(text, MAX_TEXT), "at": at})
        calls = [b for b in blocks if isinstance(b, dict) and b.get("type") == "toolCall"]
        for b in calls:
            tid = str(b.get("id"))
            st.pending.add(tid)
            items.append({"id": tid, "kind": "tool", "at": at, "tool": {"name": str(b.get("name")), "input": _summary(b.get("arguments"))}})
        reason = m.get("stopReason")
        if reason in ("error", "aborted"):
            _end(st, turns, str(m.get("errorMessage") or reason))
        elif reason == "stop" and not calls and not st.pending:
            _end(st, turns)
    elif role == "toolResult":
        tid = str(m.get("toolCallId"))
        st.pending.discard(tid)
        items.append({"id": tid, "kind": "tool", "at": at, "tool": {"name": str(m.get("toolName") or ""), "output": _clip(text_of(m.get("content")), MAX_TOOL), "isError": bool(m.get("isError"))}})
    return items, turns


def project_codex(rec: dict[str, Any], st: State) -> Out:
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    if rec.get("type") != "event_msg" or not isinstance(rec.get("payload"), dict):
        return items, turns
    p = rec["payload"]
    kind = p.get("type")
    at = _ms(p.get("completed_at_ms") or rec.get("timestamp"))
    if kind == "task_started":
        _start(st, turns)
    elif kind == "task_complete":
        if isinstance(p.get("last_agent_message"), str):
            st.last_text = p["last_agent_message"]
        _end(st, turns)
    elif kind == "turn_aborted":
        _end(st, turns, str(p.get("reason") or "aborted"))
    elif kind == "item_completed" and isinstance(p.get("item"), dict):
        it = p["item"]
        itype = it.get("type")
        iid = str(it.get("id"))
        if itype == "UserMessage":
            text = text_of(it.get("content"))
            if text.strip():
                items.append(user_item(iid, text, at))
                if not st.busy:
                    _start(st, turns)
        elif itype == "AgentMessage":
            text = text_of(it.get("content"))
            if text.strip():
                st.last_text = text
                items.append({"id": iid, "kind": "assistant", "text": _clip(text, MAX_TEXT), "at": at})
        elif itype == "CommandExecution":
            cmd = it.get("command")
            shown = cmd[-1] if isinstance(cmd, list) and cmd else cmd
            code = it.get("exit_code")
            items.append({
                "id": iid,
                "kind": "tool",
                "at": at,
                "tool": {"name": "shell", "input": _summary(shown), "output": _clip(str(it.get("formatted_output") or it.get("aggregated_output") or ""), MAX_TOOL), "isError": code not in (0, None)},
            })
        elif itype in ("FileChange", "McpToolCall", "WebSearch"):
            items.append({"id": iid, "kind": "tool", "at": at, "tool": {"name": str(it.get("tool") or itype), "input": _summary(it.get("arguments") or it.get("changes") or it.get("query") or ""), "output": str(it.get("status") or "")}})
    return items, turns


PROJECT = {"claude": project_claude, "pi": project_pi, "codex": project_codex}


def project(kind: str, rec: dict[str, Any], st: State) -> Out:
    return PROJECT[kind](rec, st)


class Tail:
    """Follow one JSONL file from its start; ``read()`` returns records appended since last time."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.offset = 0
        self._partial = b""
        self._ino: int | None = None

    def read(self, limit: int = 32 * 1024 * 1024) -> list[dict[str, Any]]:
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            return []
        if self._ino is not None and (st.st_ino != self._ino or st.st_size < self.offset):
            self.offset, self._partial = 0, b""  # replaced or truncated: start over
        self._ino = st.st_ino
        if st.st_size <= self.offset:
            return []
        with open(self.path, "rb") as fh:
            fh.seek(self.offset)
            chunk = fh.read(min(limit, st.st_size - self.offset))
        self.offset += len(chunk)
        data = self._partial + chunk
        lines = data.split(b"\n")
        self._partial = lines.pop()  # "" when the chunk ended on a newline
        out = []
        for line in lines:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                out.append(rec)
        return out
