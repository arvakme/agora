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
MAX_TOOL = 1500  # the one-line input summary
MAX_FULL = 256_000  # tool args / output kept in full (the page gets a preview, full on demand)


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


def _full(v: Any) -> str:
    """A tool input or output as text, as complete as MAX_FULL allows."""
    if isinstance(v, str):
        return _clip(v, MAX_FULL)
    try:
        return _clip(json.dumps(v, ensure_ascii=False, indent=2), MAX_FULL)
    except (TypeError, ValueError):
        return _clip(str(v), MAX_FULL)


# ——— files a tool call writes (the progress pointer's input) ———
# Claude Code: Edit / MultiEdit / Write / NotebookEdit (``file_path`` / ``notebook_path``);
# Pi: edit / write (``path``); Codex: FileChange items (``changes`` keyed by path).
CLAUDE_WRITES = {"Edit": "edit", "MultiEdit": "edit", "Write": "write", "NotebookEdit": "edit"}
PI_WRITES = {"edit": "edit", "write": "write", "multi_edit": "edit", "multiedit": "edit"}
CODEX_CHANGE = {"update": "edit", "add": "add", "delete": "delete"}


def rel_path(path: str, root: str | None) -> str:
    """``path`` relative to the project root (posix) when it is inside it; otherwise as given."""
    if not path:
        return path
    p = path.replace("\\", "/")
    if not root:
        return p
    if not os.path.isabs(p):
        return os.path.normpath(p).replace(os.sep, "/").removeprefix("./")
    for r in {root, os.path.realpath(root)}:
        for q in (p, os.path.realpath(p)):
            try:
                rel = os.path.relpath(q, r)
            except ValueError:
                continue
            if not rel.startswith(".."):
                return rel.replace(os.sep, "/")
    return p


def claude_files(name: str, inp: Any, root: str | None) -> list[dict[str, str]]:
    op = CLAUDE_WRITES.get(name)
    if not op or not isinstance(inp, dict):
        return []
    path = inp.get("file_path") or inp.get("notebook_path")
    return [{"path": rel_path(str(path), root), "op": op}] if isinstance(path, str) and path else []


def pi_files(name: str, args: Any, root: str | None) -> list[dict[str, str]]:
    op = PI_WRITES.get(name.lower())
    if not op or not isinstance(args, dict):
        return []
    path = args.get("path") or args.get("file_path")
    return [{"path": rel_path(str(path), root), "op": op}] if isinstance(path, str) and path else []


def codex_files(changes: Any, root: str | None) -> list[dict[str, str]]:
    if not isinstance(changes, dict):
        return []
    return [{"path": rel_path(str(p), root), "op": CODEX_CHANGE.get(str((c or {}).get("type")), "edit")} for p, c in changes.items()]


def codex_diff(changes: Any) -> str:
    if not isinstance(changes, dict):
        return _full(changes)
    parts = []
    for p, c in changes.items():
        c = c or {}
        parts.append(f"*** {c.get('type', 'update')} {p}\n{c.get('unified_diff') or c.get('content') or ''}".rstrip())
    return _clip("\n\n".join(parts), MAX_FULL)


def _usage(model: Any, inp: Any, out: Any, cache_read: Any = None, cache_write: Any = None, cost: Any = None) -> dict[str, Any]:
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None  # noqa: E731
    return {
        "model": str(model) if model else None,
        "inputTokens": num(inp),
        "outputTokens": num(out),
        "cacheReadTokens": num(cache_read),
        "cacheWriteTokens": num(cache_write),
        "costUsd": num(cost),
    }


@dataclass
class State:
    """Per-log parse state: pending tool calls in the current turn, whether a turn is open."""

    busy: bool = False
    pending: set[str] = field(default_factory=set)
    last_text: str = ""
    root: str | None = None  # project root: file paths are reported relative to it
    turn: str = ""  # id of the user message that opened the current (or last) turn
    turn_at: int = 0
    codex_usage_records: bool = False


Out = tuple[list[dict[str, Any]], list[dict[str, Any]]]  # (item upserts, turn changes)


def _start(st: State, turns: list[dict[str, Any]], turn_id: str = "", at: int = 0) -> None:
    st.busy = True
    st.pending.clear()
    st.last_text = ""
    st.turn = turn_id or st.turn
    st.turn_at = at
    turns.append({"turn": "start"})


def end_item(st: State, at: int, error: str | None = None, duration_ms: Any = None) -> dict[str, Any]:
    it: dict[str, Any] = {"id": f"end-{st.turn}", "kind": "end", "at": at, "turn": st.turn}
    if error:
        it["error"] = error
    if isinstance(duration_ms, (int, float)) and not isinstance(duration_ms, bool):
        it["durationMs"] = int(duration_ms)
    return it


def _end(st: State, turns: list[dict[str, Any]], error: str | None = None, items: list[dict[str, Any]] | None = None, at: int | None = None) -> None:
    if not st.busy:
        return
    st.busy = False
    st.pending.clear()
    turns.append({"turn": "end", "text": st.last_text, **({"error": error} if error else {})})
    if items is not None and st.turn:
        items.append(end_item(st, at or int(time.time() * 1000), error))


def project_claude(rec: dict[str, Any], st: State) -> Out:
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    if rec.get("isSidechain"):
        return items, turns
    t = rec.get("type")
    at = _ms(rec.get("timestamp"))
    if t == "system" and rec.get("subtype") == "turn_duration":
        # Interactive Claude Code writes the wall time of the turn it just finished.
        if st.turn:
            items.append(end_item(st, at, duration_ms=rec.get("durationMs")))
            items[-1]["at"] = at
        return items, turns
    if rec.get("isMeta"):
        return items, turns
    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
    if t == "user":
        content = msg.get("content")
        blocks = content if isinstance(content, list) else []
        results = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"]
        if results and len(results) == len(blocks):
            for b in results:
                tid = str(b.get("tool_use_id"))
                st.pending.discard(tid)
                out = text_of(b.get("content")) or (b.get("content") if isinstance(b.get("content"), str) else "")
                items.append({"id": tid, "kind": "tool", "at": at, "endAt": at, "tool": {"output": _full(str(out)), "isError": bool(b.get("is_error"))}})
            return items, turns
        text = text_of(content)
        if not text.strip() or text.lstrip().startswith(("<command-", "<local-command", "<system-reminder>", "<bash-")):
            return items, turns
        if text.startswith("[Request interrupted"):
            _end(st, turns, "interrupted", items, at)
            return items, turns
        uid = str(rec.get("uuid"))
        items.append(user_item(uid, text, at))
        _start(st, turns, uid, at)
    elif t == "assistant":
        blocks = msg.get("content") if isinstance(msg.get("content"), list) else []
        mid = str(msg.get("id") or rec.get("uuid"))
        text = "".join(str(b.get("text", "")) for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        if text.strip():
            st.last_text = text
            items.append({"id": str(rec.get("uuid")), "kind": "assistant", "text": _clip(text, MAX_TEXT), "at": at, "msg": mid})
        for b in blocks:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                tid = str(b.get("id"))
                name = str(b.get("name"))
                st.pending.add(tid)
                tool: dict[str, Any] = {"name": name, "input": _summary(b.get("input")), "args": _full(b.get("input"))}
                files = claude_files(name, b.get("input"), st.root)
                if files:
                    tool["files"] = files
                items.append({"id": tid, "kind": "tool", "at": at, "msg": mid, "tool": tool})
        u = msg.get("usage")
        model = msg.get("model")
        # Claude Code writes one record per content block, all carrying the same message usage:
        # keyed by the message id, the repeats collapse into one request.
        if isinstance(u, dict) and model and model != "<synthetic>":
            items.append({"id": f"u-{mid}", "kind": "usage", "at": at, "msg": mid, "usage": _usage(model, u.get("input_tokens"), u.get("output_tokens"), u.get("cache_read_input_tokens"), u.get("cache_creation_input_tokens"))})
        if rec.get("isApiErrorMessage") or (isinstance(rec.get("error"), str) and rec.get("error")):
            _end(st, turns, str(rec.get("error") or "api_error"), items, at)
        elif msg.get("stop_reason") == "end_turn" and not st.pending and text.strip():
            _end(st, turns, None, items, at)
    return items, turns


def project_pi(rec: dict[str, Any], st: State) -> Out:
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    at = _ms(rec.get("timestamp"))
    if rec.get("type") == "model_change" and rec.get("modelId"):
        model = f"{rec['provider']}/{rec['modelId']}" if rec.get("provider") else rec["modelId"]
        items.append({"id": f"ctx-{rec.get('id')}", "kind": "context", "at": at, "model": str(model)})
        return items, turns
    if rec.get("type") == "thinking_level_change" and rec.get("thinkingLevel"):
        items.append({"id": f"ctx-{rec.get('id')}", "kind": "context", "at": at, "effort": str(rec["thinkingLevel"])})
        return items, turns
    if rec.get("type") != "message" or not isinstance(rec.get("message"), dict):
        return items, turns
    m = rec["message"]
    start = _ms(m.get("timestamp") or rec.get("timestamp"))
    role = m.get("role")
    rid = str(rec.get("id"))
    if role == "user":
        text = text_of(m.get("content"))
        if text.strip():
            items.append(user_item(rid, text, start))
            _start(st, turns, rid, start)
    elif role == "assistant":
        blocks = m.get("content") if isinstance(m.get("content"), list) else []
        text = "".join(str(b.get("text", "")) for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        if text.strip():
            st.last_text = text
            items.append({"id": rid, "kind": "assistant", "text": _clip(text, MAX_TEXT), "at": start, "msg": rid})
        calls = [b for b in blocks if isinstance(b, dict) and b.get("type") == "toolCall"]
        for b in calls:
            tid = str(b.get("id"))
            name = str(b.get("name"))
            st.pending.add(tid)
            tool: dict[str, Any] = {"name": name, "input": _summary(b.get("arguments")), "args": _full(b.get("arguments"))}
            files = pi_files(name, b.get("arguments"), st.root)
            if files:
                tool["files"] = files
            items.append({"id": tid, "kind": "tool", "at": at, "msg": rid, "tool": tool})
        u = m.get("usage")
        if isinstance(u, dict) and (u.get("input") or u.get("output") or u.get("cacheRead")):
            model = f"{m['provider']}/{m['model']}" if m.get("provider") and m.get("model") else m.get("model")
            cost = u.get("cost").get("total") if isinstance(u.get("cost"), dict) else None
            items.append({"id": f"u-{rid}", "kind": "usage", "at": at, "startAt": start, "msg": rid, "usage": _usage(model, u.get("input"), u.get("output"), u.get("cacheRead"), u.get("cacheWrite"), cost)})
        reason = m.get("stopReason")
        if reason in ("error", "aborted"):
            _end(st, turns, str(m.get("errorMessage") or reason), items, at)
        elif reason == "stop" and not calls and not st.pending:
            _end(st, turns, None, items, at)
    elif role == "toolResult":
        tid = str(m.get("toolCallId"))
        st.pending.discard(tid)
        items.append({"id": tid, "kind": "tool", "at": at, "endAt": at, "tool": {"name": str(m.get("toolName") or ""), "output": _full(text_of(m.get("content"))), "isError": bool(m.get("isError"))}})
    return items, turns


def project_codex(rec: dict[str, Any], st: State) -> Out:
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    rtype = rec.get("type")
    p = rec.get("payload") if isinstance(rec.get("payload"), dict) else None
    if p is None:
        return items, turns
    if rtype == "turn_context":
        effort = p.get("effort") or ((p.get("collaboration_mode") or {}).get("settings") or {}).get("reasoning_effort")
        items.append({"id": f"ctx-{p.get('turn_id') or rec.get('timestamp')}", "kind": "context", "at": _ms(rec.get("timestamp")), **({"model": str(p["model"])} if p.get("model") else {}), **({"effort": str(effort)} if effort else {})})
        return items, turns
    if rtype == "token_usage_record" and isinstance(p.get("usage"), dict):
        st.codex_usage_records = True
        u = p["usage"]
        cached, inp = u.get("cached_input_tokens"), u.get("input_tokens")
        uncached = inp - cached if isinstance(inp, int) and isinstance(cached, int) else inp
        items.append({"id": f"u-{p.get('response_id') or rec.get('timestamp')}", "kind": "usage", "at": _ms(rec.get("timestamp")), "usage": _usage(None, uncached, u.get("output_tokens"), cached, u.get("cache_write_input_tokens"))})
        return items, turns
    if rtype != "event_msg":
        return items, turns
    kind = p.get("type")
    at = _ms(p.get("completed_at_ms") or rec.get("timestamp"))
    if kind == "token_count" and not st.codex_usage_records and isinstance(p.get("info"), dict) and isinstance(p["info"].get("last_token_usage"), dict):
        # Older Codex versions: no per-response record, only the running token counter.
        u = p["info"]["last_token_usage"]
        cached, inp = u.get("cached_input_tokens"), u.get("input_tokens")
        uncached = inp - cached if isinstance(inp, int) and isinstance(cached, int) else inp
        items.append({"id": f"u-tc-{rec.get('timestamp')}", "kind": "usage", "at": at, "usage": _usage(None, uncached, u.get("output_tokens"), cached, u.get("cache_write_input_tokens"))})
    elif kind == "task_started":
        _start(st, turns, str(p.get("turn_id") or ""), at)
    elif kind == "task_complete":
        if isinstance(p.get("last_agent_message"), str):
            st.last_text = p["last_agent_message"]
        was = st.busy
        _end(st, turns)
        if was or st.turn:
            items.append(end_item(st, at, duration_ms=p.get("duration_ms")))
    elif kind == "turn_aborted":
        _end(st, turns, str(p.get("reason") or "aborted"), items, at)
    elif kind == "item_completed" and isinstance(p.get("item"), dict):
        it = p["item"]
        itype = it.get("type")
        iid = str(it.get("id"))
        started = _ms(p.get("started_at_ms")) if p.get("started_at_ms") else at
        if itype == "UserMessage":
            text = text_of(it.get("content"))
            if text.strip():
                items.append(user_item(iid, text, at))
                if not st.busy:
                    _start(st, turns, str(p.get("turn_id") or iid), at)
                elif not st.turn:
                    st.turn = str(p.get("turn_id") or iid)
        elif itype == "AgentMessage":
            text = text_of(it.get("content"))
            if text.strip():
                st.last_text = text
                items.append({"id": iid, "kind": "assistant", "text": _clip(text, MAX_TEXT), "at": at})
        elif itype == "CommandExecution":
            cmd = it.get("command")
            shown = cmd[-1] if isinstance(cmd, list) and cmd else cmd
            code = it.get("exit_code")
            out = it.get("formatted_output") or it.get("aggregated_output") or "\n".join(str(x) for x in (it.get("stdout"), it.get("stderr")) if x)
            items.append({
                "id": iid,
                "kind": "tool",
                "at": started,
                "endAt": at,
                "tool": {"name": "shell", "input": _summary(shown), "args": _full(shown), "output": _full(str(out or "")), "isError": code not in (0, None) or it.get("status") == "failed"},
            })
        elif itype == "FileChange":
            files = codex_files(it.get("changes"), st.root)
            tool: dict[str, Any] = {"name": "apply_patch", "input": ", ".join(f["path"] for f in files) or "patch", "args": codex_diff(it.get("changes")), "output": str(it.get("status") or ""), "isError": it.get("status") == "failed"}
            if files and it.get("status") != "failed":
                tool["files"] = files
            items.append({"id": iid, "kind": "tool", "at": started, "endAt": at, "tool": tool})
        elif itype in ("McpToolCall", "WebSearch"):
            arg = it.get("arguments") or it.get("query") or ""
            items.append({"id": iid, "kind": "tool", "at": started, "endAt": at, "tool": {"name": str(it.get("tool") or itype), "input": _summary(arg), "args": _full(arg), "output": _full(it.get("result") or it.get("status") or ""), "isError": it.get("status") == "failed"}})
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
