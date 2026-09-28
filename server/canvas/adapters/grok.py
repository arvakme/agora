"""**v2, off by default** — registered only with ``AGORA_EXPERIMENTAL=grok`` (experimental.py).

Grok (xAI ``grok`` CLI) — T2, observed only (user decision 2026-09-28: never a session agent).

- Log: ``$GROK_HOME`` (``~/.grok``) ``/sessions/<URL-encoded cwd>/<session id>/updates.jsonl`` (the
  authoritative log; ``/resume`` replays it) plus ``summary.json``, ``subagents/<id>/meta.json``.
  Long encoded names are shortened by the CLI (a ``.cwd`` file then holds the real cwd), so a
  session is found by id with a glob, never by computing the folder. An id survives a project move
  (``-r <id>`` works from anywhere; measured 2026-09-28).
- Records: ``{timestamp, method, params: {sessionId, update: {sessionUpdate, …}, _meta}}`` — ACP
  session updates plus xAI extensions (``turn_completed``, ``subagent_spawned``…). The CLI's docs
  say the list is non-exhaustive: unknown types are counted as drift, never fatal.
- Tools carry ``_meta."x.ai/tool".kind`` (read / edit / write / execute / search / …): classified
  without a name table. Writes: ``write`` / ``search_replace`` ``file_path`` and ``diff`` content.
- Usage: ``turn_completed.usage`` — ``inputTokens`` includes the cache (subtracted here);
  cost in ``costUsdTicks`` (1 USD = 1e10 ticks).
- Sub-agents: ``spawn_subagent`` → parent ``subagent_spawned`` / ``subagent_finished`` with
  ``child_session_id``, ``subagents/<id>/meta.json``, and the child is a normal session.
- Never calls ``grok trace`` (it uploads). Nothing here runs the CLI except ``--version``.
"""

from __future__ import annotations

import glob
import json
import os
import urllib.parse
from pathlib import Path
from typing import Any

from server.canvas.adapters.base import Adapter, NativeRef, ParentLink, VersionRange, tool_facts
from server.canvas.adapters.common import MAX_TEXT, LogLookup, Out, State, _clip, _end, _full, _ms, _start, _summary, _usage, read_jsonl, rel_path, user_item
from server.canvas.adapters.tools import activity_of, shell_reads, spawn_in_output

TICKS = 1e10
KIND_ACTIVITY = {"read": "read", "edit": "edit", "write": "write", "delete": "edit", "move": "edit", "execute": "commands", "search": "search", "fetch": "webFetch", "think": "plan", "plan": "plan", "task": "subagents"}
WRITE_OPS = {"write": "write", "search_replace": "edit", "edit": "edit", "multi_edit": "edit", "delete_file": "delete", "apply_patch": "edit"}


def grok_home(home: Path | None = None) -> Path:
    return Path(os.environ.get("GROK_HOME") or (home or Path.home()) / ".grok")


def enc_cwd(cwd: str) -> str:
    return urllib.parse.quote(cwd, safe="")


def _tool_meta(u: dict[str, Any]) -> dict[str, Any]:
    m = u.get("_meta") if isinstance(u.get("_meta"), dict) else {}
    t = m.get("x.ai/tool")
    return t if isinstance(t, dict) else {}


def classify(name: str, kind: str | None, args: Any, root: str | None) -> dict[str, Any]:
    a = args if isinstance(args, dict) else {}
    act = KIND_ACTIVITY.get((kind or "").lower()) or activity_of(name)
    reads: list[str] = []
    fs: list[dict[str, str]] = []
    if name in WRITE_OPS and isinstance(a.get("file_path"), str):
        fs = [{"path": rel_path(a["file_path"], root), "op": WRITE_OPS[name]}]
    if name == "read_file" and isinstance(a.get("target_file"), str):
        reads = [rel_path(a["target_file"], root)]
    if name == "run_terminal_command":
        got, reads = shell_reads(a.get("command"), root, root)
        act = got or act
    if name in ("spawn_subagent",):
        act = "subagents"
    waits = name in ("ask_user_question",) or act == "questions"
    return tool_facts("questions" if waits else act, files=fs, reads=reads, waits_user=waits, spawn={"childKind": "grok", "via": "native"} if name == "spawn_subagent" else None)


def project(rec: dict[str, Any], st: State) -> Out:
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    params = rec.get("params") if isinstance(rec.get("params"), dict) else {}
    u = params.get("update") if isinstance(params.get("update"), dict) else None
    if u is None:
        return items, turns
    meta = params.get("_meta") if isinstance(params.get("_meta"), dict) else {}
    t = u.get("sessionUpdate")
    at = _ms(meta.get("agentTimestampMs") or rec.get("timestamp"))
    x = st.extra
    if t == "user_message_chunk":
        text = str((u.get("content") or {}).get("text") or "")
        pidx = (u.get("_meta") or {}).get("promptIndex")
        key = f"u-{pidx if pidx is not None else meta.get('eventId')}"
        if x.get("user_id") != key:
            # A new prompt: the previous turn (if any) ended without a turn_completed record.
            x["user_id"], x["user_text"], x["asst_n"] = key, "", 0
            x["asst_text"] = ""
            x["user_at"] = at
            _start(st, turns, key, at)
        x["user_text"] += text
        items.append(user_item(key, x["user_text"], x["user_at"]))
    elif t == "agent_message_chunk":
        text = str((u.get("content") or {}).get("text") or "")
        if x.get("asst_open") is None:
            x["asst_n"] = x.get("asst_n", 0) + 1
            x["asst_text"] = ""
            x["asst_open"] = f"a-{meta.get('promptId') or x.get('user_id')}-{x['asst_n']}"
            x["asst_at"] = at
        x["asst_text"] += text
        if x["asst_text"].strip():
            st.last_text = x["asst_text"]
            items.append({"id": x["asst_open"], "kind": "assistant", "text": _clip(x["asst_text"], MAX_TEXT), "at": x["asst_at"]})
    elif t == "tool_call":
        x["asst_open"] = None
        tid = str(u.get("toolCallId"))
        tm = _tool_meta(u)
        name = str(tm.get("name") or u.get("title") or "tool")
        args = u.get("rawInput")
        st.pending.add(tid)
        facts = classify(name, tm.get("kind") or u.get("kind"), args, st.root)
        tool: dict[str, Any] = {"name": name, "input": _summary(args), "args": _full(args), **{k: v for k, v in facts.items()}}
        x.setdefault("tools", {})[tid] = name
        if isinstance(args, dict) and isinstance(args.get("command"), str):
            x.setdefault("cmds", {})[tid] = args["command"]
        items.append({"id": tid, "kind": "tool", "at": at, "tool": tool})
    elif t == "tool_call_update":
        tid = str(u.get("toolCallId"))
        status = str(u.get("status") or "").lower()
        if status not in ("completed", "failed"):
            return items, turns
        st.pending.discard(tid)
        ro = u.get("rawOutput") if isinstance(u.get("rawOutput"), dict) else {}
        out = ro.get("output_for_prompt") or ro.get("tool_output_for_prompt") or ((ro.get("EditsApplied") or {}).get("tool_output_for_prompt") if isinstance(ro.get("EditsApplied"), dict) else None)
        if out is None:
            out = "".join(str(((c or {}).get("content") or {}).get("text") or "") for c in (u.get("content") or []) if isinstance(c, dict) and c.get("type") == "content")
        err = status == "failed" or (isinstance(ro.get("exit_code"), int) and ro["exit_code"] != 0)
        done: dict[str, Any] = {"output": _full(str(out or "")), "isError": bool(err)}
        diffs = [c.get("path") for c in (u.get("content") or []) if isinstance(c, dict) and c.get("type") == "diff" and c.get("path")]
        if diffs and not err:
            op = "write" if x.get("tools", {}).get(tid) == "write" else "edit"
            done["files"] = [{"path": rel_path(str(p), st.root), "op": op} for p in dict.fromkeys(diffs)]
        sp = spawn_in_output(str(out or ""), ro.get("command") or x.get("cmds", {}).get(tid))
        if sp:
            done["spawn"] = sp
        items.append({"id": tid, "kind": "tool", "at": at, "endAt": at, "tool": done})
    elif t == "subagent_spawned":
        cid = u.get("child_session_id") or u.get("subagent_id")
        spawn_tool = next((tid for tid, n in reversed(list(x.get("tools", {}).items())) if n == "spawn_subagent" and tid not in x.setdefault("spawned", {})), None)
        if spawn_tool and cid:
            x["spawned"][spawn_tool] = cid
            items.append({"id": spawn_tool, "kind": "tool", "at": at, "tool": {"spawn": {"childKind": "grok", "childId": str(cid), "via": "native", **({"role": str(u["subagent_type"])} if u.get("subagent_type") else {})}}})
    elif t == "turn_completed":
        x["asst_open"] = None
        us = u.get("usage") if isinstance(u.get("usage"), dict) else {}
        if us:
            inp, cached = us.get("inputTokens"), us.get("cachedReadTokens")
            uncached = inp - cached if isinstance(inp, int) and isinstance(cached, int) else inp
            cost = us["costUsdTicks"] / TICKS if isinstance(us.get("costUsdTicks"), (int, float)) else None
            model = next(iter(us.get("modelUsage") or {}), None)
            items.append({"id": f"u-{u.get('prompt_id') or meta.get('eventId')}", "kind": "usage", "at": at, "usage": _usage(model, uncached, us.get("outputTokens"), cached, us.get("cacheCreationTokens"), cost)})
        reason = u.get("stop_reason")
        _end(st, turns, None if reason in (None, "end_turn") else str(reason), items, at)
    return items, turns


class GrokAdapter(Adapter):
    kind = "grok"
    name = "Grok"
    binaries = ("grok",)
    tested = VersionRange(">=1.0.40,<1.1")
    max_tier = "T2"
    seedmux_names = ("grok",)
    icon = "grok"
    log_hint = "~/.grok/sessions/<URL 编码的目录>/<id>/updates.jsonl"
    log_dir = "~/.grok/sessions/"
    delete_hint = "grok sessions delete {id}"
    has_cost = True
    waits = "inferred"

    handled_types = frozenset({"user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "turn_completed", "subagent_spawned", "subagent_finished"})
    ignored_types = frozenset({
        "agent_thought_chunk", "hook_execution", "plan", "task_backgrounded", "task_completed", "background_tasks", "session_recap",
        "retry_state", "auto_compact_started", "auto_compact_completed", "compaction_checkpoint", "memory_dream_queued",
        "memory_dream_started", "memory_dream_completed", "memory_observation", "memory_updated", "image_compressed",
        "current_mode_update", "available_commands_update", "usage",
    })
    gap_types = frozenset()
    known_types = handled_types | ignored_types

    def version_in_record(self, rec: dict[str, Any]) -> str | None:
        return None

    # ——— Locator ———
    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not native_id:
            return LogLookup("missing")
        hits = sorted(Path(p) for p in glob.glob(str(grok_home(home) / "sessions" / "*" / glob.escape(native_id) / "updates.jsonl")))
        if len(hits) == 1:
            return LogLookup("found", hits[0], tuple(hits))
        if root is not None:
            mine = [p for p in hits if session_cwd(p.parent) == str(root)]
            if len(mine) == 1:
                return LogLookup("found", mine[0], tuple(hits))
        return LogLookup("ambiguous" if hits else "missing", None, tuple(hits))

    def sessions_for(self, roots: list[str], home: Path | None = None) -> list[dict[str, Any]]:
        base = grok_home(home) / "sessions"
        out = []
        for root in roots:
            for p in glob.glob(str(base / enc_cwd(root) / "*" / "updates.jsonl")):
                out.append({"agent": "grok", "nativeId": Path(p).parent.name, "path": Path(p), "cwd": root})
        return out

    def sample_pattern(self, home: Path) -> str:
        return str(grok_home(home) / "sessions" / "*" / "*" / "updates.jsonl")

    def log_format(self, path: Path) -> str | None:
        try:
            s = json.loads((path.parent / "summary.json").read_text())
        except (OSError, ValueError):
            return None
        v = s.get("chat_format_version") if isinstance(s, dict) else None
        return str(v) if v is not None else None

    # ——— Projector ———
    def project(self, rec: dict[str, Any], st: State) -> Out:
        return project(rec, st)

    def record_type(self, rec: dict[str, Any]) -> str | None:
        u = (rec.get("params") or {}).get("update") if isinstance(rec.get("params"), dict) else None
        return str(u.get("sessionUpdate")) if isinstance(u, dict) and u.get("sessionUpdate") else None

    # ——— ToolVocab ———
    def classify(self, name: str, args: Any, root: str | None = None) -> dict[str, Any]:
        return classify(name, None, args, root)

    # ——— Subagents ———
    def children(self, ref: NativeRef, home: Path | None = None) -> list[NativeRef]:
        """``subagent_spawned`` / ``subagent_finished`` in the parent's updates.jsonl, the parent's
        ``subagents/<id>/meta.json``, and the child session (a normal session, found by id)."""
        if ref.path is None:
            return []
        spawned: dict[str, dict[str, Any]] = {}
        tools: list[tuple[str, int]] = []
        for rec in read_jsonl(ref.path):
            params = rec.get("params") if isinstance(rec.get("params"), dict) else {}
            u = params.get("update") if isinstance(params.get("update"), dict) else {}
            at = _ms((params.get("_meta") or {}).get("agentTimestampMs") or rec.get("timestamp"))
            t = u.get("sessionUpdate")
            if t == "tool_call" and (_tool_meta(u).get("name") or u.get("title")) == "spawn_subagent":
                tools.append((str(u.get("toolCallId")), at))
            elif t == "subagent_spawned":
                cid = str(u.get("child_session_id") or u.get("subagent_id") or "")
                if cid:
                    used = {s.get("callId") for s in spawned.values()}
                    call = next((c for c, _ in reversed(tools) if c not in used), None)
                    spawned[cid] = {"at": at, "callId": call, "role": u.get("subagent_type") or u.get("role"), "label": u.get("description"), "model": u.get("model")}
            elif t == "subagent_finished":
                cid = str(u.get("child_session_id") or u.get("subagent_id") or "")
                s = spawned.setdefault(cid, {})
                s.update({"doneAt": at, "state": {"completed": "done", "failed": "failed", "cancelled": "failed", "killed": "failed"}.get(str(u.get("status")), "done")})
        subdir = ref.path.parent / "subagents"
        if subdir.is_dir():
            for mf in subdir.glob("*/meta.json"):
                try:
                    m = json.loads(mf.read_text())
                except (OSError, ValueError):
                    continue
                cid = str(m.get("child_session_id") or m.get("subagent_id") or mf.parent.name)
                s = spawned.setdefault(cid, {})
                s.setdefault("label", m.get("description"))
                s.setdefault("role", m.get("subagent_type"))
                s.setdefault("cwd", m.get("child_cwd"))
                s["meta_file"] = True
        out = []
        for cid, s in spawned.items():
            look = self.locate(cid, None, home)
            why = ["父 updates.jsonl 的 subagent_spawned.child_session_id"] if s.get("at") else []
            if s.get("meta_file"):
                why.append("父会话 subagents/<id>/meta.json")
            out.append(NativeRef(
                "grok", cid, look.path, s.get("cwd") or (session_cwd(look.path.parent) if look.path else ref.cwd),
                ParentLink("native", ref.run_id, tool_call_id=s.get("callId"), evidence="、".join(why)),
                label=str(s.get("label") or cid), meta={"role": s.get("role"), "model": s.get("model"), "dispatchedAt": s.get("at"), "doneAt": s.get("doneAt"), "state": s.get("state") or ("running" if s.get("at") else None), "depth": 1},
            ))
        return out

    # ——— fixtures (tests/test_adapter_contracts.py) ———
    def fixture_place(self, folder: Path, home: Path, cwd: str, nid: str) -> Path:
        import shutil

        d = home / ".grok" / "sessions" / enc_cwd(cwd) / nid
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(folder / "updates.jsonl", d / "updates.jsonl")
        for extra in ("summary.json",):
            if (folder / extra).exists():
                shutil.copy(folder / extra, d / extra)
        if (folder / "subagents").is_dir():
            shutil.copytree(folder / "subagents", d / "subagents")
        for child in sorted((folder / "children").glob("*")) if (folder / "children").is_dir() else []:
            cd = home / ".grok" / "sessions" / enc_cwd(cwd) / child.name
            shutil.copytree(child, cd)
        return d / "updates.jsonl"


def session_cwd(session_dir: Path) -> str | None:
    """The cwd a session folder belongs to: ``summary.json`` ``info.cwd``, the ``.cwd`` file, or the decoded folder name."""
    try:
        s = json.loads((session_dir / "summary.json").read_text())
        c = (s.get("info") or {}).get("cwd")
        if c:
            return str(c)
    except (OSError, ValueError, AttributeError):
        pass
    try:
        return (session_dir.parent / ".cwd").read_text().strip()
    except OSError:
        return urllib.parse.unquote(session_dir.parent.name)
