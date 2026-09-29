"""Cursor (``cursor-agent``) — T1 (was T2, observed only; the user decided on 2026-09-29 to make it a session agent).

- Headless: ``cursor-agent -p --output-format stream-json --force --trust [--resume <chat id>] [--model <id>]``,
  the prompt on stdin; NDJSON on stdout (``system/init`` with the chat id, ``assistant``, ``tool_call`` started /
  completed, ``result``), one turn per process. The chat id is Cursor's own (``assigns_id = "cli"``: taken from
  the init event). No permission asking in print mode — a shell call is ``rejected`` without ``--force`` — so
  ``--force`` (Run Everything; the user's 「默认不加边界」), and the session header says so. There is no separate
  effort: it is part of the model id. SIGINT / SIGTERM end the process at once (130 / 143) and leave no
  ``turn_ended`` in the transcript (measured, tests/fixtures: spike.md).
- Interactive: ``cursor-agent [--resume <id>] --force --trust [--model]`` in Agora's tmux; the process keeps
  ``~/.cursor/chats/<hash>/<chat id>/store.db`` open (``native_from_open_files``; the file is never read).
- Catalog: ``cursor-agent --list-models`` (``<id> - <name>``, no effort levels).
- Environment: through an HTTP(S) proxy the CLI's stream reconnects and answers off-topic (measured); the
  proxy variables are the person's to set for it.


- Log: ``$CURSOR_DATA_DIR`` (``~/.cursor``) ``/projects/<slug>/agent-transcripts/<chat id>/<chat id>.jsonl``,
  slug = the workspace path with every run of non-alphanumerics turned into one ``-`` (the CLI's own
  ``workspace-paths.js``); Task sub-agents in ``<chat id>/subagents/<child id>.jsonl``. A chat id
  belongs to its workspace (resumed elsewhere, the CLI silently starts an empty chat there), so a
  lookup by id prefers the workspace's own copy. ``~/.cursor/chats/*/store.db`` (encrypted blobs)
  is never read (user decision).
- Records: ``{role: user|assistant, message: {content: [text | tool_use{name, input}]}}`` and
  ``{type: turn_ended, status: success|error|aborted, error?}``. No tool ids, no tool results, no
  record times — only a user message starts with ``<timestamp>Monday, Sep 28, 2026, 4:22 PM (UTC+8)</timestamp>``.
  ``read_records`` infers times (``times_inferred``, the page marks them): a turn runs from its
  timestamp (the file's birth time when that falls in the same minute) to the next turn's, the last
  one to the file's mtime, its records spread over it at most ``STEP_MS`` apart.
- Tool names follow the model (Read / Write / StrReplace / Delete / Shell / Grep / Glob / Task …;
  Codex-family models: ApplyPatch with the patch text as input, Bash, rg): a table here, then
  ``tools.activity_of``. Shell commands go through ``tools.shell_reads`` from their ``working_directory``.
"""

from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from server.canvas.adapters.base import Adapter, NativeRef, ParentLink, VersionRange, tool_facts, valid_id
from server.canvas.adapters.common import MAX_TEXT, LogLookup, Out, State, StreamMapper, _clip, _end, _full, _start, _summary, add_usage, read_jsonl, rel_path, user_item
from server.canvas.adapters.shell_files import shell_tool
from server.canvas.adapters.tools import activity_of, patch_files
from server.canvas.runner import _int, empty_usage

STEP_MS = 20_000  # inferred time between two records of a turn, at most
TICKET_PAD_S = 120  # a worker's transcript is written to after its ticket was created (minus this)
BLOCKS = frozenset({"text", "tool_use"})
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_TS = re.compile(
    r"<timestamp>\s*(?:[A-Za-z]+,\s*)?([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])"
    r"\s*(\(UTC\s*(?:([+-]\d{1,2})(?::?(\d{2}))?)?\))?\s*</timestamp>"
)
_STAMP = re.compile(r"<timestamp>.*?</timestamp>\s*", re.S)
_QUERY = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.S)
SHELLS = frozenset({"shell", "bash", "run_terminal_cmd"})
READS = frozenset({"read", "readfile"})
WRITES = {"write": "write", "strreplace": "edit", "delete": "delete", "editnotebook": "edit"}
ACTIVITY = {"editnotebook": "edit", "rg": "search", "readlints": "search", "await": "commands", "awaitshell": "commands", "setactivebranch": "commands", "updatecurrentstep": "plan", "createplan": "plan", "switchmode": "plan"}


def data_dir(home: Path | None = None) -> Path:
    env = os.environ.get("CURSOR_DATA_DIR", "").strip()
    return Path(env) if env else (home or Path.home()) / ".cursor"


def slug(path: str) -> str:
    """The folder name the CLI gives a workspace under ``projects/``."""
    return re.sub(r"[^a-zA-Z0-9]+", "-", path).strip("-")


def transcript_dirs(root: str, home: Path | None = None) -> list[Path]:
    base = data_dir(home) / "projects"
    return [base / s / "agent-transcripts" for s in dict.fromkeys(slug(r) for r in (str(root), os.path.realpath(root)))]


def user_time(text: Any) -> int | None:
    """Epoch ms of a user message's ``<timestamp>`` (minute precision); None when it has none."""
    m = _TS.search(text) if isinstance(text, str) else None
    if m is None or m.group(1).title() not in MONTHS:
        return None
    hour = int(m.group(4)) % 12 + (12 if m.group(7).upper() == "PM" else 0)
    tz = None
    if m.group(8):  # "(UTC+8)", "(UTC-5:30)", "(UTC)"
        sign = -1 if (m.group(9) or "+").startswith("-") else 1
        tz = timezone(sign * timedelta(hours=abs(int(m.group(9) or 0)), minutes=int(m.group(10) or 0)))
    try:
        dt = datetime(int(m.group(3)), MONTHS.index(m.group(1).title()) + 1, int(m.group(2)), hour, int(m.group(5)), int(m.group(6) or 0), tzinfo=tz)
    except ValueError:
        return None
    return int(dt.timestamp() * 1000)


def _blocks(rec: dict[str, Any]) -> list[Any]:
    content = (rec.get("message") or {}).get("content") if isinstance(rec.get("message"), dict) else None
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def _text(rec: dict[str, Any]) -> str:
    return "".join(str(b.get("text") or "") for b in _blocks(rec) if isinstance(b, dict) and b.get("type") == "text")


def prompt_of(rec: dict[str, Any]) -> str | None:
    """What a user record asks (its ``<user_query>``); None for a context block the CLI adds
    (``<available_subagent_types>``, ``<dynamic_tools>`` …) or an empty one: those start no turn."""
    if rec.get("role") != "user":
        return None
    body = _STAMP.sub("", _text(rec), count=1).strip()
    m = _QUERY.search(body)
    if m:
        return m.group(1).strip()
    if body.startswith("<"):
        return None
    return body or None


def classify(name: str, args: Any, root: str | None) -> dict[str, Any]:
    a = args if isinstance(args, dict) else {}
    n = (name or "").lower()
    act = ACTIVITY.get(n) or activity_of(name)
    reads: list[str] = []
    on: list[str] = []
    files: list[dict[str, str]] = []
    path = a.get("path") if isinstance(a.get("path"), str) and a.get("path") else None
    if n in READS and path:
        reads = [rel_path(path, root)]
    elif n in WRITES:
        p = path or (a.get("target_notebook") if isinstance(a.get("target_notebook"), str) else None)
        files = [{"path": rel_path(p, root), "op": WRITES[n]}] if p else []
    elif n == "applypatch":
        files = patch_files(args if isinstance(args, str) else a.get("patch") or a.get("input"), root)
    elif n in SHELLS:
        cwd = a.get("working_directory") if isinstance(a.get("working_directory"), str) and a.get("working_directory") else root
        got, reads, shell_fs, on = shell_tool(a.get("command"), root, cwd)
        act, files = got or act, shell_fs or files
    elif n in ("grep", "rg") and path and "." in path.rstrip("/").rsplit("/", 1)[-1]:
        reads = [rel_path(path, root)]
    spawn = {"childKind": "cursor", "via": "native", **({"role": str(a["subagent_type"])} if a.get("subagent_type") else {})} if n in ("task", "subagent") else None
    return tool_facts(act, files=files, reads=reads, waits_user=act == "questions", spawn=spawn, on=on)


def project(rec: dict[str, Any], st: State) -> Out:
    """One transcript record. Ids are positions (``u3``, ``t5.1``): the transcript only grows, so they
    are stable. Times come from ``read_records`` (``_at`` / ``_end``); a record read on its own gets
    its turn's timestamp."""
    items: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    x = st.extra
    n = x["n"] = x.get("n", -1) + 1
    at = rec.get("_at") or x.get("at") or int(time.time() * 1000)
    if rec.get("type") == "turn_ended":
        status = str(rec.get("status") or "")
        _end(st, turns, None if status == "success" else str(rec.get("error") or status or "error"), items, at)
        return items, turns
    if rec.get("role") == "user":
        body = prompt_of(rec)
        if body is None:
            return items, turns
        at = rec.get("_at") or user_time(_text(rec)) or at
        x["at"] = at
        # A new prompt while a turn is open: the CLI drops the ``turn_ended`` of earlier turns when a chat is resumed in
        # its terminal (measured), so the earlier turn ended when this one began.
        _end(st, turns, None, items, at - 1)  # a tick before the new prompt, so the two never share a time
        items.append(user_item(f"u{n}", body, at))
        _start(st, turns, f"u{n}", at)
    elif rec.get("role") == "assistant":
        blocks = _blocks(rec)
        uses = [k for k, b in enumerate(blocks) if isinstance(b, dict) and b.get("type") == "tool_use"]
        span = max((rec.get("_end") or at) - at, 0) / max(len(uses), 1)  # several calls in one record: one after another
        for k, b in enumerate(blocks):
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and str(b.get("text") or "").strip():
                st.last_text = str(b["text"])
                items.append({"id": f"a{n}.{k}", "kind": "assistant", "text": _clip(st.last_text, MAX_TEXT), "at": at})
            elif b.get("type") == "tool_use":
                name, inp = str(b.get("name") or "tool"), b.get("input")
                i = uses.index(k)
                items.append({"id": f"t{n}.{k}", "kind": "tool", "at": int(at + i * span), "endAt": int(at + (i + 1) * span), "durationInferred": True, "tool": {"name": name, "input": _summary(inp), "args": _full(inp), **classify(name, inp, st.root)}})
    return items, turns


def infer_times(recs: list[dict[str, Any]], born: int | None, mtime: int) -> list[dict[str, Any]]:
    """``_at`` / ``_end`` for every record (see the module docstring)."""
    prompts = [i for i, r in enumerate(recs) if prompt_of(r) is not None]
    times: list[int] = []
    for k, i in enumerate(prompts):
        t = user_time(_text(recs[i]))
        if k == 0 and born is not None and (t is None or t <= born < t + 60_000):
            t = born  # the transcript was created by the first prompt: seconds, not minutes
        t = t if t is not None else (times[-1] if times else (born or mtime))
        times.append(max(t, times[-1]) if times else t)
    if not prompts:
        times = [born or mtime]
    starts = [0, *prompts[1:]]  # records before the first prompt belong to the first turn
    out = []
    for k, i in enumerate(starts):
        stop = starts[k + 1] if k + 1 < len(starts) else len(recs)
        t0 = times[k]
        t1 = times[k + 1] if k + 1 < len(times) else max(mtime, t0)
        step = min((t1 - t0) / max(stop - i, 1), STEP_MS)
        for j in range(i, stop):
            at = int(t0 + (j - i) * step)
            out.append({**recs[j], "_at": at, "_end": min(int(at + step), t1) if t1 > at else at})
    return out


# ——— headless stream (``cursor-agent -p --output-format stream-json``) ———
TOOL_NAMES = {"readToolCall": "Read", "shellToolCall": "Shell", "editToolCall": "Edit", "writeToolCall": "Write", "deleteToolCall": "Delete", "globToolCall": "Glob", "grepToolCall": "Grep", "lsToolCall": "LS", "taskToolCall": "Task"}
RUN_EVERYTHING = "run-everything"  # what ``--force`` is called in the CLI; the init event reports "default" whatever the flags


def _tool_name(key: str) -> str:
    base = key[: -len("ToolCall")] if key.endswith("ToolCall") and len(key) > len("ToolCall") else key
    return TOOL_NAMES.get(key) or base[:1].upper() + base[1:]


def _tool_text(result: Any) -> tuple[str, bool]:
    """(text, is_error) of one completed tool call's ``result``: ``success`` / ``rejected`` / ``error`` / ``failure``."""
    if not isinstance(result, dict):
        return "", False
    ok = result.get("success")
    if isinstance(ok, dict):
        for k in ("content", "stdout", "output", "text"):
            if isinstance(ok.get(k), str) and ok[k]:
                return ok[k], False
        return _full(ok), False
    rej = result.get("rejected")
    if isinstance(rej, dict):
        return f"rejected: {rej.get('reason') or 'the CLI did not run it (no --force?)'}", True
    for k in ("error", "failure"):
        if result.get(k) is not None:
            v = result[k]
            return str(v.get("message") or v.get("error") or _full(v)) if isinstance(v, dict) else str(v), True
    return _full(result), False


class CursorStream(StreamMapper):
    """``cursor-agent -p --output-format stream-json``: init (the chat id), assistant messages, tool calls
    started / completed, and ``result`` (the turn's end and usage). Thinking deltas and the reconnect
    notices (``connection`` / ``retry``) are not shown."""

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        t, sub = d.get("type"), d.get("subtype")
        if t == "system" and sub == "init":
            self.session = str(d.get("session_id") or self.session or "") or None
            if self.session:
                out.append({"t": "session", "at": at, "session": self.session})
            out.append({"t": "mode", "at": at, "mode": RUN_EVERYTHING, "model": str(d.get("model") or self.model or "") or None})
        elif t == "assistant":
            msg = d.get("message") if isinstance(d.get("message"), dict) else {}
            text = "".join(str(c.get("text") or "") for c in msg.get("content") or [] if isinstance(c, dict) and c.get("type") == "text")
            if text.strip():
                self.text = text
                out.append({"t": "text", "at": at, "text": text})
        elif t == "tool_call":
            tc = d.get("tool_call") if isinstance(d.get("tool_call"), dict) else {}
            key = next(iter(tc), "")
            body = tc.get(key) if isinstance(tc.get(key), dict) else {}
            cid = str(d.get("call_id") or body.get("toolCallId") or key)
            if sub == "started":
                args = body.get("args") if isinstance(body.get("args"), dict) else {}
                out.append({"t": "tool_use", "at": at, "id": cid, "name": _tool_name(key), "input": {k: v for k, v in args.items() if k in ("command", "path", "globPattern", "pattern", "targetDirectory", "workingDirectory", "prompt", "description")} or args})
            elif sub == "completed":
                text, bad = _tool_text(body.get("result"))
                out.append({"t": "tool_result", "at": at, "id": cid, "text": text, "isError": bad})
        elif t == "result":
            u = d.get("usage") if isinstance(d.get("usage"), dict) else {}
            usage = empty_usage(self.model)
            usage["inputTokens"] = _int(u.get("inputTokens"))
            usage["outputTokens"] = _int(u.get("outputTokens"))
            usage["cacheReadTokens"] = _int(u.get("cacheReadTokens"))
            usage["cacheWriteTokens"] = _int(u.get("cacheWriteTokens"))
            self.usage = add_usage(self.usage, usage)
            out.append({"t": "usage", "at": at, "usage": usage})
            if d.get("is_error") or (sub not in (None, "success")):
                self.error = f"cursor: {str(d.get('result') or sub or 'error')[:300]}"
            self.done = True
        elif t == "error":
            self.error = f"cursor: {str(d.get('message') or d.get('error') or 'error')[:300]}"
        return out


def list_models(text: str) -> tuple[list[str], dict[str, str], str]:
    """``cursor-agent --list-models``: ``<id> - <name>`` lines (a ``(default)`` / ``(current)`` tag after the name).
    Returns (ids, names, default id)."""
    ids: list[str] = []
    names: dict[str, str] = {}
    default = ""
    for line in text.splitlines():
        m = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._\-\[\]=,]*)\s+-\s+(.+?)\s*$", line)
        if not m:
            continue
        mid, label = m.group(1), m.group(2).replace("\u200b", "").strip()
        tag = re.search(r"\(((?:default|current)(?:\s*,\s*(?:default|current))*)\)\s*$", label)  # "(default)", "(current)", "(current, default)"
        if tag:
            label = label[: tag.start()].strip()
            if "default" in tag.group(1) and not default:
                default = mid
        ids.append(mid)
        names[mid] = label
    return ids, names, default


def cursor_catalog(ids: list[str], names: dict[str, str], default: str, source: str) -> dict[str, Any]:
    """Models only: the effort (``-high``, ``-xhigh`` …) is part of a Cursor model id, so there are no levels to pick."""
    first = default if default in ids else (ids[0] if ids else "")
    return {
        "default": first,
        "models": ids,
        "featured": ids[:6],
        "names": names,
        "providers": {},
        "allowed": ids if ids else None,
        "scope": {"kind": "cli", "source": source},
        "efforts": [],
        "modelEfforts": {m: [] for m in [*ids, ""]},
        "modelDefaultEffort": {m: "" for m in [*ids, ""]},
        "defaultEffort": "",
        "effortSource": "none",
    }


class CursorAdapter(Adapter):
    kind = "cursor"
    name = "Cursor"
    binaries = ("cursor-agent",)
    tested = VersionRange(">=2026.09.26,<2026.11")
    max_tier = "T1"
    icon = "cursor"
    log_hint = "~/.cursor/projects/<工作区>/agent-transcripts/<id>/<id>.jsonl"
    log_dir = "~/.cursor/projects/"
    delete_hint = ""
    has_cost = False
    waits = "inferred"
    times_inferred = True
    assigns_id = "cli"  # the chat id is Cursor's own (init event / a new transcript folder)
    can_fork_headless = False
    survives_move = False  # a chat id belongs to its workspace: resumed elsewhere, the CLI starts an empty chat
    asked_mode = RUN_EVERYTHING  # ``--force``: what the session header compares the CLI's reported mode with
    project_skill_dir = ".cursor/skills"  # it also reads .claude/skills and .agents/skills
    claims_by_open_file = True

    handled_types = frozenset({"user", "assistant", "turn_ended"})
    ignored_types = frozenset()
    gap_types = frozenset()
    known_types = handled_types | ignored_types

    # ——— Locator ———
    def locate(self, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
        if not valid_id(native_id):  # also refuses "", None, "/" and ".." (never a path or a glob)
            return LogLookup("missing")
        nid = glob.escape(native_id)
        hits = sorted(Path(p) for p in glob.glob(str(data_dir(home) / "projects" / "*" / "agent-transcripts" / nid / f"{nid}.jsonl")))
        if len(hits) == 1:
            return LogLookup("found", hits[0], tuple(hits))
        if root is not None:
            mine = [p for p in hits if p.parents[1] in transcript_dirs(str(root), home)]
            if len(mine) == 1:
                return LogLookup("found", mine[0], tuple(hits))
        return LogLookup("ambiguous" if hits else "missing", None, tuple(hits))

    def sessions_for(self, roots: list[str], home: Path | None = None) -> list[dict[str, Any]]:
        out = []
        for root in roots:
            for d in transcript_dirs(root, home):
                for p in sorted(d.glob("*/*.jsonl")):
                    if p.stem == p.parent.name:
                        out.append({"agent": "cursor", "nativeId": p.stem, "path": p, "cwd": root})
        return out

    def log_cwd(self, path: Path) -> str | None:
        """The workspace the CLI recorded when it was trusted (``.workspace-trusted``); the folder name
        alone cannot be turned back into a path."""
        try:
            ws = json.loads((path.parents[2] / ".workspace-trusted").read_text()).get("workspacePath")
        except (OSError, ValueError, AttributeError, IndexError):
            return None
        return ws if isinstance(ws, str) and slug(ws) == path.parents[2].name else None

    def sample_pattern(self, home: Path) -> str:
        return str(data_dir(home) / "projects" / "*" / "agent-transcripts" / "*" / "*.jsonl")

    def read_records(self, path: Path, limit: int | None = None) -> list[dict[str, Any]]:
        recs = read_jsonl(path, limit)
        try:
            st = path.stat()
        except OSError:
            return recs
        born = getattr(st, "st_birthtime", None)
        return infer_times(recs, int(born * 1000) if born else None, int(st.st_mtime * 1000))

    def new_since(self, root: Path | str, since: float, taken: set[str], home: Path | None = None) -> str | None:
        """A chat started in ``root`` at/after ``since`` (its transcript folder was created then) that no Agora session owns yet."""
        fresh = []
        for r in self.sessions_for([str(root)], home):
            try:
                st = r["path"].stat()
            except OSError:
                continue
            born = getattr(st, "st_birthtime", st.st_mtime)
            if born >= since and r["nativeId"] not in taken:
                fresh.append((born, r["nativeId"]))
        return min(fresh)[1] if fresh else None

    def native_from_open_files(self, paths: list[str], home: Path | None = None) -> str | None:
        """The chat whose ``store.db`` (``~/.cursor/chats/<hash>/<chat id>/store.db``, kept open by the running CLI) the process has open."""
        base = data_dir(home) / "chats"
        for raw in paths:
            p = Path(os.path.realpath(raw))
            if p.name.startswith("store.db") and p.parent.parent.parent == base and valid_id(p.parent.name):
                return p.parent.name
        return None

    # ——— Projector ———
    def project(self, rec: dict[str, Any], st: State) -> Out:
        return project(rec, st)

    def record_type(self, rec: dict[str, Any]) -> str | None:
        """``user`` / ``assistant`` / ``turn_ended``; an assistant or user record with a content block
        other than text / tool_use is ``<role>/<block type>`` (drift: the adapter would skip it)."""
        if rec.get("type"):
            return str(rec["type"])
        if not rec.get("role"):
            return None
        odd = sorted({str(b.get("type")) for b in _blocks(rec) if isinstance(b, dict) and b.get("type") not in BLOCKS})
        return f"{rec['role']}/{odd[0]}" if odd else str(rec["role"])

    # ——— ToolVocab ———
    def classify(self, name: str, args: Any, root: str | None = None) -> dict[str, Any]:
        return classify(name, args, root)

    # ——— Subagents ———
    def children(self, ref: NativeRef, home: Path | None = None) -> list[NativeRef]:
        """``subagents/<child>.jsonl`` next to the parent's transcript; the Task / Subagent call that
        started a child is the one whose ``prompt`` is the child's first prompt (the parent never
        records the child's id)."""
        sub = ref.path.parent / "subagents" if ref.path is not None else None
        if sub is None or not sub.is_dir():
            return []
        calls: list[dict[str, Any]] = []
        for n, r in enumerate(self.read_records(ref.path)):
            for k, b in enumerate(_blocks(r) if r.get("role") == "assistant" else []):
                if isinstance(b, dict) and b.get("type") == "tool_use" and str(b.get("name") or "").lower() in ("task", "subagent"):
                    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                    calls.append({"id": f"t{n}.{k}", "prompt": str(inp.get("prompt") or "").strip(), "label": inp.get("description"), "role": inp.get("subagent_type"), "model": inp.get("model"), "at": r.get("_at")})
        out = []
        used: set[str] = set()
        for f in sorted(sub.glob("*.jsonl")):
            if not valid_id(f.stem):
                continue
            recs = read_jsonl(f)
            first = next((p for p in (prompt_of(r) for r in recs) if p is not None), None)
            call = next((c for c in calls if c["id"] not in used and c["prompt"] and c["prompt"] == first), None) or {}
            if call:
                used.add(call["id"])
            last = recs[-1] if recs else {}
            state = ("done" if last.get("status") == "success" else "failed") if last.get("type") == "turn_ended" else None
            why = ["父会话目录下的 subagents/<id>.jsonl"] + (["子会话的第一条提示 = 父会话 Task 调用的 prompt"] if call else [])
            try:
                done_at = int(f.stat().st_mtime * 1000) if state else None
            except OSError:
                done_at = None
            out.append(NativeRef(
                "cursor", f.stem, f, ref.cwd, ParentLink("native", ref.run_id, tool_call_id=call.get("id"), evidence="、".join(why)),
                label=str(call.get("label") or f.stem), meta={"role": call.get("role"), "model": call.get("model"), "dispatchedAt": call.get("at"), "doneAt": done_at, "state": state, "depth": 1},
            ))
        return out

    # ——— Headless ———
    def headless_args(self, cmd: list[str], req: Any, *, log_exists: Callable[[str], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        o = req.options
        if o.fork_from:
            raise ValueError("Cursor 没有分叉会话的命令")
        args = [*cmd, "-p", "--output-format", "stream-json", "--force", "--trust"]
        if o.session:
            args += ["--resume", o.session]
        if o.model:
            args += ["--model", o.model]
        return args  # the prompt goes on stdin

    # ——— Interactive ———
    def fork_argv(self, fork: dict[str, Any]) -> list[str]:
        raise ValueError("Cursor 没有分叉会话的命令")

    def interactive_argv(self, native_id: str | None, model: str | None, effort: str | None, *, new: bool = False, has_log: Callable[[], bool] | bool = False, skill_dir: Path | None = None) -> list[str]:
        args = ["cursor-agent", "--force", "--trust"]
        if native_id and not new:
            args += ["--resume", native_id]
        if model:
            args += ["--model", model]
        return args

    # ——— Catalog ———
    def catalog(self, env: dict[str, str], root: Path | None) -> dict[str, Any]:
        exe = self.installed()
        text = ""
        if exe:
            try:
                r = subprocess.run([exe, "--list-models"], capture_output=True, text=True, timeout=25, env=env)
                text = r.stdout if r.returncode == 0 else ""
            except (OSError, subprocess.SubprocessError):
                text = ""
        ids, names, default = list_models(text)
        return cursor_catalog(ids, names, default, "cursor-agent --list-models" if ids else "none")

    # ——— fixtures (tests/test_adapter_contracts.py) ———
    def fixture_place(self, folder: Path, home: Path, cwd: str, nid: str) -> Path:
        import shutil

        d = data_dir(home) / "projects" / slug(cwd) / "agent-transcripts" / nid
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(folder / "log.jsonl", d / f"{nid}.jsonl")
        if (folder / "subagents").is_dir():
            shutil.copytree(folder / "subagents", d / "subagents")
        return d / f"{nid}.jsonl"

