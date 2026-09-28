"""Codex (T1). Moved from agents.py / transcript.py without behaviour change.

- Headless: ``codex exec --json -`` (new) / ``codex exec resume <id> --json -``; no headless fork.
- Log: ``~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl``, independent of the cwd;
  index ``~/.codex/state_5.sqlite`` (``threads``, ``thread_spawn_edges``), opened read-only.
- Codex assigns its own id on the first run.
- Native sub-agents: ``spawn_agent`` → a child thread with its own rollout whose
  ``session_meta.payload.source.subagent.thread_spawn.parent_thread_id`` is the parent; the
  index's ``thread_spawn_edges`` says the same. ``source.subagent.other == "guardian"`` are
  approval-guardian threads, not workers (hidden).
"""

from __future__ import annotations

import glob
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Callable

from server.canvas import agent_models
from server.canvas.adapters.base import first_cwd, valid_id, Adapter, NativeRef, ParentLink, VersionRange, tool_facts
from server.canvas.adapters.tools import activity_of, shell_reads, spawn_in_output
from server.canvas.adapters.common import (
    MAX_FULL,
    MAX_TEXT,
    LogLookup,
    Out,
    State,
    StreamMapper,
    _clip,
    _end,
    _full,
    _hinted,
    _ms,
    _start,
    _summary,
    _usage,
    add_usage,
    end_item,
    read_jsonl,
    rel_path,
    text_of,
    user_item,
)
from server.canvas.runner import Usage, _int, empty_usage


def codex_usage(u: dict[str, Any] | None, model: str | None) -> Usage:
    out = empty_usage(model)
    if isinstance(u, dict):
        cached = _int(u.get("cached_input_tokens"))
        inp = _int(u.get("input_tokens"))
        # Codex counts cached tokens inside input_tokens; report the uncached part like the others.
        out["inputTokens"] = inp - cached if inp is not None and cached is not None else inp
        out["outputTokens"] = _int(u.get("output_tokens"))
        out["cacheReadTokens"] = cached
        out["cacheWriteTokens"] = _int(u.get("cache_write_input_tokens"))
    return out


class CodexStream(StreamMapper):
    """``codex exec --json``: thread.started / item.* / turn.completed."""

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        t = d.get("type")
        if t == "thread.started":
            self.session = str(d.get("thread_id") or self.session or "") or None
        elif t in ("item.started", "item.completed"):
            item = d.get("item") or {}
            kind = item.get("type")
            iid = str(item.get("id"))
            if kind == "agent_message" and t == "item.completed":
                text = str(item.get("text") or "")
                if text.strip():
                    self.text = text
                    out.append({"t": "text", "at": at, "text": text})
            elif kind == "command_execution":
                if t == "item.started":
                    out.append({"t": "tool_use", "at": at, "id": iid, "name": "shell", "input": {"command": item.get("command")}})
                else:
                    code = item.get("exit_code")
                    out.append({"t": "tool_result", "at": at, "id": iid, "text": str(item.get("aggregated_output") or ""), "isError": code not in (0, None)})
            elif kind in ("mcp_tool_call", "file_change", "web_search") and t == "item.completed":
                name = str(item.get("tool") or kind)
                out.append({"t": "tool_use", "at": at, "id": iid, "name": name, "input": item.get("arguments") or item.get("changes") or item.get("query")})
                out.append({"t": "tool_result", "at": at, "id": iid, "text": str(item.get("status") or ""), "isError": item.get("status") == "failed"})
        elif t == "turn.completed":
            u = codex_usage(d.get("usage"), self.model)
            self.usage = add_usage(self.usage, u)
            out.append({"t": "usage", "at": at, "usage": u})
            self.done = True
        elif t == "turn.failed":
            self.error = f"codex: {((d.get('error') or {}).get('message') or 'turn failed')[:300]}"
            self.done = True
        elif t == "error":
            self.error = f"codex: {str(d.get('message') or 'error')[:300]}"
        return out


# ——— files a tool call writes: FileChange items (``changes`` keyed by path) ———
CHANGE = {"update": "edit", "add": "add", "delete": "delete"}


def files(changes: Any, root: str | None) -> list[dict[str, str]]:
    if not isinstance(changes, dict):
        return []
    return [{"path": rel_path(str(p), root), "op": CHANGE.get(str((c or {}).get("type")), "edit")} for p, c in changes.items()]


def diff(changes: Any) -> str:
    if not isinstance(changes, dict):
        return _full(changes)
    parts = []
    for p, c in changes.items():
        c = c or {}
        parts.append(f"*** {c.get('type', 'update')} {p}\n{c.get('unified_diff') or c.get('content') or ''}".rstrip())
    return _clip("\n\n".join(parts), MAX_FULL)


def _cwd(v: Any) -> str | None:
    if not isinstance(v, str) or not v:
        return None
    return v[len("file://"):] if v.startswith("file://") else v


def shell_facts(item: dict[str, Any], root: str | None) -> dict[str, Any]:
    """A CommandExecution → tool facts. Codex parses the command itself (``parsed_cmd``: read /
    search / list_files / unknown); what it leaves ``unknown`` goes through the shared shell parser
    (``rtk read …``, pipelines)."""
    cwd = _cwd(item.get("cwd")) or root
    parsed = item.get("parsed_cmd") if isinstance(item.get("parsed_cmd"), list) else []
    kinds: list[str] = []
    reads: list[str] = []

    def add(p: str) -> None:
        q = rel_path(os.path.normpath(os.path.join(cwd, p)) if cwd and not os.path.isabs(p) else p, root)
        if q not in reads:
            reads.append(q)

    for pc in parsed:
        if not isinstance(pc, dict):
            continue
        t = pc.get("type")
        if t == "read" and isinstance(pc.get("path"), str):
            kinds.append("read")
            add(pc["path"])
        elif t in ("search", "list_files"):
            kinds.append("search")
        else:
            got, ps = shell_reads(pc.get("cmd"), root, cwd)
            kinds.append(got or "commands")
            for p in ps:
                if p not in reads:
                    reads.append(p)
    if not parsed:
        cmd = item.get("command")
        got, reads = shell_reads(cmd[-1] if isinstance(cmd, list) and cmd else cmd, root, cwd)
        kinds = [got or "commands"]
    act = "read" if kinds and all(k == "read" for k in kinds) else "search" if kinds and all(k in ("read", "search") for k in kinds) else "commands"
    out = str(item.get("formatted_output") or item.get("aggregated_output") or "")
    return tool_facts(act, reads=reads, spawn=spawn_in_output(out, item.get("command")))


def project(rec: dict[str, Any], st: State) -> Out:
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
                "tool": {"name": "shell", "input": _summary(shown), "args": _full(shown), "output": _full(str(out or "")), "isError": code not in (0, None) or it.get("status") == "failed", **shell_facts(it, st.root)},
            })
        elif itype == "FileChange":
            fs = files(it.get("changes"), st.root)
            tool: dict[str, Any] = {"name": "apply_patch", "input": ", ".join(f["path"] for f in fs) or "patch", "args": diff(it.get("changes")), "output": str(it.get("status") or ""), "isError": it.get("status") == "failed"}
            if fs and it.get("status") != "failed":
                tool["files"] = fs
            tool["activity"] = "edit"
            items.append({"id": iid, "kind": "tool", "at": started, "endAt": at, "tool": tool})
        elif itype == "SubAgentActivity" and it.get("kind") == "started" and it.get("agent_thread_id"):
            # ``spawn_agent``: the child is its own thread (runs API: /api/agent/runs).
            items.append({"id": iid, "kind": "tool", "at": started, "endAt": at, "tool": {"name": "spawn_agent", "input": str(it.get("agent_path") or it["agent_thread_id"]), "args": _full(it), "output": "", "isError": False, "activity": "subagents", "spawn": {"childKind": "codex", "childId": str(it["agent_thread_id"]), "via": "native"}}})
        elif itype == "CollabAgentToolCall":
            # 0.157: spawn_agent / wait / send_input / close_agent as one item (receiver threads, their states).
            kids = [str(x) for x in (it.get("receiver_thread_ids") or []) if x]
            tool = str(it.get("tool") or "collab")
            states = it.get("agents_states") if isinstance(it.get("agents_states"), dict) else {}
            out = "\n".join(f"{k}: {v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)}" for k, v in states.items())
            t: dict[str, Any] = {"name": tool, "input": _summary(it.get("prompt") or ", ".join(kids)), "args": _full({k: v for k, v in it.items() if k in ("tool", "prompt", "receiver_thread_ids", "model", "reasoning_effort")}), "output": _full(out), "isError": it.get("status") == "failed", "activity": "subagents"}
            if tool == "spawn_agent" and kids:
                t["spawn"] = {"childKind": "codex", "childId": kids[0], "via": "native"}
            items.append({"id": iid, "kind": "tool", "at": started, "endAt": at, "tool": t})
        elif itype in ("McpToolCall", "WebSearch"):
            arg = it.get("arguments") or it.get("query") or ""
            items.append({"id": iid, "kind": "tool", "at": started, "endAt": at, "tool": {"name": str(it.get("tool") or itype), "input": _summary(arg), "args": _full(arg), "output": _full(it.get("result") or it.get("status") or ""), "isError": it.get("status") == "failed", "activity": "webSearch" if itype == "WebSearch" else "tools"}})
    return items, turns


def codex_home(home: Path) -> Path:
    return Path(os.environ.get("CODEX_HOME") or home / ".codex")


def state_rollout(native_id: str, home: Path | None = None) -> Path | None:
    """Codex's own index (``state_5.sqlite``, ``threads.rollout_path``), opened read-only: it still
    knows a rollout that moved out of the dated ``sessions/`` folders (archive, storage migration)."""
    db = codex_home(home or Path.home()) / "state_5.sqlite"
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
        try:
            row = con.execute("select rollout_path from threads where id = ?", (native_id,)).fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        return None
    p = Path(row[0]) if row and row[0] else None
    return p if p is not None and p.exists() else None


def rollouts_since(cwd: Path, since: float, home: Path | None = None) -> list[tuple[str, Path]]:
    """Interactive Codex rollouts for ``cwd`` created at/after ``since`` → [(thread id, path)], oldest first."""
    home = home or Path.home()
    root = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions"
    out = []
    for p in glob.glob(str(root / "*" / "*" / "*" / "rollout-*.jsonl")):
        try:
            if os.path.getmtime(p) < since - 2:
                continue
            with open(p, "rb") as fh:
                meta = json.loads(fh.readline() or b"{}")
        except (OSError, json.JSONDecodeError):
            continue
        pl = meta.get("payload") or {}
        if meta.get("type") != "session_meta" or not pl.get("id"):
            continue
        if Path(str(pl.get("cwd") or "")).resolve() != cwd.resolve():
            continue
        out.append((os.path.getctime(p), str(pl["id"]), Path(p)))
    return [(i, p) for _, i, p in sorted(out)]


def session_meta(path: Path | None) -> dict[str, Any]:
    """The first record's payload (``session_meta``): id, cwd, cli_version, source…"""
    if path is None:
        return {}
    try:
        with open(path, "rb") as fh:
            head = json.loads(fh.readline() or b"{}")
    except (OSError, ValueError):
        return {}
    return head.get("payload") if isinstance(head, dict) and head.get("type") == "session_meta" and isinstance(head.get("payload"), dict) else {}


def spawn_edges(parent_id: str, home: Path) -> dict[str, str]:
    """Codex's index ``thread_spawn_edges``: child thread id → ``open`` / ``closed``, read-only."""
    db = codex_home(home) / "state_5.sqlite"
    if not db.exists():
        return {}
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
        try:
            return {str(c): str(s) for c, s in con.execute("select child_thread_id, status from thread_spawn_edges where parent_thread_id = ?", (parent_id,)).fetchall()}
        finally:
            con.close()
    except sqlite3.Error:
        return {}


# children() per (rollout, its size and mtime, the index's mtime): a large parent rollout is read once
# per change, not on every /api/agent/runs (review P2-6).
_children_cache: dict[tuple, list] = {}


def _children_key(ref: Any, home: Path) -> tuple | None:
    try:
        st = ref.path.stat() if ref.path is not None else None
    except OSError:
        return None
    db = codex_home(home) / "state_5.sqlite"
    try:
        dbm = (db.stat().st_mtime, (db.parent / "state_5.sqlite-wal").stat().st_mtime if (db.parent / "state_5.sqlite-wal").exists() else 0)
    except OSError:
        dbm = (0, 0)
    return (ref.native_id, str(ref.path), st.st_size if st else 0, st.st_mtime if st else 0, dbm, str(home))


CODEX_FALLBACK = 400  # newest rollouts looked at when Codex has no index


def index_rows(roots: list[str], home: Path) -> list[dict[str, Any]]:
    """Codex threads whose cwd is one of ``roots``: its index, else the first line of recent rollouts."""
    db = codex_home(home) / "state_5.sqlite"
    if db.exists():
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
            con.row_factory = sqlite3.Row
            try:
                q = f"select * from threads where cwd in ({','.join('?' * len(roots))})"
                rows = [dict(r) for r in con.execute(q, roots).fetchall()]
            finally:
                con.close()
            return [{"nativeId": r["id"], "path": Path(r["rollout_path"]), "cwd": r["cwd"]} for r in rows if r.get("rollout_path")]
        except sqlite3.Error:
            pass
    out = []
    fs = sorted(glob.glob(str(codex_home(home) / "sessions" / "*" / "*" / "*" / "rollout-*.jsonl")))[-CODEX_FALLBACK:]
    for p in fs:
        try:
            with open(p, "rb") as fh:
                meta = json.loads(fh.readline() or b"{}")
        except (OSError, ValueError):
            continue
        pl = meta.get("payload") or {}
        if meta.get("type") == "session_meta" and pl.get("id") and str(pl.get("cwd")) in roots:
            out.append({"nativeId": str(pl["id"]), "path": Path(p), "cwd": pl.get("cwd")})
    return out


class CodexAdapter(Adapter):
    kind = "codex"
    name = "Codex"
    binaries = ("codex",)
    tested = VersionRange(">=0.149,<0.158")
    max_tier = "T1"
    seedmux_names = ("codex",)
    icon = "codex"
    log_hint = "~/.codex/sessions/年/月/日/rollout-*-<id>.jsonl"
    log_dir = "~/.codex/sessions/"
    delete_hint = "codex delete {id}"
    waits = "native"

    assigns_id = "cli"
    can_fork_headless = False
    terminal_fork = "codex fork"
    Mapper = CodexStream
    survives_move = True

    # ——— Locator ———
    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not valid_id(native_id):  # also refuses "", None, "/" and ".." (never a path or a glob)
            return LogLookup("missing")
        home = home or Path.home()
        base = codex_home(home) / "sessions"
        hits = sorted(Path(p) for p in glob.glob(str(base / "*" / "*" / "*" / f"rollout-*-{glob.escape(native_id)}.jsonl")))
        if hits:
            return LogLookup("found", hits[-1], tuple(hits))
        known = _hinted(hint, native_id) or state_rollout(native_id, home)
        return LogLookup("found", known, (known,)) if known else LogLookup("missing")

    def new_since(self, root: Path | str, since: float, taken: set[str], home: Path | None = None) -> str | None:
        return next((tid for tid, _ in rollouts_since(Path(root), since, home or Path.home()) if tid not in taken), None)

    def sessions_for(self, roots: list[str], home: Path | None = None) -> list[dict[str, Any]]:
        return [{"agent": "codex", **r} for r in index_rows(roots, home or Path.home())]

    def log_cwd(self, path: Path) -> str | None:
        return first_cwd(path)

    # ——— Projector ———
    # ``record_type``: top-level type, ``event_msg/<type>``, ``response_item/<type>``, or
    # ``item/<ItemType>`` for event_msg/item_completed. Seen locally in 0.125–0.157 (drift.py).
    handled_types = frozenset({
        "session_meta", "turn_context", "token_usage_record", "event_msg/token_count", "event_msg/task_started",
        "event_msg/task_complete", "event_msg/turn_aborted", "item/UserMessage", "item/AgentMessage",
        "item/CommandExecution", "item/FileChange", "item/McpToolCall", "item/WebSearch", "item/SubAgentActivity",
        "item/CollabAgentToolCall",  # 0.157 (first seen recording the 0.157.1 fixture, 2026-09-28)
    })
    # Duplicates of the item_completed records (paginated history, 0.149+) or not shown.
    ignored_types = frozenset({
        "response_item/message", "response_item/reasoning", "response_item/custom_tool_call", "response_item/custom_tool_call_output",
        "response_item/function_call", "response_item/function_call_output", "response_item/agent_message", "response_item/web_search_call",
        "response_item/tool_search_call", "response_item/tool_search_output", "response_item/image_generation_call",
        "item/Reasoning", "item/Extension", "item/ImageView", "item/ContextCompaction", "item/HookPrompt", "compacted",
        "event_msg/thread_settings_applied", "event_msg/thread_name_updated", "event_msg/thread_goal_updated", "event_msg/thread_rolled_back",
        "event_msg/context_compacted", "event_msg/agent_reasoning", "event_msg/error", "event_msg/dynamic_tool_call_request",
        "event_msg/dynamic_tool_call_response", "event_msg/view_image_tool_call", "event_msg/image_generation_end",
        "inter_agent_communication_metadata",
        # 0.144+: a per-turn snapshot of the context (AGENTS.md, environment); turn_context still
        # carries the model and effort the trajectory shows (review P2-4).
        "world_state",
    })
    # Known, not handled: the legacy (pre-0.149) event log keeps messages and tool calls only in these,
    # so older Codex sessions show turns without their messages (reported by `agora doctor --agents`).
    gap_types = frozenset({
        "event_msg/user_message", "event_msg/agent_message", "event_msg/exec_command_end", "event_msg/patch_apply_end",
        "event_msg/mcp_tool_call_end", "event_msg/web_search_end", "event_msg/sub_agent_activity", "event_msg/collab_agent_spawn_end",
        "event_msg/collab_close_end", "event_msg/collab_waiting_end", "event_msg/collab_agent_interaction_end",
    })
    known_types = handled_types | ignored_types

    def project(self, rec: dict[str, Any], st: State) -> Out:
        return project(rec, st)

    def record_type(self, rec: dict[str, Any]) -> str | None:
        t = rec.get("type")
        p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        if t in ("event_msg", "response_item") and p.get("type"):
            sub = p["type"]
            if t == "event_msg" and sub == "item_completed" and isinstance(p.get("item"), dict):
                return f"item/{p['item'].get('type')}"
            return f"{t}/{sub}"
        return str(t) if t else None

    # ——— ToolVocab ———
    def classify(self, name: str, args: Any, root: str | None = None) -> dict[str, Any]:
        """Tool facts for one call: ``shell`` (a CommandExecution item or a command line), ``apply_patch``
        (FileChange ``changes`` are the writes), otherwise by name."""
        if name == "shell":
            return shell_facts(args if isinstance(args, dict) else {"command": args}, root)
        if name == "apply_patch":
            return tool_facts("edit", files=files(args, root))
        act = activity_of(name)
        return tool_facts(act, waits_user=act == "questions")

    # ——— Subagents ———
    def children(self, ref: NativeRef, home: Path | None = None) -> list[NativeRef]:
        """``spawn_agent`` children: the parent rollout's ``SubAgentActivity`` items (started /
        interacted / completed, with the child thread id), Codex's index ``thread_spawn_edges``, and
        each child rollout's ``session_meta.source.subagent.thread_spawn.parent_thread_id``. Guardian
        threads (``source.subagent.other == "guardian"``, approval checks) are not workers: hidden."""
        home = home or Path.home()
        key = _children_key(ref, home)
        hit = _children_cache.get(key) if key else None
        if hit is not None:
            return hit
        out = self._children(ref, home)
        if key:
            if len(_children_cache) > 256:
                _children_cache.clear()
            _children_cache[key] = out
        return out

    def _children(self, ref: NativeRef, home: Path) -> list[NativeRef]:
        acts: dict[str, dict[str, Any]] = {}
        if ref.path is not None:
            for rec in read_jsonl(ref.path):
                p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
                it = p.get("item") if rec.get("type") == "event_msg" and p.get("type") == "item_completed" else None
                if isinstance(it, dict) and it.get("type") == "CollabAgentToolCall":
                    at = _ms(p.get("completed_at_ms") or rec.get("timestamp"))
                    states = it.get("agents_states") if isinstance(it.get("agents_states"), dict) else {}
                    for cid in it.get("receiver_thread_ids") or []:
                        a = acts.setdefault(str(cid), {})
                        nick = next((x.get("agent_nickname") for x in it.get("receiver_agents") or [] if isinstance(x, dict) and x.get("thread_id") == cid), None)
                        if nick:
                            a.setdefault("nickname", nick)
                        if it.get("tool") == "spawn_agent":
                            a.setdefault("at", _ms(p.get("started_at_ms")) if p.get("started_at_ms") else at)
                            a.setdefault("callId", str(it.get("id")))
                        s = states.get(cid)
                        if isinstance(s, dict) and ("completed" in s or "errored" in s or "failed" in s):
                            a.setdefault("doneAt", at)
                            if "completed" not in s:
                                a["failed"] = True
                        elif it.get("tool") == "close_agent":
                            a.setdefault("doneAt", at)
                    continue
                if isinstance(it, dict) and it.get("type") == "SubAgentActivity" and it.get("agent_thread_id"):
                    a = acts.setdefault(str(it["agent_thread_id"]), {"path": it.get("agent_path")})
                    at = _ms(p.get("completed_at_ms") or rec.get("timestamp"))
                    if it.get("kind") == "started":
                        a.setdefault("at", at)
                        a.setdefault("callId", str(it.get("id")))
                    elif it.get("kind") == "completed":
                        a["doneAt"] = at
                    else:
                        a.setdefault("interactions", []).append(at)
        edges = spawn_edges(ref.native_id, home)
        out = []
        for cid in dict.fromkeys([*acts, *edges]):
            look = self.locate(cid, None, home)
            meta = session_meta(look.path) if look.path else {}
            src = meta.get("source") if isinstance(meta.get("source"), dict) else {}
            sub = src.get("subagent") if isinstance(src.get("subagent"), dict) else {}
            if sub.get("other") == "guardian":
                continue
            spawn = sub.get("thread_spawn") if isinstance(sub.get("thread_spawn"), dict) else {}
            a = acts.get(cid, {})
            why = []
            if spawn.get("parent_thread_id") == ref.native_id:
                why.append("子 rollout 的 session_meta.source.subagent.thread_spawn.parent_thread_id")
            if cid in edges:
                why.append("Codex 索引 thread_spawn_edges")
            if a:
                why.append("父 rollout 的 spawn_agent（SubAgentActivity / CollabAgentToolCall）")
            state = ("failed" if a.get("failed") else "done") if a.get("doneAt") or edges.get(cid) == "closed" else ("running" if edges.get(cid) == "open" or a else None)
            out.append(NativeRef(
                "codex",
                cid,
                look.path,
                meta.get("cwd") or ref.cwd,
                ParentLink("native", ref.run_id, tool_call_id=a.get("callId"), evidence="、".join(why)),
                label=str(spawn.get("agent_nickname") or a.get("nickname") or a.get("path") or cid),
                meta={"role": spawn.get("agent_role"), "path": spawn.get("agent_path") or a.get("path"), "depth": spawn.get("depth") or 1, "dispatchedAt": a.get("at"), "doneAt": a.get("doneAt"), "interactions": a.get("interactions") or [], "edge": edges.get(cid), "state": state},
            ))
        return out

    # ——— Headless ———
    def headless_args(self, cmd: list[str], req: Any, *, log_exists: Callable[[str], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        o = req.options
        if o.fork_from:
            raise ValueError("Codex 只能在终端里分叉（codex fork）：点「在终端打开」")
        args = [*cmd, "exec"]
        if o.session:
            args += ["resume", o.session]
        args += ["--json", "--skip-git-repo-check"]
        if o.model:
            args += ["-m", o.model]
        if o.effort:
            args += ["-c", f"model_reasoning_effort={json.dumps(o.effort)}"]
        return [*args, "-"]

    # ——— Interactive ———
    def fork_argv(self, fork: dict[str, Any]) -> list[str]:
        return ["codex", "fork", fork["from"]]

    def interactive_argv(self, native_id: str | None, model: str | None, effort: str | None, *, new: bool = False, has_log: Callable[[], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        args = ["codex", "resume", native_id] if native_id else ["codex"]
        if model:
            args += ["-m", model]
        if effort:
            args += ["-c", f"model_reasoning_effort={json.dumps(effort)}"]
        return args

    project_skill_dir = ".agents/skills"  # where it looks for project skills

    # ——— Catalog ———
    def catalog(self, env: dict[str, str], root: Path | None) -> dict[str, Any]:
        return agent_models.SOURCES["codex"](env, root)
