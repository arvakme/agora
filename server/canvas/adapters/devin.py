"""Devin (``devin`` CLI, Cognition) — T2, observed only (user decision 2026-09-28: never a session agent).

- Log: one SQLite database for all sessions, ``~/.local/share/devin/cli/sessions.db`` (WAL, GBs),
  opened read-only (``mode=ro``) and queried by session id only (user decision: read-only queries,
  the contract test as the safety net). Tables read: ``sessions`` (``working_directory``,
  ``created_at`` / ``last_activity_at`` in unix seconds, ``main_chain_id``), ``message_nodes``
  (``chat_message`` JSON), ``subagent_heads`` (sub-agent chains), ``refinery_schema_history``
  (the schema version: the log format, V17 now). A session has no file of its own: Agora
  addresses it as ``<db>/<session id>`` (``NativeRef.path``, ``logPath``) and reads it through
  ``read_records`` / ``log_stat``.
- The messages are a forest the CLI rewrites when it saves: an assistant message with tool calls is
  stored twice (a leaf, then the copy the chain continues from), a compaction adds the recent
  messages again under a new root, and every row carries the save time. A session's records are
  therefore its distinct messages (by ``message_id``, latest copy) in the order of their own
  ``metadata.created_at``, without the messages that only a sub-agent's chain holds.
- Records (``role``): ``system`` (rules, skills, summaries — ignored); ``user`` (``metadata.is_user_input``
  marks the person's prompt, the rest is context the CLI adds); ``assistant`` (``content``,
  ``tool_calls`` [{id, name, arguments}], ``metadata.metrics`` with tokens outside the cache,
  ``generation_model``, ``finish_reason``); ``tool`` (``tool_call_id``, the output,
  ``chisel/tool_call_timing``, ``chisel/tool_result_meta.success``). A turn ends at an assistant
  message without tool calls (no end record exists).
- Tools: read / write / edit / exec (``workdir``) / grep / find_file_by_name / get_output / kill_shell /
  todo_write / webfetch / web_search / ask_user_question / run_subagent …
- Seedmux starts it as ``devin --permission-mode dangerous --respect-workspace-trust false -- <prompt>``
  and never learns its session id (no hooks): ``worker_for_ticket`` finds the session in the
  ticket's cwd that was given the ticket.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.parse
from contextlib import closing
from pathlib import Path
from typing import Any

from server.canvas.adapters.base import Adapter, VersionRange, tool_facts, valid_id
from server.canvas.adapters.common import MAX_TEXT, LogLookup, Out, State, _clip, _end, _full, _ms, _start, _summary, _usage, rel_path, text_of, user_item
from server.canvas.adapters.shell_files import shell_tool
from server.canvas.adapters.tools import activity_of, prompt_names_ticket, replies_to_ticket, spawn_in_output

DB = "sessions.db"
TICKET_PAD_S = 120  # a worker session is active after its ticket was created (minus this)
ACTIVITY = {"get_output": "commands", "kill_shell": "commands", "write_to_process": "commands", "find_file_by_name": "search", "todo_write": "plan", "webfetch": "webFetch", "web_search": "webSearch", "run_subagent": "subagents", "read_subagent": "subagents", "notebook_read": "read", "notebook_edit": "edit", "request_scope": "questions"}
WRITES = {"write": "write", "edit": "edit", "notebook_edit": "edit"}


def db_path(home: Path | None = None) -> Path:
    return (home or Path.home()) / ".local" / "share" / "devin" / "cli" / DB


def _split(path: Path | None) -> tuple[Path, str] | None:
    """(database, session id) of a session's address ``<db>/<id>``."""
    if path is None or path.parent.name != DB or not valid_id(path.name):
        return None
    return path.parent, path.name


def _query(db: Path, sql: str, args: tuple | list = ()) -> list[tuple]:
    """Rows of one read-only query; [] when the database is missing, locked past the timeout or older."""
    if not db.is_file():
        return []
    try:
        with closing(sqlite3.connect(f"file:{urllib.parse.quote(str(db))}?mode=ro", uri=True, timeout=2)) as con:
            return con.execute(sql, tuple(args)).fetchall()
    except sqlite3.Error:
        return []


def messages(rows: list[tuple[int, int | None, str]], sub_heads: list[int], main_head: int | None) -> list[dict[str, Any]]:
    """A session's distinct messages in time order, from its ``message_nodes`` rows (node, parent,
    chat_message): the latest copy of each ``message_id``, none that only a sub-agent chain holds."""
    parent = {n: p for n, p, _ in rows}
    msgs: dict[int, dict[str, Any]] = {}
    for n, _, raw in rows:
        try:
            m = json.loads(raw)
        except ValueError:
            continue
        if isinstance(m, dict):
            msgs[n] = m

    def chain(head: int | None) -> list[int]:
        out: list[int] = []
        while head is not None and head in parent and head not in out:
            out.append(head)
            head = parent[head]
        return out

    mid = lambda n: str(msgs[n].get("message_id") or f"node-{n}")  # noqa: E731
    main = {mid(n) for n in chain(main_head) if n in msgs}
    sub = {mid(n) for h in sub_heads for n in chain(h) if n in msgs} - main
    latest: dict[str, int] = {}
    for n in sorted(msgs):
        if mid(n) not in sub:
            latest[mid(n)] = n
    when = lambda n: _ms(((msgs[n].get("metadata") or {}) if isinstance(msgs[n].get("metadata"), dict) else {}).get("created_at"))  # noqa: E731
    return [msgs[n] for n in sorted(latest.values(), key=lambda n: (when(n), n))]


def _args(v: Any) -> Any:
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def classify(name: str, args: Any, root: str | None) -> dict[str, Any]:
    a = args if isinstance(args, dict) else {}
    n = (name or "").lower()
    act = ACTIVITY.get(n) or activity_of(name)
    reads: list[str] = []
    on: list[str] = []
    files: list[dict[str, str]] = []
    p = next((a[k] for k in ("file_path", "notebook_path", "path") if isinstance(a.get(k), str) and a.get(k)), None)
    if n in WRITES and p:
        files = [{"path": rel_path(p, root), "op": WRITES[n]}]
    elif n in ("read", "notebook_read") and p:
        reads = [rel_path(p, root)]
    elif n == "exec":
        cwd = a.get("workdir") if isinstance(a.get("workdir"), str) and a.get("workdir") else root
        got, reads, shell_fs, on = shell_tool(a.get("command"), root, cwd)
        act, files = got or act, shell_fs or files
    elif n == "grep" and p and "." in p.rstrip("/").rsplit("/", 1)[-1]:
        reads = [rel_path(p, root)]
    role = a.get("profile") or a.get("subagent_type")
    spawn = {"childKind": "devin", "via": "native", **({"role": str(role)} if role else {})} if n == "run_subagent" else None
    return tool_facts(act, files=files, reads=reads, waits_user=act == "questions", spawn=spawn, on=on)


def project(rec: dict[str, Any], st: State) -> Out:
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    md = rec.get("metadata") if isinstance(rec.get("metadata"), dict) else {}
    at = _ms(md.get("created_at"))
    mid = str(rec.get("message_id") or "")
    role = rec.get("role")
    content = rec.get("content") if isinstance(rec.get("content"), str) else text_of(rec.get("content"))
    if role == "user":
        if md.get("is_user_input") is not True:
            return items, turns  # context the CLI adds (cache footers, continuation notes)
        items.append(user_item(f"u-{mid}", content, at))
        _start(st, turns, f"u-{mid}", at)
    elif role == "assistant":
        if content.strip():
            st.last_text = content
            items.append({"id": f"a-{mid}", "kind": "assistant", "text": _clip(content, MAX_TEXT), "at": at, "msg": mid})
        calls = [c for c in rec.get("tool_calls") or [] if isinstance(c, dict)]
        for c in calls:
            tid, name, args = str(c.get("id")), str(c.get("name") or "tool"), _args(c.get("arguments"))
            st.pending.add(tid)
            if isinstance(args, dict) and isinstance(args.get("command"), str):
                st.extra.setdefault("cmds", {})[tid] = args["command"]
            items.append({"id": tid, "kind": "tool", "at": at, "msg": mid, "tool": {"name": name, "input": _summary(args), "args": _full(args), **classify(name, args, st.root)}})
        mt = md.get("metrics") if isinstance(md.get("metrics"), dict) else {}
        if mt.get("input_tokens") or mt.get("output_tokens"):
            items.append({"id": f"usage-{mid}", "kind": "usage", "at": at, "msg": mid, "usage": _usage(md.get("generation_model"), mt.get("input_tokens"), mt.get("output_tokens"), mt.get("cache_read_tokens"), mt.get("cache_creation_tokens"))})
        if not calls and md.get("finish_reason") != "max_tokens":
            _end(st, turns, None, items, at)
    elif role == "tool":
        tid = str(rec.get("tool_call_id"))
        st.pending.discard(tid)
        ext = md.get("extensions") if isinstance(md.get("extensions"), dict) else {}
        timing = ext.get("chisel/tool_call_timing") if isinstance(ext.get("chisel/tool_call_timing"), dict) else {}
        result = ext.get("chisel/tool_result_meta") if isinstance(ext.get("chisel/tool_result_meta"), dict) else {}
        done: dict[str, Any] = {"output": _full(content), "isError": result.get("success") is False or bool(ext.get("chisel/tool_failure"))}
        sp = spawn_in_output(content, st.extra.get("cmds", {}).pop(tid, None))
        if sp:
            done["spawn"] = sp
        items.append({"id": tid, "kind": "tool", "at": at, "endAt": _ms(timing["finished_at"]) if timing.get("finished_at") else at, "tool": done})
    return items, turns


class DevinAdapter(Adapter):
    kind = "devin"
    name = "Devin"
    binaries = ("devin",)
    tested = VersionRange(">=3000.10.21,<3000.11")
    max_tier = "T2"
    seedmux_names = ("devin",)
    icon = "devin"
    log_hint = "~/.local/share/devin/cli/sessions.db（SQLite，只读查询）"
    log_dir = "~/.local/share/devin/cli/sessions.db"
    delete_hint = "devin rm --force {id}"
    has_cost = False
    waits = "inferred"

    handled_types = frozenset({"user", "assistant", "tool"})
    ignored_types = frozenset({"system"})
    gap_types = frozenset()
    known_types = handled_types | ignored_types

    # ——— Locator ———
    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not valid_id(native_id):
            return LogLookup("missing")
        db = db_path(home)
        if not _query(db, "select 1 from sessions where id = ?", (native_id,)):
            return LogLookup("missing")
        return LogLookup("found", db / native_id, (db / native_id,))

    def sessions_for(self, roots: list[str], home: Path | None = None) -> list[dict[str, Any]]:
        db = db_path(home)
        want = list(dict.fromkeys([*map(str, roots), *(os.path.realpath(r) for r in roots)]))
        if not want:
            return []
        rows = _query(db, f"select id, working_directory from sessions where working_directory in ({','.join('?' * len(want))}) order by created_at", want)
        return [{"agent": "devin", "nativeId": sid, "path": db / sid, "cwd": cwd} for sid, cwd in rows if valid_id(sid)]

    def log_cwd(self, path: Path) -> str | None:
        got = _split(path)
        rows = _query(got[0], "select working_directory from sessions where id = ?", (got[1],)) if got else []
        return rows[0][0] if rows else None

    def log_format(self, path: Path) -> str | None:
        got = _split(path)
        rows = _query(got[0], "select max(version) from refinery_schema_history") if got else []
        return str(rows[0][0]) if rows and rows[0][0] is not None else None

    def log_stat(self, path: Path) -> tuple[int, float, int] | None:
        """(bytes, last activity, newest row) of a session: the run timeline's cache key and "running"."""
        got = _split(path)
        rows = _query(got[0], "select (select coalesce(sum(length(chat_message)), 0) from message_nodes where session_id = ?), last_activity_at, (select max(row_id) from message_nodes where session_id = ?) from sessions where id = ?", (got[1], got[1], got[1])) if got else []
        return (int(rows[0][0]), float(rows[0][1]), int(rows[0][2] or 0)) if rows else None

    def sample_paths(self, home: Path, n: int) -> list[tuple[Path, str | None]]:
        db = db_path(home)
        return [(db / sid, None) for (sid,) in _query(db, "select id from sessions order by last_activity_at desc limit ?", (n,)) if valid_id(sid)]

    def read_records(self, path: Path, limit: int | None = None) -> list[dict[str, Any]]:
        got = _split(path)
        if got is None:
            return []
        db, sid = got
        rows: list[tuple[int, int | None, str]] = []
        size = 0
        for n, p, raw in _query(db, "select node_id, parent_node_id, chat_message from message_nodes where session_id = ? order by row_id", (sid,)):
            size += len(raw or "")
            if limit and size > limit:
                break
            rows.append((n, p, raw))
        heads = [h for (h,) in _query(db, "select chain_node_id from subagent_heads where session_id = ?", (sid,))]
        main = _query(db, "select main_chain_id from sessions where id = ?", (sid,))
        return messages(rows, heads, main[0][0] if main else None)

    # ——— Projector ———
    def project(self, rec: dict[str, Any], st: State) -> Out:
        return project(rec, st)

    def record_type(self, rec: dict[str, Any]) -> str | None:
        return str(rec["role"]) if rec.get("role") else None

    # ——— ToolVocab ———
    def classify(self, name: str, args: Any, root: str | None = None) -> dict[str, Any]:
        return classify(name, args, root)

    # ——— Seedmux workers (receipts.worker_ref) ———
    def worker_for_ticket(self, rc: dict[str, Any], home: Path | None = None) -> tuple[str, Path, str] | None:
        """The session in the ticket's cwd, alive while the ticket was open (created before its reply,
        active after its dispatch), whose first prompt names the ticket or which ran
        ``smx-team ack/reply`` for it: (session id, path, why)."""
        task, cwd = rc.get("taskId"), rc.get("cwd")
        if not task or not cwd:
            return None
        db = db_path(home)
        created = (rc.get("createdAt") or 0) / 1000
        until = (rc.get("repliedAt") or time.time() * 1000) / 1000
        like = "%" + str(task).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sids = _query(db, "select id from sessions s where working_directory in (?, ?) and last_activity_at >= ? and created_at <= ? and exists (select 1 from message_nodes m where m.session_id = s.id and m.chat_message like ? escape '\\') order by abs(created_at - ?)",
                      (str(cwd), os.path.realpath(cwd), int(created - TICKET_PAD_S), int(until + TICKET_PAD_S), like, int(created)))
        for (sid,) in sids:
            why = gave_ticket(self.read_records(db / sid), str(task)) if valid_id(sid) else None
            if why:
                return sid, db / sid, why
        return None

    # ——— fixtures (tests/test_adapter_contracts.py) ———
    def fixture_place(self, folder: Path, home: Path, cwd: str, nid: str) -> Path:
        """A sessions.db with the recorded schema (``schema.sql``), the session row (``session.json``)
        and its message rows (``log.jsonl``)."""
        db = db_path(home)
        db.parent.mkdir(parents=True, exist_ok=True)
        s = json.loads((folder / "session.json").read_text())
        rows = [json.loads(line) for line in (folder / "log.jsonl").read_text().splitlines() if line.strip()]
        with closing(sqlite3.connect(db)) as con:
            con.executescript((folder / "schema.sql").read_text())
            con.executemany("insert into refinery_schema_history (version, name) values (?, ?)", [(v, n) for v, n in s.get("schema_versions") or []])
            cols = [c for c in s["row"] if c != "id" and c != "working_directory"]
            con.execute(f"insert into sessions (id, working_directory, {', '.join(cols)}) values (?, ?, {', '.join('?' * len(cols))})", (nid, cwd, *(s["row"][c] for c in cols)))
            con.executemany("insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) values (?,?,?,?,?,?)",
                            [(nid, r["node_id"], r["parent_node_id"], json.dumps(r["chat_message"], ensure_ascii=False), r["created_at"], json.dumps(r["metadata"]) if r.get("metadata") is not None else None) for r in rows])
            con.commit()
        return db / nid


def gave_ticket(recs: list[dict[str, Any]], task: str) -> str | None:
    """Why a session is the ticket's worker, or None: its first prompt names the ticket (Seedmux's
    worker envelope), or it ran ``smx-team ack/reply <ticket>``."""
    first = next((r for r in recs if r.get("role") == "user" and isinstance(r.get("metadata"), dict) and r["metadata"].get("is_user_input") is True), None)
    if first is not None and prompt_names_ticket(first.get("content") if isinstance(first.get("content"), str) else text_of(first.get("content")), task):
        return f"（第一条提示就是工单 {task}）"
    for r in recs:
        for c in r.get("tool_calls") or [] if r.get("role") == "assistant" else []:
            args = _args(c.get("arguments")) if isinstance(c, dict) else None
            if isinstance(c, dict) and c.get("name") == "exec" and isinstance(args, dict) and replies_to_ticket(args.get("command"), task):
                return f"（它运行了 smx-team ack/reply {task}）"
    return None
