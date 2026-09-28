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
from server.canvas.adapters.base import Adapter, VersionRange, tool_facts
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
    return tool_facts(act, reads=reads, spawn=spawn_in_output(out))


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
    tested = VersionRange(">=0.128,<0.158")
    max_tier = "T1"
    seedmux_names = ("codex",)
    icon = "codex"
    log_hint = "~/.codex/sessions/年/月/日/rollout-*-<id>.jsonl"
    delete_hint = "rm ~/.codex/sessions/*/*/*/rollout-*-<id>.jsonl"

    assigns_id = "cli"
    can_fork_headless = False
    terminal_fork = "codex fork"
    Mapper = CodexStream
    survives_move = True

    # ——— Locator ———
    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not native_id:
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

    # ——— Projector ———
    known_types = frozenset()  # filled in by the drift step

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
