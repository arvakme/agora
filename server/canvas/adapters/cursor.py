"""Cursor (``cursor-agent``) — T2, observed only (user decision 2026-09-28: never a session agent).

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
- Seedmux starts it as ``cursor-agent --yolo --sandbox disabled --trust -- <prompt>`` and never
  learns its chat id (no hooks): ``worker_for_ticket`` finds the transcript in the ticket's cwd that
  was given the ticket.
"""

from __future__ import annotations

import glob
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from server.canvas.adapters.base import Adapter, NativeRef, ParentLink, VersionRange, tool_facts, valid_id
from server.canvas.adapters.common import MAX_TEXT, LogLookup, Out, State, _clip, _end, _full, _start, _summary, read_jsonl, rel_path, user_item
from server.canvas.adapters.tools import activity_of, patch_files, prompt_names_ticket, replies_to_ticket, shell_reads

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
        got, reads = shell_reads(a.get("command"), root, cwd)
        act = got or act
    elif n in ("grep", "rg") and path and "." in path.rstrip("/").rsplit("/", 1)[-1]:
        reads = [rel_path(path, root)]
    spawn = {"childKind": "cursor", "via": "native", **({"role": str(a["subagent_type"])} if a.get("subagent_type") else {})} if n in ("task", "subagent") else None
    return tool_facts(act, files=files, reads=reads, waits_user=act == "questions", spawn=spawn)


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
                items.append({"id": f"t{n}.{k}", "kind": "tool", "at": int(at + i * span), "endAt": int(at + (i + 1) * span), "tool": {"name": name, "input": _summary(inp), "args": _full(inp), **classify(name, inp, st.root)}})
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


class CursorAdapter(Adapter):
    kind = "cursor"
    name = "Cursor"
    binaries = ("cursor-agent",)
    tested = VersionRange(">=2026.09.26,<2026.11")
    max_tier = "T2"
    seedmux_names = ("cursor-agent",)
    icon = "cursor"
    log_hint = "~/.cursor/projects/<工作区>/agent-transcripts/<id>/<id>.jsonl"
    log_dir = "~/.cursor/projects/"
    delete_hint = ""
    has_cost = False
    waits = "inferred"
    times_inferred = True

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

    # ——— Seedmux workers (receipts.worker_ref) ———
    def worker_for_ticket(self, rc: dict[str, Any], home: Path | None = None) -> tuple[str, Path, str] | None:
        """The transcript in the ticket's cwd, alive while the ticket was open (created before its
        reply, written to after its dispatch), whose first prompt names the ticket or which ran
        ``smx-team ack/reply`` for it: (chat id, path, why)."""
        task, cwd = rc.get("taskId"), rc.get("cwd")
        if not task or not cwd:
            return None
        created = (rc.get("createdAt") or 0) / 1000
        until = (rc.get("repliedAt") or time.time() * 1000) / 1000
        cands: list[tuple[float, Path]] = []
        for d in transcript_dirs(str(cwd), home):
            for p in d.glob("*/*.jsonl"):
                try:
                    st = p.stat()
                except OSError:
                    continue
                born = getattr(st, "st_birthtime", None)
                if p.stem == p.parent.name and valid_id(p.stem) and st.st_mtime >= created - TICKET_PAD_S and (born is None or born <= until + TICKET_PAD_S):
                    cands.append((abs((born or st.st_mtime) - created), p))
        for _, p in sorted(cands):
            why = gave_ticket(read_jsonl(p), task)
            if why:
                return p.stem, p, why
        return None

    # ——— fixtures (tests/test_adapter_contracts.py) ———
    def fixture_place(self, folder: Path, home: Path, cwd: str, nid: str) -> Path:
        import shutil

        d = data_dir(home) / "projects" / slug(cwd) / "agent-transcripts" / nid
        d.mkdir(parents=True, exist_ok=True)
        shutil.copy(folder / "log.jsonl", d / f"{nid}.jsonl")
        if (folder / "subagents").is_dir():
            shutil.copytree(folder / "subagents", d / "subagents")
        return d / f"{nid}.jsonl"


def gave_ticket(recs: list[dict[str, Any]], task: str) -> str | None:
    """Why a transcript is the ticket's worker, or None: its first prompt names the ticket (Seedmux's
    worker envelope), or it ran ``smx-team ack/reply <ticket>``."""
    first = next((p for p in (prompt_of(r) for r in recs) if p is not None), None)
    if first is not None and prompt_names_ticket(first, task):
        return f"（第一条提示就是工单 {task}）"
    for r in recs:
        for b in _blocks(r) if r.get("role") == "assistant" else []:
            if isinstance(b, dict) and b.get("type") == "tool_use" and str(b.get("name") or "").lower() in SHELLS:
                if replies_to_ticket((b.get("input") or {}).get("command") if isinstance(b.get("input"), dict) else None, task):
                    return f"（它运行了 smx-team ack/reply {task}）"
    return None
