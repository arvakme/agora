"""Pi (T1). Moved from agents.py / transcript.py without behaviour change.

- Headless: ``pi -p --mode json --session-id <uuid> "<prompt>"``.
- Log: ``~/.pi/agent/sessions/--<cwd without the leading "/", "/" "\\" ":" → "-">--/<time>_<id>.jsonl``.
  ``--session-id <id>`` only looks in the current directory's folder and silently starts a new,
  empty session with that id when it is not there — so the id does not survive a project move:
  Agora moves the log (``migrate_log``).
- No native sub-agents: the user's Pi dispatches workers through Seedmux.
"""

from __future__ import annotations

import glob
import json
import os
from pathlib import Path
from typing import Any, Callable

from server.canvas import agent_models
from server.canvas.adapters.base import first_cwd, valid_id, Adapter, tool_facts, VersionRange
from server.canvas.adapters.shell_files import shell_tool
from server.canvas.adapters.tools import activity_of, spawn_in_output
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
    add_usage,
    rel_path,
    text_of,
    user_item,
)
from server.canvas.runner import Usage, _int, _num, empty_usage


def pi_usage(u: dict[str, Any] | None, model: str | None) -> Usage:
    out = empty_usage(model)
    if isinstance(u, dict):
        out["inputTokens"] = _int(u.get("input"))
        out["outputTokens"] = _int(u.get("output"))
        out["cacheReadTokens"] = _int(u.get("cacheRead"))
        out["cacheWriteTokens"] = _int(u.get("cacheWrite"))
        cost = u.get("cost")
        out["costUsd"] = _num(cost.get("total")) if isinstance(cost, dict) else None
    return out


class PiStream(StreamMapper):
    """``pi -p --mode json`` (docs/json.md in the Pi package)."""

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        t = d.get("type")
        if t == "session":
            self.session = str(d.get("id") or self.session or "") or None
        elif t == "message_end":
            m = d.get("message") or {}
            if m.get("role") != "assistant":
                return out
            model = f"{m['provider']}/{m['model']}" if m.get("provider") and m.get("model") else self.model
            self.model = model
            text = ""
            for c in m.get("content") or []:
                if c.get("type") == "text" and str(c.get("text", "")).strip():
                    text += str(c["text"])
                    out.append({"t": "text", "at": at, "text": str(c["text"])})
                elif c.get("type") == "toolCall":
                    out.append({"t": "tool_use", "at": at, "id": str(c.get("id")), "name": str(c.get("name")), "input": c.get("arguments")})
            if text:
                self.text = text
            if isinstance(m.get("usage"), dict):
                u = pi_usage(m["usage"], model)
                self.usage = add_usage(self.usage, u)
                out.append({"t": "usage", "at": at, "usage": u})
            if m.get("stopReason") in ("error", "aborted"):
                self.error = f"pi: {m.get('stopReason')} {str(m.get('errorMessage') or '')[:300]}".strip()
            elif m.get("stopReason") == "stop":
                self.error = None  # a retried turn that ends well clears an earlier failure
        elif t == "tool_execution_end":
            res = d.get("result") or {}
            out.append({"t": "tool_result", "at": at, "id": str(d.get("toolCallId")), "text": text_of(res.get("content")), "isError": bool(d.get("isError"))})
        elif t == "agent_settled":
            self.done = True
        elif t == "auto_retry_end" and d.get("success") is False:
            self.error = f"pi: {d.get('finalError') or 'retries exhausted'}"
        return out


# ——— files a tool call writes: edit / write (``path``) ———
WRITES = {"edit": "edit", "write": "write", "multi_edit": "edit", "multiedit": "edit"}


def files(name: str, args: Any, root: str | None) -> list[dict[str, str]]:
    op = WRITES.get(name.lower())
    if not op or not isinstance(args, dict):
        return []
    path = args.get("path") or args.get("file_path")
    return [{"path": rel_path(str(path), root), "op": op}] if isinstance(path, str) and path else []


def classify(name: str, args: Any, root: str | None) -> dict[str, Any]:
    """Pi's tool vocabulary (read / bash / edit / write / grep / find / ls …) → tool facts."""
    a = args if isinstance(args, dict) else {}
    n = name.lower()
    fs = files(name, args, root)
    act = activity_of(name)
    reads: list[str] = []
    on: list[str] = []
    if n == "read":
        p = a.get("path") or a.get("file_path")
        reads = [rel_path(p, root)] if isinstance(p, str) and p else []
    elif n == "bash":
        got, reads, shell_fs, on = shell_tool(a.get("command"), root, root)
        act, fs = got or act, shell_fs or fs
    return tool_facts(act, files=fs, reads=reads, waits_user=act == "questions", on=on)


def project(rec: dict[str, Any], st: State) -> Out:
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
            if isinstance(b.get("arguments"), dict) and isinstance(b["arguments"].get("command"), str) and "smx-team" in b["arguments"]["command"]:
                st.extra.setdefault("cmd", {})[tid] = b["arguments"]["command"]
            facts = classify(name, b.get("arguments"), st.root)
            if facts.get("files"):
                tool["files"] = facts["files"]
            tool.update({k: v for k, v in facts.items() if k != "files"})
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
        out = text_of(m.get("content"))
        done: dict[str, Any] = {"name": str(m.get("toolName") or ""), "output": _full(out), "isError": bool(m.get("isError"))}
        sp = spawn_in_output(out, st.extra.get("cmd", {}).pop(tid, None))
        if sp:
            done["spawn"] = sp
        items.append({"id": tid, "kind": "tool", "at": at, "endAt": at, "tool": done})
    return items, turns


def dir_name(root: Path | str) -> str:
    s = str(root)
    s = s[1:] if s[:1] in ("/", "\\") else s
    return "--" + "".join("-" if c in "/\\:" else c for c in s) + "--"


def sessions_dir(home: Path) -> Path:
    return Path(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or home / ".pi" / "agent" / "sessions")


def migrate_log(src: Path, new_root: Path | str) -> Path:
    """Move a Pi session log to the folder of the project's new root and point its header at it.

    Pi's ``--session-id`` only looks in the current directory's folder, and its print mode refuses
    a log whose recorded ``cwd`` no longer exists; moving the file and rewriting the first line's
    ``cwd`` is what makes it resumable again (measured 2026-09-28, experiment A3). The new file is
    written next to its destination and swapped in atomically; the old one is kept as
    ``<name>.agora-moved.bak`` (Pi's lookup ignores that name). Refuses to overwrite an existing
    log at the destination. Any failure leaves the original in place."""
    raw = src.read_bytes()
    first, sep, rest = raw.partition(b"\n")
    head = json.loads(first)
    if not isinstance(head, dict) or head.get("type") != "session":
        raise ValueError(f"{src} does not start with a Pi session header")
    head["cwd"] = str(new_root)
    dst_dir = src.parent.parent / dir_name(new_root)
    dst = dst_dir / src.name
    if dst.exists():
        raise ValueError(f"{dst} already exists")
    dst_dir.mkdir(parents=True, exist_ok=True)
    tmp = dst_dir / f".{src.name}.agora.tmp"
    try:
        with open(tmp, "wb") as fh:
            fh.write(json.dumps(head, ensure_ascii=False, separators=(",", ":")).encode() + sep + rest)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, dst)
        os.replace(src, src.with_name(src.name + ".agora-moved.bak"))
    except BaseException:
        tmp.unlink(missing_ok=True)
        if dst.exists() and src.exists():
            dst.unlink()  # roll back: the original is still where it was
        raise
    return dst


class PiAdapter(Adapter):
    kind = "pi"
    name = "Pi"
    binaries = ("pi",)
    tested = VersionRange(">=0.80,<0.88")
    max_tier = "T1"
    seedmux_names = ("pi",)
    icon = "pi"
    log_hint = "~/.pi/agent/sessions/--<目录>--/<时间>_<id>.jsonl"
    log_dir = "~/.pi/agent/sessions/"
    has_cost = True
    waits = "inferred"

    assigns_id = "agora"
    can_fork_headless = True
    terminal_fork = "pi --fork"
    catalog_per_project = True  # the model scope can come from the project's .pi/settings.json
    Mapper = PiStream
    # Binding: the id is looked up in the cwd's folder only — a moved project needs its logs moved.
    survives_move = False

    # ——— Locator ———
    def log_dir_name(self, root: Path | str) -> str:
        return dir_name(root)

    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not valid_id(native_id):  # also refuses "", None, "/" and ".." (never a path or a glob)
            return LogLookup("missing")
        home = home or Path.home()
        hits = sorted(Path(p) for p in glob.glob(str(sessions_dir(home) / "*" / f"*_{glob.escape(native_id)}.jsonl")))
        if root is None:  # no project to prefer: only an unambiguous copy counts
            return LogLookup("found", hits[0], tuple(hits)) if len(hits) == 1 else LogLookup("ambiguous" if hits else "missing", None, tuple(hits))
        mine = [p for p in hits if p.parent.name == dir_name(root)]
        if len(mine) == 1:
            return LogLookup("found", mine[0], tuple(hits))
        if mine:
            return LogLookup("ambiguous", None, tuple(hits))
        return LogLookup("elsewhere" if hits else "missing", None, tuple(hits))

    def new_since(self, root: Path | str, since: float, taken: set[str], home: Path | None = None) -> str | None:
        home = home or Path.home()
        found = []
        for p in glob.glob(str(sessions_dir(home) / dir_name(root) / "*.jsonl")):
            try:
                if os.path.getctime(p) < since - 2:
                    continue
            except OSError:
                continue
            nid = Path(p).stem.rsplit("_", 1)[-1]
            if nid not in taken:
                found.append((os.path.getctime(p), nid))
        return sorted(found)[0][1] if found else None

    def sessions_for(self, roots: list[str], home: Path | None = None) -> list[dict[str, Any]]:
        home = home or Path.home()
        out = []
        for root in roots:
            for p in glob.glob(str(sessions_dir(home) / dir_name(root) / "*.jsonl")):
                out.append({"agent": "pi", "nativeId": Path(p).stem.rsplit("_", 1)[-1], "path": Path(p), "cwd": root})
        return out

    def is_header(self, rec: dict[str, Any]) -> bool:
        return rec.get("type") == "session"

    def log_format(self, path: Path) -> str | None:
        try:
            with open(path, "rb") as fh:
                head = json.loads(fh.readline() or b"{}")
        except (OSError, ValueError):
            return None
        return str(head.get("version")) if isinstance(head, dict) and head.get("type") == "session" and head.get("version") is not None else None

    def log_cwd(self, path: Path) -> str | None:
        return first_cwd(path)

    # ——— Projector ———
    handled_types = frozenset({"message", "model_change", "thinking_level_change"})
    ignored_types = frozenset({"session", "custom", "custom_message", "compaction", "context_edit", "session_info", "label", "branch_summary"})
    gap_types = frozenset()
    known_types = handled_types | ignored_types

    def project(self, rec: dict[str, Any], st: State) -> Out:
        return project(rec, st)

    def record_type(self, rec: dict[str, Any]) -> str | None:
        t = rec.get("type")
        return str(t) if t else None

    # ——— ToolVocab ———
    def classify(self, name: str, args: Any, root: str | None = None) -> dict[str, Any]:
        return classify(name, args, root)

    # ——— Headless ———
    def headless_args(self, cmd: list[str], req: Any, *, log_exists: Callable[[str], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        o = req.options
        args = [*cmd, "-p", "--mode", "json"]
        if o.fork_from:
            args += ["--fork", o.fork_path or o.fork_from]
        elif o.session:
            args += ["--session-id", o.session]
        if o.model:
            args += ["--model", o.model]
        if o.effort:
            args += ["--thinking", o.effort]
        if skill_dir is not None and skill_dir.is_dir():
            args += ["--skill", str(skill_dir)]
        return [*args, "--", req.prompt]

    def headless_stdin(self, req: Any) -> bytes | None:
        return None  # the prompt is the last argument

    # ——— Interactive ———
    def fork_argv(self, fork: dict[str, Any]) -> list[str]:
        return ["pi", "--fork", fork.get("path") or fork["from"]]

    def interactive_argv(self, native_id: str | None, model: str | None, effort: str | None, *, new: bool = False, has_log: Callable[[], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        args = ["pi"]
        if native_id:
            args += ["--session-id", native_id]
        if model:
            # --models pins Ctrl+P cycling to the session's model.
            args += ["--model", model, "--models", model]
        if effort:
            args += ["--thinking", effort]
        if skill_dir is not None and skill_dir.is_dir():
            args += ["--skill", str(skill_dir)]
        return args

    project_skill_dir = None  # Pi gets `--skill <dir>` on every launch instead of a project skills folder

    # ——— Binding ———
    def migrate(self, src: Path, new_root: Path | str) -> Path:
        # Through the public entry point (agents.migrate_pi_log) so there is one path to it.
        from server.canvas import agents

        return agents.migrate_pi_log(src, new_root)

    # ——— Catalog ———
    def catalog(self, env: dict[str, str], root: Path | None) -> dict[str, Any]:
        return agent_models.SOURCES["pi"](env, root)
