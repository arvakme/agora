"""Grok (xAI ``grok`` CLI) — T1 (was T2, observed only; the user decided on 2026-09-29 to make it a session agent).
Registered by default since its contract held against the installed 1.0.41 (2026-09-29).

- Headless: ``grok --prompt-json '[{"type":"text","text":"…"}]' --output-format streaming-json --always-approve
  (-s <uuid> for a new session, -r <uuid> to continue) [-m <model>] [--effort <level>]``; NDJSON on stdout,
  one turn per process, ends with an ``end`` event. The prompt goes as JSON (a prompt starting with "-" would
  be read as a flag). No permission asking: ``--always-approve`` (the user's 「默认不加边界」). SIGINT is ignored
  without a terminal: an interrupt is SIGTERM, and the log then has no turn end (measured, spike.md).
- Interactive: ``grok [-s|-r <id>] [-m] [--effort] --always-approve`` in Agora's tmux; the process keeps
  ``sessions/<cwd>/<id>/events.jsonl`` open (``native_from_open_files``).
- Catalog: ``~/.grok/models_cache.json`` (per-model ``reasoning_efforts``) and ``config.toml`` ``[models]``.

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
import re
import tomllib
import urllib.parse
from pathlib import Path
from typing import Any, Callable

from server.canvas.adapters.base import valid_id, Adapter, NativeRef, ParentLink, VersionRange, tool_facts
from server.canvas.adapters.common import MAX_TEXT, LogLookup, Out, State, StreamMapper, _clip, _end, _full, _ms, _start, _summary, _usage, add_usage, image_b64, read_jsonl, rel_path, user_item
from server.canvas.adapters.shell_files import shell_tool
from server.canvas.adapters.tools import activity_of
from server.canvas.runner import Usage, _int, _num, empty_usage

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
    on: list[str] = []
    fs: list[dict[str, str]] = []
    if name in WRITE_OPS and isinstance(a.get("file_path"), str):
        fs = [{"path": rel_path(a["file_path"], root), "op": WRITE_OPS[name]}]
    if name == "read_file" and isinstance(a.get("target_file"), str):
        reads = [rel_path(a["target_file"], root)]
    if name == "run_terminal_command":
        got, reads, shell_fs, on = shell_tool(a.get("command"), root, root)
        act, fs = got or act, shell_fs or fs
    if name in ("spawn_subagent",):
        act = "subagents"
    waits = name in ("ask_user_question",) or act == "questions"
    return tool_facts("questions" if waits else act, files=fs, reads=reads, waits_user=waits, spawn={"childKind": "grok", "via": "native"} if name == "spawn_subagent" else None, on=on)


ASKED_MODE = "always-approve"  # the ``--always-approve`` both run paths pass


class GrokStream(StreamMapper):
    """``grok --output-format streaming-json``: one ACP-style update per line (``text`` / ``thought`` deltas,
    ``tool_call`` / ``tool_call_update``, ``usage``, and ``end`` with the turn's totals). Text deltas are joined
    into one ``text`` event when a tool call or the end comes."""

    def __init__(self, model: str | None, session: str | None) -> None:
        super().__init__(model, session)
        self._buf = ""
        self._buf_at = 0
        self._said_mode = False

    def _flush(self, out: list[dict[str, Any]]) -> None:
        if self._buf.strip():
            out.append({"t": "text", "at": self._buf_at, "text": self._buf})
            self.text = self._buf
        self._buf = ""

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if not self._said_mode:  # Grok reports no mode of its own; say once, first, how Agora starts it (--always-approve)
            self._said_mode = True
            out.append({"t": "mode", "at": at, "mode": ASKED_MODE, "model": self.model})
        t = d.get("type")
        if t == "text":
            if not self._buf:
                self._buf_at = at
            self._buf += str(d.get("data") or "")
        elif t == "tool_call":
            self._flush(out)
            out.append({"t": "tool_use", "at": at, "id": str(d.get("toolCallId")), "name": str(d.get("toolName") or d.get("title") or "tool"), "input": d.get("rawInput")})
        elif t == "tool_call_update":
            status = str(d.get("status") or "").lower()
            if status in ("completed", "failed"):
                ro = d.get("rawOutput") if isinstance(d.get("rawOutput"), dict) else {}
                text = ro.get("output_for_prompt") or ro.get("tool_output_for_prompt")
                if text is None:
                    text = "".join(str(((c or {}).get("content") or {}).get("text") or "") for c in (d.get("content") or []) if isinstance(c, dict) and c.get("type") == "content")
                bad = status == "failed" or (isinstance(ro.get("exit_code"), int) and ro["exit_code"] != 0)
                out.append({"t": "tool_result", "at": at, "id": str(d.get("toolCallId")), "text": str(text or ""), "isError": bool(bad)})
        elif t == "end":
            self._flush(out)
            self.session = str(d.get("sessionId") or self.session or "") or None
            u = grok_usage(d, self.model)
            self.usage = add_usage(self.usage, u)
            out.append({"t": "usage", "at": at, "usage": u})
            reason = d.get("stopReason")
            if reason not in (None, "end_turn"):
                self.error = f"grok: {reason}"
            self.done = True
        elif t == "error":
            self.error = f"grok: {str(d.get('message') or d.get('data') or 'error')[:300]}"
        return out


def grok_usage(end: dict[str, Any], model: str | None) -> Usage:
    """The ``end`` event's totals (``input_tokens`` there does not include the cache reads)."""
    u = end.get("usage") if isinstance(end.get("usage"), dict) else {}
    used = next(iter(end.get("modelUsage") or {}), None)
    out = empty_usage(model or used)
    out["inputTokens"] = _int(u.get("input_tokens"))
    out["outputTokens"] = _int(u.get("output_tokens"))
    out["cacheReadTokens"] = _int(u.get("cache_read_input_tokens"))
    out["cacheWriteTokens"] = _int(u.get("cache_creation_input_tokens"))
    out["costUsd"] = _num(end.get("total_cost_usd"))
    return out


def grok_catalog_from(cache: dict[str, Any] | None, config: dict[str, Any]) -> dict[str, Any]:
    """Models and effort levels from ``models_cache.json`` (each model's ``reasoning_efforts``) and ``config.toml``."""
    rows = cache.get("models") if isinstance(cache, dict) and isinstance(cache.get("models"), dict) else {}
    cfg = config.get("models") if isinstance(config.get("models"), dict) else {}
    default = str(cfg.get("default") or "")
    configured = str(cfg.get("default_reasoning_effort") or "")
    models: list[str] = []
    names: dict[str, str] = {}
    efforts: dict[str, list[str]] = {}
    model_default: dict[str, str] = {}
    for slug, row in rows.items():
        info = row.get("info") if isinstance(row, dict) and isinstance(row.get("info"), dict) else {}
        if info.get("hidden") and slug != default:
            continue
        models.append(str(slug))
        if info.get("name"):
            names[str(slug)] = str(info["name"])
        lv = [str(e.get("id")) for e in info.get("reasoning_efforts") or [] if isinstance(e, dict) and e.get("id")] if info.get("supports_reasoning_effort") else []
        efforts[str(slug)] = lv
        model_default[str(slug)] = str(info.get("reasoning_effort") or "")
    if default and default not in models:
        models.insert(0, default)
    first = default if default in models else (models[0] if models else "")
    efforts[""] = efforts.get(first, [])
    model_default[""] = model_default.get(first, "")

    def default_effort(model: str) -> str:
        lv = efforts.get(model, [])
        if configured and configured in lv:
            return configured
        return model_default.get(model, "") if model_default.get(model, "") in lv else ""

    src = "grok models_cache.json" if rows else "none"
    return {
        "default": default or first,
        "models": models,
        "featured": models[:6],
        "names": names,
        "providers": {},
        "allowed": models if rows else None,
        "scope": {"kind": "cli", "source": src},
        "efforts": list(dict.fromkeys(x for m in models for x in efforts.get(m, []))),
        "modelEfforts": {k: v for k, v in efforts.items()},
        "modelDefaultEffort": {m: default_effort(m) for m in [*models, ""]},
        "defaultEffort": default_effort(default or first),
        "effortSource": src,
    }


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
    no_steer = "Grok 的 `-p` 只收启动时的一条提示，这一轮开始后没有输入口"
    name = "Grok"
    binaries = ("grok",)
    tested = VersionRange(">=1.0.40,<1.1")
    max_tier = "T1"
    icon = "grok"
    log_hint = "~/.grok/sessions/<URL 编码的目录>/<id>/updates.jsonl"
    log_dir = "~/.grok/sessions/"
    delete_hint = "grok sessions delete {id}"
    has_cost = True
    waits = "inferred"
    claims_by_open_file = True  # the pane's grok process keeps sessions/<cwd>/<id>/events.jsonl open
    asked_mode = ASKED_MODE  # what the session header compares the reported mode with
    project_skill_dir = ".agents/skills"

    images = True  # ACP image blocks in ``--prompt-json`` (measured: grok 1.0.44)
    assigns_id = "agora"  # -s <uuid> starts a new session under exactly that id
    can_fork_headless = False
    terminal_fork = ""
    Mapper = GrokStream
    # Binding: an id survives a project move (-r <id> works from anywhere; measured 2026-09-28)
    survives_move = True

    handled_types = frozenset({"user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update", "turn_completed", "subagent_spawned", "subagent_finished"})
    ignored_types = frozenset({
        "agent_thought_chunk", "hook_execution", "plan", "task_backgrounded", "task_completed", "background_tasks", "session_recap",
        "retry_state", "auto_compact_started", "auto_compact_completed", "compaction_checkpoint", "memory_dream_queued",
        "memory_dream_started", "memory_dream_completed", "memory_observation", "memory_updated", "memory_flush_started",
        "memory_flush_completed", "memory_session_saved", "image_compressed",
        "current_mode_update", "available_commands_update", "usage",
    })
    gap_types = frozenset()
    known_types = handled_types | ignored_types

    def version_in_record(self, rec: dict[str, Any]) -> str | None:
        return None

    # ——— Locator ———
    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not valid_id(native_id):  # also refuses "", None, "/" and ".." (never a path or a glob)
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

    def log_cwd(self, path: Path) -> str | None:
        return session_cwd(path.parent)

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

    # ——— Headless ———
    def headless_args(self, cmd: list[str], req: Any, *, log_exists: Callable[[str], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        o = req.options
        # The prompt as JSON content blocks: as a plain argument one starting with "-" would be read as a flag.
        blocks = [*({"type": "image", "data": image_b64(p), "mimeType": "image/png"} for p in req.images), {"type": "text", "text": req.prompt}]
        args = [*cmd, "--prompt-json", json.dumps(blocks, ensure_ascii=False), "--output-format", "streaming-json", "--always-approve"]
        if o.session:
            has = log_exists(o.session) if callable(log_exists) else bool(log_exists)
            args += ["-r" if has else "-s", o.session]
        if o.model:
            args += ["-m", o.model]
        if o.effort:
            args += ["--effort", o.effort]
        return args

    def headless_stdin(self, req: Any) -> bytes | None:
        return None  # the prompt is an argument

    # ——— Interactive ———
    def interactive_argv(self, native_id: str | None, model: str | None, effort: str | None, *, new: bool = False, has_log: Callable[[], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        args = ["grok"]
        if native_id:
            has = has_log() if callable(has_log) else bool(has_log)
            args += ["-s" if new or not has else "-r", native_id]
        if model:
            args += ["-m", model]
        if effort:
            args += ["--effort", effort]
        return [*args, "--always-approve"]

    def fork_argv(self, fork: dict[str, Any]) -> list[str]:
        return ["grok", "-r", fork["from"], "--fork-session"]

    # ——— Binding ———
    def native_from_open_files(self, paths: list[str], home: Path | None = None) -> str | None:
        for p in paths:
            m = re.search(r"/sessions/[^/]+/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/events\.jsonl$", p)
            if m and valid_id(m.group(1)):
                return m.group(1)
        return None

    # ——— Catalog ———
    def catalog(self, env: dict[str, str], root: Path | None) -> dict[str, Any]:
        home = grok_home(Path(env["HOME"]) if env.get("HOME") else None)
        try:
            config = tomllib.loads((home / "config.toml").read_text())
        except (OSError, tomllib.TOMLDecodeError):
            config = {}
        try:
            cache = json.loads((home / "models_cache.json").read_text())
        except (OSError, ValueError):
            cache = None
        return grok_catalog_from(cache if isinstance(cache, dict) else None, config)

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
