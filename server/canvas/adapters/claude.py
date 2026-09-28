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
from server.canvas.adapters.base import valid_id, Adapter, tool_facts, NativeRef, ParentLink, VersionRange
from server.canvas.adapters.tools import activity_of, shell_reads, spawn_in_output
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


READ_KEYS = ("file_path", "notebook_path", "path")


def classify(name: str, args: Any, root: str | None, cwd: str | None = None) -> dict[str, Any]:
    """Claude Code's tool vocabulary → tool facts (activity, reads, waitsUser, spawn, files)."""
    a = args if isinstance(args, dict) else {}
    fs = files(name, args, root)
    act = activity_of(name)
    reads: list[str] = []
    waits = False
    spawn = None
    if name in ("Read", "NotebookRead"):
        p = next((a[k] for k in READ_KEYS if isinstance(a.get(k), str) and a.get(k)), None)
        reads = [rel_path(p, root)] if p else []
    elif name == "Grep" and isinstance(a.get("path"), str) and "." in a["path"].rsplit("/", 1)[-1]:
        reads = [rel_path(a["path"], root)]
    elif name == "Bash":
        got, reads = shell_reads(a.get("command"), root, cwd or root)
        act = got or act
    elif name in ("Agent", "Task"):
        spawn = {"childKind": "claude", "via": "native", **({"role": str(a["subagent_type"])} if a.get("subagent_type") else {})}
    elif name in ("AskUserQuestion", "ExitPlanMode"):
        act, waits = "questions", True
    return tool_facts(act, files=fs, reads=reads, waits_user=waits, spawn=spawn)


def result_spawn(rec: dict[str, Any], output: str, command: str | None) -> dict[str, Any] | None:
    """The child a finished tool call started: an ``Agent`` result's ``agentId``, or a Seedmux ticket in a Bash output."""
    r = rec.get("toolUseResult")
    if isinstance(r, dict) and isinstance(r.get("agentId"), str) and r.get("agentId"):
        return {"childKind": "claude", "childId": r["agentId"], "via": "native", **({"state": str(r["status"])} if r.get("status") else {})}
    return spawn_in_output(output, command)


def _facts_only(facts: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in facts.items() if k != "files"}


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
                done: dict[str, Any] = {"output": _full(str(out)), "isError": bool(b.get("is_error"))}
                cmd = st.extra.get("cmd", {}).pop(tid, None)
                sp = result_spawn(rec, str(out), cmd) if len(results) == 1 else spawn_in_output(str(out), cmd)
                if sp:
                    done["spawn"] = sp
                items.append({"id": tid, "kind": "tool", "at": at, "endAt": at, "tool": done})
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
                if name == "Bash" and isinstance(b.get("input"), dict) and isinstance(b["input"].get("command"), str) and "smx-team" in b["input"]["command"]:
                    st.extra.setdefault("cmd", {})[tid] = b["input"]["command"]  # its output may name a Seedmux ticket
                facts = classify(name, b.get("input"), st.root, rec.get("cwd") if isinstance(rec.get("cwd"), str) else None)
                if facts.get("files"):
                    tool["files"] = facts["files"]
                tool.update(_facts_only(facts))
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


def project_child(rec: dict[str, Any], st: State) -> Out:
    """A sub-agent's own log (``subagents/agent-<id>.jsonl``): every record is a sidechain there."""
    if rec.get("isSidechain"):
        rec = {**rec, "isSidechain": False}
    return project(rec, st)


NOTIFY = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)


def _tag(body: str, name: str) -> str | None:
    m = re.search(rf"<{name}>(.*?)</{name}>", body, re.S)
    return m.group(1).strip() if m else None


def spawn_outcomes(parent_log: Path) -> dict[str, dict[str, Any]]:
    """What the parent log says about each ``Agent`` call, keyed by tool_use id: when it was made,
    the agent id and state its result reported (``async_launched`` / ``completed``…), and — for
    background agents — the completion notification (``<task-notification>`` with ``<status>``)."""
    out: dict[str, dict[str, Any]] = {}
    for rec in read_jsonl(parent_log):
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
        at = _ms(rec.get("timestamp"))
        content = msg.get("content")
        if rec.get("type") == "assistant" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in ("Agent", "Task"):
                    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                    out.setdefault(str(b.get("id")), {}).update({"at": at, "description": inp.get("description"), "role": inp.get("subagent_type")})
        elif rec.get("type") == "user":
            r = rec.get("toolUseResult")
            if isinstance(r, dict) and r.get("agentId") and isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        o = out.setdefault(str(b.get("tool_use_id")), {})
                        o.update({"agentId": r["agentId"], "status": r.get("status"), "resultAt": at})
                        if r.get("status") == "completed":
                            o.update({"doneAt": at, "state": "done"})
        # Background agents report completion as a <task-notification> (a queue-operation record, later a user turn).
        if rec.get("type") in ("user", "queue-operation"):
            text = rec["content"] if isinstance(rec.get("content"), str) else (text_of(content) if content is not None else "")
            for m in NOTIFY.finditer(text or ""):
                tuid = _tag(m.group(1), "tool-use-id")
                if tuid:
                    status = (_tag(m.group(1), "status") or "").lower()
                    o = out.setdefault(tuid, {})
                    if "doneAt" not in o:  # the first notice; the same one comes back as a user turn
                        o.update({"doneAt": at, "state": {"completed": "done", "failed": "failed", "killed": "failed", "stopped": "failed"}.get(status, status or "done")})
    return out


def dir_name(root: Path | str) -> str:
    return "".join(c if c.isalnum() and c.isascii() else "-" for c in str(root))


def projects_dir(home: Path) -> Path:
    return home / ".claude" / "projects"


class ClaudeAdapter(Adapter):
    kind = "claude"
    name = "Claude Code"
    binaries = ("claude",)
    tested = VersionRange(">=2.1.267,<2.2")
    max_tier = "T1"
    seedmux_names = ("claude",)
    icon = "claude"
    log_hint = "~/.claude/projects/<目录>/<id>.jsonl"
    log_dir = "~/.claude/projects/"
    has_cost = True  # headless turns only (the result line)
    waits = "native"
    prunes_logs_after_days = 30

    # Headless
    assigns_id = "agora"
    can_fork_headless = True
    terminal_fork = "claude --fork-session"
    Mapper = ClaudeStream
    # Binding
    survives_move = True

    # ——— Locator ———
    def log_dir_name(self, root: Path | str) -> str:
        return dir_name(root)

    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not valid_id(native_id):  # also refuses "", None, "/" and ".." (never a path or a glob)
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
    # Record types (``record_type``) the projector turns into items, and those it skips on purpose
    # (Claude Code's own bookkeeping). Anything else counts as drift (drift.py). Seen in 2.1.267–2.1.283.
    handled_types = frozenset({"user", "assistant", "system/turn_duration"})
    ignored_types = frozenset({
        "attachment", "atis-latch", "last-prompt", "ai-title", "mode", "permission-mode", "queue-operation",
        "file-history-snapshot", "file-history-delta", "system/stop_hook_summary", "bridge-session", "pr-link",
        "custom-title", "system/away_summary", "agent-name", "cost-state", "frame-link", "system/informational",
        "system/api_error", "relocated", "system/local_command", "artifact-autoreact-ledger", "artifact-comment-monitor",
        "system/bridge_status", "system/compact_boundary", "continued-in", "system/model_refusal_fallback", "summary",
    })
    gap_types = frozenset()
    known_types = handled_types | ignored_types

    def project(self, rec: dict[str, Any], st: State) -> Out:
        return project(rec, st)

    def record_type(self, rec: dict[str, Any]) -> str | None:
        t = rec.get("type")
        return f"{t}/{rec['subtype']}" if t == "system" and rec.get("subtype") else (str(t) if t else None)

    def files(self, name: str, inp: Any, root: str | None) -> list[dict[str, str]]:
        return files(name, inp, root)

    # ——— ToolVocab ———
    def classify(self, name: str, args: Any, root: str | None = None) -> dict[str, Any]:
        return classify(name, args, root)

    # ——— Subagents ———
    def children(self, ref: NativeRef, home: Path | None = None) -> list[NativeRef]:
        """Native sub-agents: ``<parent log dir>/<parent id>/subagents/agent-<aid>.jsonl`` + ``.meta.json``.
        The link is the CLI's own: the parent's ``Agent`` tool_use id is the child's ``meta.toolUseId``,
        and the parent's result reports ``agentId`` = the file name. Nested agents (``spawnDepth`` > 1)
        name their parent in ``meta.parentAgentId``."""
        if ref.path is None:
            return []
        sub = ref.path.parent / ref.path.stem / "subagents"
        if not sub.is_dir():
            return []
        outcomes = spawn_outcomes(ref.path)
        by_agent = {o.get("agentId"): (tuid, o) for tuid, o in outcomes.items() if o.get("agentId")}
        out = []
        for log in sorted(sub.glob("agent-*.jsonl")):
            aid = log.stem.removeprefix("agent-")
            try:
                meta = json.loads(log.with_name(log.stem + ".meta.json").read_text())
            except (OSError, ValueError):
                meta = {}
            tuid = meta.get("toolUseId") or by_agent.get(aid, (None, {}))[0]
            o = outcomes.get(tuid or "", {})
            parent_aid = meta.get("parentAgentId")
            parent_run = f"claude:{ref.native_id}/{parent_aid}" if parent_aid else ref.run_id
            ev = f"父日志的 Agent 调用 {tuid} = 子会话 meta.toolUseId" if meta.get("toolUseId") else (f"父日志的 Agent 结果 agentId = {aid}" if tuid else "子会话在父会话的 subagents/ 目录下")
            out.append(NativeRef(
                "claude",
                f"{ref.native_id}/{aid}",
                log,
                ref.cwd,
                ParentLink("native", parent_run, tool_call_id=tuid, evidence=ev),
                label=str(meta.get("description") or o.get("description") or aid),
                meta={"agentId": aid, "role": meta.get("agentType") or o.get("role"), "depth": meta.get("spawnDepth") or 1, "model": meta.get("model"), "background": meta.get("requestShape") == "background", "dispatchedAt": o.get("at"), "doneAt": o.get("doneAt"), "state": o.get("state") or ("dispatched" if o.get("status") == "async_launched" else None)},
            ))
        return out

    def project_child(self, rec: dict[str, Any], st: State) -> Out:
        return project_child(rec, st)

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
