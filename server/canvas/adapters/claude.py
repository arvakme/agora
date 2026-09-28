"""Claude Code (T1). Moved from agents.py / transcript.py without behaviour change.

- Headless: ``claude -p --output-format stream-json --verbose (--session-id|--resume) <uuid>``.
- Log: ``~/.claude/projects/<cwd, every non-alphanumeric → "-">/<id>.jsonl``; ``--resume <id>``
  finds the id in any project directory but prefers the current directory's copy.
- Native sub-agents: ``<parent log dir>/<parent id>/subagents/agent-<aid>.jsonl`` plus
  ``agent-<aid>.meta.json`` (``toolUseId`` = the parent's ``Agent`` tool call).
"""

from __future__ import annotations

import glob
import json
import os
import re
from pathlib import Path
from typing import Any, Callable

from server.canvas import agent_models
from server.canvas.adapters.base import Adapter, tool_facts, NativeRef, ParentLink, VersionRange
from server.canvas.adapters.common import (
    MAX_TEXT,
    LogLookup,
    Out,
    State,
    StreamMapper,
    _clip,
    _end,
    _full,
    _ms,
    _start,
    _summary,
    _usage,
    end_item,
    read_jsonl,
    rel_path,
    text_of,
    user_item,
)
from server.canvas.runner import claude_message_usage, claude_result_usage


class ClaudeStream(StreamMapper):
    """``claude -p --output-format stream-json --verbose``."""

    def __init__(self, model: str | None, session: str | None) -> None:
        super().__init__(model, session)
        self.result: dict[str, Any] | None = None

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        t = d.get("type")
        if t == "system" and d.get("subtype") == "init":
            self.model = str(d.get("model") or self.model or "") or None
            self.session = str(d.get("session_id") or self.session or "") or None
        elif t == "assistant":
            msg = d.get("message") or {}
            texts = []
            for c in msg.get("content") or []:
                if c.get("type") == "text" and str(c.get("text", "")).strip():
                    texts.append(str(c["text"]))
                    out.append({"t": "text", "at": at, "text": str(c["text"])})
                elif c.get("type") == "tool_use":
                    out.append({"t": "tool_use", "at": at, "id": str(c.get("id")), "name": str(c.get("name")), "input": c.get("input")})
            if texts:
                self.text = "".join(texts)
            if isinstance(msg.get("usage"), dict):
                out.append({"t": "usage", "at": at, "usage": claude_message_usage(msg["usage"], str(msg.get("model") or self.model))})
        elif t == "user":
            for c in (d.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    out.append({"t": "tool_result", "at": at, "id": str(c.get("tool_use_id")), "text": text_of(c.get("content")) or str(c.get("content") or ""), "isError": bool(c.get("is_error"))})
        elif t == "result":
            self.result = d
            self.done = True
            self.session = str(d.get("session_id") or self.session or "") or None
            if d.get("is_error"):
                self.error = f"claude: {d.get('subtype', 'error')} {str(d.get('result') or '')[:300]}".strip()
            elif isinstance(d.get("result"), str) and d["result"].strip():
                self.text = d["result"]
        return out

    def final_usage(self, duration_ms: int):
        if self.result is None:
            return super().final_usage(duration_ms)
        return claude_result_usage(self.result, self.model, duration_ms)


# ——— files a tool call writes ———
# Edit / MultiEdit / Write / NotebookEdit (``file_path`` / ``notebook_path``).
WRITES = {"Edit": "edit", "MultiEdit": "edit", "Write": "write", "NotebookEdit": "edit"}


def files(name: str, inp: Any, root: str | None) -> list[dict[str, str]]:
    op = WRITES.get(name)
    if not op or not isinstance(inp, dict):
        return []
    path = inp.get("file_path") or inp.get("notebook_path")
    return [{"path": rel_path(str(path), root), "op": op}] if isinstance(path, str) and path else []


def project(rec: dict[str, Any], st: State) -> Out:
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
                fs = files(name, b.get("input"), st.root)
                if fs:
                    tool["files"] = fs
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


def dir_name(root: Path | str) -> str:
    return "".join(c if c.isalnum() and c.isascii() else "-" for c in str(root))


def projects_dir(home: Path) -> Path:
    return home / ".claude" / "projects"


class ClaudeAdapter(Adapter):
    kind = "claude"
    name = "Claude Code"
    binaries = ("claude",)
    tested = VersionRange(">=2.1.268,<2.2")
    max_tier = "T1"
    seedmux_names = ("claude",)
    icon = "claude"
    log_hint = "~/.claude/projects/<目录>/<id>.jsonl"
    delete_hint = "rm ~/.claude/projects/<目录>/<id>.jsonl"
    prunes_logs_after_days = 30

    # Headless
    assigns_id = "agora"
    can_fork_headless = True
    Mapper = ClaudeStream
    # Binding
    survives_move = True

    # ——— Locator ———
    def log_dir_name(self, root: Path | str) -> str:
        return dir_name(root)

    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not native_id:
            return LogLookup("missing")
        home = home or Path.home()
        hits = sorted(Path(p) for p in glob.glob(str(projects_dir(home) / "*" / f"{glob.escape(native_id)}.jsonl")))
        mine = [p for p in hits if root is not None and p.parent.name == dir_name(root)]
        if mine:
            return LogLookup("found", mine[0], tuple(hits))
        if len(hits) == 1:
            return LogLookup("found", hits[0], tuple(hits))
        return LogLookup("ambiguous" if hits else "missing", None, tuple(hits))

    def new_since(self, root: Path | str, since: float, taken: set[str], home: Path | None = None) -> str | None:
        home = home or Path.home()
        found = []
        for p in glob.glob(str(projects_dir(home) / dir_name(root) / "*.jsonl")):
            try:
                if os.path.getctime(p) < since - 2:
                    continue
            except OSError:
                continue
            nid = Path(p).stem
            if nid not in taken:
                found.append((os.path.getctime(p), nid))
        return sorted(found)[0][1] if found else None

    def sessions_for(self, roots: list[str], home: Path | None = None) -> list[dict[str, Any]]:
        home = home or Path.home()
        out = []
        for root in roots:
            for p in glob.glob(str(projects_dir(home) / dir_name(root) / "*.jsonl")):
                out.append({"agent": "claude", "nativeId": Path(p).stem, "path": Path(p), "cwd": root})
        return out

    # ——— Projector ———
    known_types = frozenset()  # filled in by the drift step

    def project(self, rec: dict[str, Any], st: State) -> Out:
        return project(rec, st)

    def record_type(self, rec: dict[str, Any]) -> str | None:
        t = rec.get("type")
        return f"{t}/{rec['subtype']}" if t == "system" and rec.get("subtype") else (str(t) if t else None)

    def files(self, name: str, inp: Any, root: str | None) -> list[dict[str, str]]:
        return files(name, inp, root)

    # ——— ToolVocab ———
    def classify(self, name: str, args: Any, root: str | None = None) -> dict[str, Any]:
        """Tool facts for one call (the write files; activities come with the page's vocabulary)."""
        return tool_facts("tools", files=files(name, args, root))

    # ——— Headless ———
    def headless_args(self, cmd: list[str], req: Any, *, log_exists: Callable[[str], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        o = req.options
        args = [*cmd, "-p", "--output-format", "stream-json", "--verbose"]
        if o.fork_from:
            args += ["--resume", o.fork_from, "--fork-session"]
        elif o.session:
            # Only a session that never ran is created with --session-id; any other is resumed,
            # and a missing log then fails loudly in the CLI ("No conversation found") instead of
            # starting a new, empty conversation under the same id.
            exists = log_exists(o.session) if callable(log_exists) else log_exists
            args += ["--session-id", o.session] if o.new_session and not exists else ["--resume", o.session]
        if o.model:
            args += ["--model", o.model]
        if o.effort:
            args += ["--effort", o.effort]
        # The canvas skill runs `agora canvas …` through Bash; allow exactly that.
        args += ["--allowedTools", "Bash(agora canvas *)", "Bash(agora canvas:*)"]
        return args

    # ——— Interactive ———
    def fork_argv(self, fork: dict[str, Any]) -> list[str]:
        return ["claude", "--resume", fork["from"], "--fork-session"]

    def interactive_argv(self, native_id: str | None, model: str | None, effort: str | None, *, new: bool = False, has_log: Callable[[], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        args = ["claude"]
        if native_id:
            args += ["--session-id", native_id] if new and not (has_log() if callable(has_log) else has_log) else ["--resume", native_id]
        if model:
            args += ["--model", model]
        if effort:
            args += ["--effort", effort]
        return args

    project_skill_dir = ".claude/skills"  # where it looks for project skills

    # ——— Catalog ———
    def catalog(self, env: dict[str, str], root: Path | None) -> dict[str, Any]:
        return agent_models.SOURCES["claude"](env, root)
