"""What every CLI adapter shares: the transcript item shape, the per-log parse state, the
headless stream-mapper base, the log lookup result and a JSONL tail.

Moved verbatim from ``transcript.py`` and ``agents.py`` (which re-export these names); living
here breaks the old ``transcript`` ↔ ``agents`` import cycle (``text_of``). Transcript item
shape: see ``transcript.py``'s module docstring (web/docs/agent-sessions.md).
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from server.canvas import agora_msg
from server.canvas.agora_msg import SEL_MARK, page_card
from server.canvas.runner import Usage, empty_usage

# Prompts Agora sends end with a context footer starting with this marker; it tells the
# transcript which user messages came from Agora and is hidden when displayed.
MARKER = "[[agora]]"
MAX_TEXT = 4000
MAX_TOOL = 1500  # the one-line input summary
MAX_FULL = 256_000  # tool args / output kept in full (the page gets a preview, full on demand)


def text_of(content: Any) -> str:
    """Plain text of a message ``content`` (string, or blocks with ``text``)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text", "Text"))


def split_agora(text: str) -> tuple[str, bool]:
    """(what the person wrote, whether Agora sent it)."""
    i = text.find(MARKER)
    if i < 0:
        return text, False
    return text[:i].rstrip(), True


def _ms(ts: Any) -> int:
    if isinstance(ts, (int, float)):
        return int(ts if ts > 1e11 else ts * 1000)
    if isinstance(ts, str):
        try:
            return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            pass
    return int(time.time() * 1000)


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[: n - 1] + "…"


def _summary(inp: Any) -> str:
    """A tool input as one readable line (commands as-is, objects as compact JSON)."""
    if isinstance(inp, dict):
        for k in ("command", "cmd", "file_path", "path", "pattern", "query", "url"):
            v = inp.get(k)
            if isinstance(v, str) and v:
                return _clip(v, MAX_TOOL)
            if isinstance(v, list) and v:
                return _clip(" ".join(map(str, v)), MAX_TOOL)
        return _clip(json.dumps(inp, ensure_ascii=False), MAX_TOOL)
    if isinstance(inp, list):
        return _clip(" ".join(map(str, inp)), MAX_TOOL)
    return _clip(str(inp or ""), MAX_TOOL)


# Claude Code records a long terminal paste wrapped in <pasted_content id="…"> tags.
PASTE_TAG = re.compile(r"</?pasted_content[^>]*>")


# The token a dispatch (dispatch.py) puts in the footer of the message it sends: the CLI's own record of
# that one user message then names the dispatch, which is how it is known to have arrived.
DISPATCH_MARK = re.compile(r"agora-req-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})")


# The token in the footer of the note that tells a giver its dispatch ended (dispatch.py): with it a restarted
# server can see in the giver's own log that this note was already delivered, and not send it twice.
RECEIPT_MARK = re.compile(r"agora-receipt-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z_]+)")


def user_item(id: str, text: str, at: int) -> dict[str, Any]:
    clean = PASTE_TAG.sub("", text).strip()
    body, from_agora = split_agora(clean)
    body = agora_msg.strip_file_tags(body) if from_agora else body
    foot = clean[len(body) :] if from_agora else ""
    mark = DISPATCH_MARK.search(foot)
    receipt = RECEIPT_MARK.search(foot)
    extra: dict[str, Any] = {}
    if from_agora:
        # what Agora wrote into the message (agora_msg.py): a card, or the person's words with a selection picture / list
        extra["card"] = agora_msg.card(body, receipt.group(1).split(":")[1] if receipt else None)
        body, ids = agora_msg.strip_tail_note(body)
        extra["card"] = extra["card"] or page_card(foot, _clip(body, MAX_TEXT))  # a prompt the page wrote for the person: a card with its source
        sel = SEL_MARK.search(foot)
        extra["selection"] = {"id": sel.group(1)} if sel else {"ids": ids} if ids else None
    return {"id": id, "kind": "user", "text": _clip(body, MAX_TEXT), "at": at, "source": "agora" if from_agora else "terminal", **({"dispatch": mark.group(1)} if mark else {}), **({"receipt": receipt.group(1)} if receipt else {}), **{k: v for k, v in extra.items() if v}}


def image_b64(path: str) -> str:
    """A picture file as base64 (the selection's png; what Claude's stream-json and Grok's ACP blocks carry)."""
    return base64.b64encode(Path(path).read_bytes()).decode()


def _full(v: Any) -> str:
    """A tool input or output as text, as complete as MAX_FULL allows."""
    if isinstance(v, str):
        return _clip(v, MAX_FULL)
    try:
        return _clip(json.dumps(v, ensure_ascii=False, indent=2), MAX_FULL)
    except (TypeError, ValueError):
        return _clip(str(v), MAX_FULL)


_layout: dict[str, tuple[float, list[str], set[str]]] = {}
LAYOUT_TTL_S = 10.0


def worktrees(root: str) -> list[str]:
    """The project root and its git worktrees (``git worktree list --porcelain``, read-only)."""
    out = [os.path.realpath(root)]
    try:
        r = subprocess.run(["git", "-C", root, "worktree", "list", "--porcelain"], capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if line.startswith("worktree "):
                p = os.path.realpath(line[len("worktree ") :].strip())
                if p not in out:
                    out.append(p)
    except (OSError, subprocess.SubprocessError):
        pass
    return out


def _repo_layout(root: str) -> tuple[list[str], set[str]]:
    """The repository's work trees and the project's top-level entries (a few seconds old at most)."""
    hit = _layout.get(root)
    if hit and time.monotonic() - hit[0] < LAYOUT_TTL_S:
        return hit[1], hit[2]
    try:
        tops = {n for n in os.listdir(root) if not n.startswith(".")}
    except OSError:
        tops = set()
    trees = worktrees(root)
    _layout[root] = (time.monotonic(), trees, tops)
    return trees, tops


def _repo_relative(path: str, root: str) -> str:
    """An absolute path inside another work tree of the project's repository, relative to that work tree
    (so it maps like the project's own file). A work tree deleted after its merge is recognised as a
    sibling of a live one whose remainder starts at a top-level entry of the project. Anything else —
    a relative path, a path outside the repository — comes back unchanged."""
    p = os.path.normpath(path)
    trees, tops = _repo_layout(root)
    for wt in trees:
        if p == wt:
            return "."
        if p.startswith(wt.rstrip("/") + "/"):
            return p[len(wt.rstrip("/")) + 1 :]
    for wt in trees:
        parent = os.path.dirname(wt.rstrip("/"))
        if not p.startswith(parent.rstrip("/") + "/"):
            continue
        gone, _, rest = p[len(parent.rstrip("/")) + 1 :].partition("/")
        if rest and rest.split("/")[0] in tops and not os.path.exists(os.path.join(parent, gone)):
            return rest
    return path


def rel_path(path: str, root: str | None) -> str:
    """``path`` relative to the project root (posix) when it is inside it — or inside another work tree of
    the same repository, where it is relative to that work tree; otherwise as given."""
    if not path:
        return path
    p = path.replace("\\", "/")
    if not root:
        return p
    if not os.path.isabs(p):
        return os.path.normpath(p).replace(os.sep, "/").removeprefix("./")
    for r in {root, os.path.realpath(root)}:
        for q in (p, os.path.realpath(p)):
            try:
                rel = os.path.relpath(q, r)
            except ValueError:
                continue
            if not rel.startswith(".."):
                return rel.replace(os.sep, "/")
    return _repo_relative(p, root)


def _usage(model: Any, inp: Any, out: Any, cache_read: Any = None, cache_write: Any = None, cost: Any = None) -> dict[str, Any]:
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None  # noqa: E731
    return {
        "model": str(model) if model else None,
        "inputTokens": num(inp),
        "outputTokens": num(out),
        "cacheReadTokens": num(cache_read),
        "cacheWriteTokens": num(cache_write),
        "costUsd": num(cost),
    }


@dataclass
class State:
    """Per-log parse state: pending tool calls in the current turn, whether a turn is open."""

    busy: bool = False
    pending: set[str] = field(default_factory=set)
    last_text: str = ""
    root: str | None = None  # project root: file paths are reported relative to it
    turn: str = ""  # id of the user message that opened the current (or last) turn
    turn_at: int = 0
    codex_usage_records: bool = False
    # Record types the adapter does not know, counted (drift detection, never shown as items).
    unknown: dict[str, int] = field(default_factory=dict)
    records: int = 0
    # Adapter-private scratch (e.g. Grok's pending tool calls by id); never compared by parity tests.
    extra: dict[str, Any] = field(default_factory=dict)


Out = tuple[list[dict[str, Any]], list[dict[str, Any]]]  # (item upserts, turn changes)


def _start(st: State, turns: list[dict[str, Any]], turn_id: str = "", at: int = 0) -> None:
    st.busy = True
    st.pending.clear()
    st.last_text = ""
    st.turn = turn_id or st.turn
    st.turn_at = at
    turns.append({"turn": "start"})


def end_item(st: State, at: int, error: str | None = None, duration_ms: Any = None) -> dict[str, Any]:
    it: dict[str, Any] = {"id": f"end-{st.turn}", "kind": "end", "at": at, "turn": st.turn}
    if error:
        it["error"] = error
    if isinstance(duration_ms, (int, float)) and not isinstance(duration_ms, bool):
        it["durationMs"] = int(duration_ms)
    return it


def _end(st: State, turns: list[dict[str, Any]], error: str | None = None, items: list[dict[str, Any]] | None = None, at: int | None = None) -> None:
    if not st.busy:
        return
    st.busy = False
    st.pending.clear()
    turns.append({"turn": "end", "text": st.last_text, **({"error": error} if error else {})})
    if items is not None and st.turn:
        items.append(end_item(st, at or int(time.time() * 1000), error))


# ——— headless stdout mapping ———
def add_usage(total: Usage, part: Usage) -> Usage:
    out = dict(total)
    for k in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"):
        if part[k] is not None:
            out[k] = (out[k] or 0) + part[k]
    if part["costUsd"] is not None:
        out["costUsd"] = (out["costUsd"] or 0.0) + part["costUsd"]
    out["model"] = part["model"] or out["model"]
    return out  # type: ignore[return-value]


class StreamMapper:
    """Stateful: ``feed`` one decoded stdout record, get events; ``final`` sums it up."""

    def __init__(self, model: str | None, session: str | None) -> None:
        self.model = model
        self.session = session
        self.text: str = ""  # last assistant message text
        self.error: str | None = None
        self.usage: Usage = empty_usage(model)
        self.done = False

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:  # pragma: no cover - interface
        raise NotImplementedError

    def final_usage(self, duration_ms: int) -> Usage:
        u = dict(self.usage)
        u["durationMs"] = duration_ms
        u["model"] = u["model"] or self.model
        return u  # type: ignore[return-value]


# ——— where a native session's log is ———
@dataclass(frozen=True)
class LogLookup:
    """Where a native session's log is: ``found`` (``path`` is the one to follow), ``missing``,
    ``ambiguous`` (several copies, none clearly the current one) or ``elsewhere`` (Pi: only in
    another directory's folder, so ``--session-id`` would start a new session)."""

    state: str
    path: Path | None = None
    candidates: tuple[Path, ...] = ()


def _hinted(hint: str | Path | None, native_id: str) -> Path | None:
    """The path the binding last saw the log at, if it is still there and still names this session."""
    p = Path(hint) if hint else None
    return p if p is not None and native_id in p.name and p.exists() else None


class Tail:
    """Follow one JSONL file from its start; ``read()`` returns records appended since last time."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.offset = 0
        self._partial = b""
        self._ino: int | None = None

    def read(self, limit: int = 32 * 1024 * 1024) -> list[dict[str, Any]]:
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            return []
        if self._ino is not None and (st.st_ino != self._ino or st.st_size < self.offset):
            self.offset, self._partial = 0, b""  # replaced or truncated: start over
        self._ino = st.st_ino
        if st.st_size <= self.offset:
            return []
        with open(self.path, "rb") as fh:
            fh.seek(self.offset)
            chunk = fh.read(min(limit, st.st_size - self.offset))
        self.offset += len(chunk)
        data = self._partial + chunk
        lines = data.split(b"\n")
        self._partial = lines.pop()  # "" when the chunk ended on a newline
        out = []
        for line in lines:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict):
                out.append(rec)
        return out


def read_jsonl(path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    """Every JSON object line of a file (bad lines skipped); ``limit`` caps the bytes read."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read(limit) if limit else fh.read()
    except OSError:
        return []
    out = []
    for line in raw.split(b"\n"):
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def note_unknown(st: State, rtype: str) -> None:
    st.unknown[rtype] = st.unknown.get(rtype, 0) + 1
