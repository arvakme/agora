"""Builders for the native logs of the observed CLIs (Cursor transcripts, Devin's sessions.db), shaped
like what the real CLIs write (surveyed on the local machine 2026-09-29)."""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

# ——— Cursor (cursor-agent) ———


def cursor_slug(path: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", path).strip("-")


def cursor_user(text: str, ts: str | None = "Monday, Sep 28, 2026, 4:22 PM (UTC+8)") -> dict:
    head = f"<timestamp>{ts}</timestamp>\n" if ts else ""
    return {"role": "user", "message": {"content": [{"type": "text", "text": f"{head}<user_query>\n{text}\n</user_query>"}]}}


def cursor_says(*blocks: dict) -> dict:
    return {"role": "assistant", "message": {"content": list(blocks)}}


def cursor_text(t: str) -> dict:
    return {"type": "text", "text": t}


def cursor_tool(name: str, inp: Any) -> dict:
    return {"type": "tool_use", "name": name, "input": inp}


def cursor_end(status: str = "success", error: str | None = None) -> dict:
    return {"type": "turn_ended", "status": status, **({"error": error} if error else {})}


def cursor_transcript(home: Path, cwd: str, chat: str, recs: list[dict]) -> Path:
    p = home / ".cursor" / "projects" / cursor_slug(cwd) / "agent-transcripts" / chat / f"{chat}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in recs))
    return p


def cursor_subagent(parent: Path, child: str, recs: list[dict]) -> Path:
    p = parent.parent / "subagents" / f"{child}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in recs))
    return p


# ——— Devin (devin CLI): ~/.local/share/devin/cli/sessions.db ———
# The tables the adapter reads, as the CLI's migrations (V17) create them.
DEVIN_SCHEMA = """
CREATE TABLE refinery_schema_history(version int4 PRIMARY KEY, name VARCHAR(255), applied_on VARCHAR(255), checksum VARCHAR(255));
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0,
  cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER,
  chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id));
CREATE INDEX idx_message_nodes_session ON message_nodes(session_id);
CREATE TABLE subagent_heads (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, chain_node_id INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, agent_id));
INSERT INTO refinery_schema_history VALUES (17, 'subagent_heads', '2026-09-11T15:30:42Z', '0');
"""


def devin_db(home: Path) -> Path:
    db = home / ".local" / "share" / "devin" / "cli" / "sessions.db"
    if not db.exists():
        db.parent.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(db)
        con.executescript(DEVIN_SCHEMA)
        con.commit()
        con.close()
    return db


def iso(ms: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class DevinSession:
    """One session of the forest the CLI writes: every node has a parent; ``say`` appends to the current chain."""

    def __init__(self, home: Path, sid: str, cwd: str, t0_ms: int) -> None:
        self.db = devin_db(home)
        self.sid, self.cwd, self.t0 = sid, cwd, t0_ms
        self.nodes: list[tuple[int, int | None, dict]] = []
        self.head: int | None = None
        self.n = 0
        self.agent_heads: dict[str, int] = {}

    def node(self, msg: dict, parent: int | None | str = "head") -> int:
        nid = self.n
        self.n += 1
        par = self.head if parent == "head" else parent
        self.nodes.append((nid, par, msg))
        self.head = nid
        return nid

    def msg(self, role: str, at_s: float, mid: str, content: str = "", **extra: Any) -> dict:
        md = {"created_at": iso(int(self.t0 + at_s * 1000)), **extra.pop("metadata", {})}
        return {"message_id": mid, "role": role, "content": content, **extra, "metadata": md}

    def system(self, at_s: float, mid: str) -> int:
        return self.node(self.msg("system", at_s, mid, "<rules and skills>", metadata={"extensions": {"agent-ext/rules-loaded": {"rule_paths": ["/x/AGENTS.md"]}}}))

    def user(self, at_s: float, mid: str, text: str, typed: bool = True) -> int:
        return self.node(self.msg("user", at_s, mid, text, metadata={"is_user_input": True if typed else None}))

    def call(self, at_s: float, mid: str, calls: list[tuple[str, str, dict]], text: str = "", twice: bool = True) -> int:
        """An assistant message with tool calls; the CLI saves it twice (a leaf, then the kept copy)."""
        tcs = [{"id": cid, "name": name, "arguments": args, "index": i, "kind": "function"} for i, (cid, name, args) in enumerate(calls)]
        m = self.msg("assistant", at_s, mid, text, tool_calls=tcs, metadata={"finish_reason": "tool_calls", "generation_model": "swe-2-medium", "metrics": {"input_tokens": 900, "output_tokens": 40, "cache_read_tokens": 8000}})
        if twice:
            parent = self.head
            self.node(dict(m))
            self.head = parent
        return self.node({**m, "metadata": {**m["metadata"], "extensions": {"chisel/tool_call_content": {}}}})

    def result(self, at_s: float, mid: str, call_id: str, content: str, took_s: float = 0.2, ok: bool = True) -> int:
        start = int(self.t0 + at_s * 1000)
        ext = {"chisel/tool_call_timing": {"started_at": iso(start), "finished_at": iso(int(start + took_s * 1000)), "duration_ms": int(took_s * 1000)}, "chisel/tool_result_meta": {"success": ok, "kind": "read"}}
        return self.node(self.msg("tool", at_s + took_s, mid, content, tool_call_id=call_id, metadata={"extensions": ext}))

    def reply(self, at_s: float, mid: str, text: str, finish: str = "stop") -> int:
        return self.node(self.msg("assistant", at_s, mid, text, tool_calls=[], metadata={"finish_reason": finish, "generation_model": "swe-2-medium"}))

    def save(self, *, last_s: float | None = None, hidden: int = 0) -> Path:
        con = sqlite3.connect(self.db)
        last = int((self.t0 / 1000) + (last_s if last_s is not None else (self.n + 1)))
        con.execute("insert or replace into sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, main_chain_id, hidden, metadata, workspace_dirs) values (?,?,?,?,?,?,?,?,?,?,?)",
                    (self.sid, self.cwd, "windsurf", "swe-2-medium", "bypass", int(self.t0 / 1000), last, self.head, hidden, json.dumps({"total_credit_cost": 0}), "[]"))
        con.execute("delete from message_nodes where session_id = ?", (self.sid,))
        # The CLI re-writes the whole forest on save: every row gets the save time as created_at.
        con.executemany("insert into message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) values (?,?,?,?,?,?)",
                        [(self.sid, nid, par, json.dumps(m, ensure_ascii=False), last, None) for nid, par, m in self.nodes])
        for agent, head in self.agent_heads.items():
            con.execute("insert or replace into subagent_heads values (?,?,?,?)", (self.sid, agent, head, last))
        con.commit()
        con.close()
        return self.db / self.sid
