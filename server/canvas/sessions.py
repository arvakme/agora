"""Agent sessions for one project: each Agora session is one native Pi / Claude Code /
Codex session. This hub routes messages to it, follows its log, runs its terminal pane,
and bridges canvas commands (``agora canvas …``) to the open page.

Routing a message (``send``):

- a terminal pane holds the session → deliver into the pane (bracketed paste + Enter),
  held while the agent is still answering or a person holds the input right (a takeover, or a
  writable client attached to the pane: terminal.py) — the queue stays until it is given back;
- otherwise → a headless turn in the project directory that resumes the native id
  (``AgentBackend`` from agents.py), one at a time per session.

Either way the reply is read back from the CLI's own log (transcript.py), so whatever is
said on either side shows up on the other. Pages subscribe to ``events`` (SSE) for
transcripts, status and bridge requests.

Canvas bridge: the page owns the live scene and the existing checks (schema, references,
freshness, one undoable batch — web/src/session/agentBridge.ts). ``read``/``apply``/``anim``
are forwarded to the most recently connected page and wait for its answer; with no page
open, ``read`` falls back to the project files and writes are refused.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Callable
from typing import Any

from server.canvas import adapters, agents, executors as executors_mod, fallback as fallback_mod, graph_hub, nested, page_help, proctree, schemas
from server.canvas.adapters import drift
from server.canvas.local import Local
from server.canvas.model_view import model_view, versions
from server.canvas.project import ProjectStore
from server.canvas.resident import ResidentPool
from server.canvas.adapters.claude import answer_response, approve_response, deny_response, interrupt_request
from server.canvas.runner import KILL_GRACE_S, Control, ExecOptions, RunRequest, make_backend
from server.canvas.terminal import PasteSubmitFailed, TerminalError, Terminals, gate_hold
from server.canvas.transcript import MARKER, State, Tail, project, split_agora

TICK_S = 0.4
RELOCATE_S = 5.0  # how often a followed log is looked up again (it may have moved: Pi migration, a fork)
PANE_BOOT_S = 6.0  # a freshly opened pane gets this long to start its CLI before the first paste
DELIVERY_CONFIRM_S = 30.0
BRIDGE_TIMEOUT_S = 25.0
MAX_ITEMS = 1500
PREVIEW = 4000  # tool args / output characters pushed to the page; the rest on request
READS_KEPT = 64
SNAPSHOT_MAX = 20 * 1024 * 1024  # per session: past this the trajectory snapshot stops growing
SUMMARY_MAX = 6000  # characters of the "carry on with a summary" message
STALE_DAYS = 20  # a Claude Code session idle this long is warned about Claude's 30-day cleanup
INTERRUPT_GRACE_S = 15.0  # a two-way turn that has not ended this long after an interrupt is stopped the hard way
DETACH_GRACE_S = 3.0  # the last window has been gone this long (and the CLI is idle): the background pane is closed
SEND_MODES = ("auto", "steer", "interrupt", "wait")
ASKED_MODE = "auto"  # the permission mode Agora asks a two-way CLI for (adapters/claude.py headless_args)


class NoPage(RuntimeError):
    """A write needs an open Agora page (it owns the live scene) and none is connected."""


class PageTookIt(NoPage):
    """A page took the request and did not report back: the edit may already be on its canvas, so nothing else may run it."""


class Busy(RuntimeError):
    pass


class Copied(RuntimeError):
    """The session came along with a copy of the project (``cp -r``): the original copy still uses
    its native session, so this one is read-only until the person forks it here."""

    def __init__(self, sid: str, info: dict[str, Any]) -> None:
        self.info = {**info, "sessionId": sid}
        super().__init__(f"这个会话是从 {info.get('from')} 复制过来的，原来那份项目还在用它的原生会话；要在这里接着用，先「在这里分叉继续」。")


def agora_prompt(body: str, *, canvas_id: str | None, canvas_name: str | None, extra: str = "", session_id: str | None = None, project_id: str | None = None) -> str:
    """What Agora sends: the person's words, then a context footer (hidden in the transcript).

    The footer's ``(canvas=… session=… project=…)`` names the canvas, the Agora session and the
    project (first 8 characters of its id), so a native log can later be matched back to the
    Agora session it belongs to even when ``.agora/sessions/`` is gone."""
    ids = " ".join(f"{k}={v}" for k, v in (("canvas", canvas_id), ("session", session_id), ("project", (project_id or "").replace("-", "")[:8] or None)) if v)
    where = f"画布「{canvas_name or canvas_id}」" if canvas_id else "这个项目的画布"
    footer = f"{MARKER} 来自 Agora · {where}{f'({ids})' if ids else ''}。读图、改图、做动画用 agora skill（`agora canvas …`）。{extra}".rstrip()
    return f"{body.rstrip()}\n\n{footer}"


def canvas_names(store: ProjectStore) -> dict[str, str]:
    ws = store.read("workspace")
    docs = (ws[0].get("docs") if ws else None) or []
    names = {d["id"]: d.get("title") or d["id"] for d in docs if isinstance(d, dict) and d.get("kind") == "canvas" and d.get("id")}
    for p in sorted((store.dir / "canvases").glob("*.excalidraw")):
        names.setdefault(p.name.removesuffix(".excalidraw"), p.name.removesuffix(".excalidraw"))
    return names


def resolve_canvas(store: ProjectStore, canvas: str | None = None, session: str | None = None) -> str:
    """``--canvas`` → the session's canvas → the focused/only canvas."""
    names = canvas_names(store)
    if canvas:
        if canvas not in names:
            by_name = [i for i, n in names.items() if n == canvas]
            if len(by_name) == 1:
                return by_name[0]
            raise ValueError(f"unknown canvas {canvas!r}; known: {', '.join(f'{i} ({n})' for i, n in names.items())}")
        return canvas
    if session:
        s = store.read_session(session)
        cid = ((s or ({}, ""))[0].get("session") or {}).get("canvasId")
        if cid and cid in names:
            return cid
    ws = store.read("workspace")
    focused = (ws[0].get("focused") if ws else None) or ""
    if focused in names:
        return focused
    if len(names) == 1:
        return next(iter(names))
    if not names:
        raise ValueError("this project has no canvas yet")
    raise ValueError(f"several canvases; pass --canvas: {', '.join(f'{i} ({n})' for i, n in names.items())}")


def file_read(store: ProjectStore, canvas_id: str) -> dict[str, Any]:
    got = store.read("canvas", canvas_id)
    if got is None:
        raise ValueError(f"canvas {canvas_id} has no file")
    elements = got[0].get("elements") or []
    names = canvas_names(store)
    return {"canvasId": canvas_id, "name": names.get(canvas_id, canvas_id), "scene": nested.annotate(store, canvas_id, model_view(elements), names), "versions": versions(elements), "source": "file"}


def save_read(store: ProjectStore, canvas_id: str, vers: dict[str, str]) -> str:
    """Remember the element versions a read saw; the token becomes ``apply --base``."""
    store.check_alive()
    d = store.run_dir / "reads"
    d.mkdir(parents=True, exist_ok=True)
    token = f"r-{int(time.time())}-{secrets.token_hex(3)}"
    (d / f"{token}.json").write_text(json.dumps({"canvasId": canvas_id, "versions": vers, "at": int(time.time() * 1000)}))
    for old in sorted(d.glob("r-*.json"), key=lambda p: p.stat().st_mtime)[:-READS_KEPT]:
        old.unlink(missing_ok=True)
    return token


def load_read(store: ProjectStore, token: str) -> dict[str, Any]:
    if not token.startswith("r-") or "/" in token:
        raise ValueError(f"bad base token {token!r}")
    p = store.run_dir / "reads" / f"{token}.json"
    if not p.exists():
        raise ValueError(f"unknown base {token!r}: run `agora canvas read` again")
    return json.loads(p.read_text())


@dataclass
class Pending:
    send_id: str
    prompt: str
    at: float
    delivered_at: float | None = None
    force: bool = False  # the person said "send it now": this one message goes past the input-right gate
    images: tuple[str, ...] = ()  # picture files that go with the words (a headless turn of a CLI that takes them)


def public_item(it: dict[str, Any]) -> dict[str, Any]:
    """What the page gets: tool args / output cut to a preview, with their full length."""
    tool = it.get("tool")
    if not isinstance(tool, dict):
        return it
    short = dict(tool)
    for k in ("args", "output"):
        v = tool.get(k)
        if isinstance(v, str) and len(v) > PREVIEW:
            short[k] = v[:PREVIEW]
            short[f"{k}Len"] = len(v)
    return {**it, "tool": short}


@dataclass
class Live:
    """Runtime state of one bound session."""

    id: str
    tail: Tail | None = None
    state: State = field(default_factory=State)
    runs_loaded: bool = False
    items: OrderedDict[str, dict[str, Any]] = field(default_factory=OrderedDict)
    run: asyncio.Task | None = None
    headless: list[Pending] = field(default_factory=list)
    pane: list[Pending] = field(default_factory=list)
    awaiting: list[Pending] = field(default_factory=list)  # delivered into the pane, turn not seen yet
    current: Pending | None = None  # the Agora message whose turn is open in the log
    held: str | None = None
    running: bool = False  # a headless turn is in progress
    pane_alive: bool = False
    pane_since: float | None = None
    activity: str | None = None
    last_error: str | None = None
    native: dict[str, Any] | None = None  # the native log is missing / ambiguous / elsewhere (agents.NativeMissing.public)
    located_at: float = 0.0  # when the followed log was last looked up
    snap: dict[str, str] = field(default_factory=dict)  # item id → what the trajectory snapshot holds for it
    snap_size: int = 0
    # Two-way headless turn (Claude): what the CLI has open with the person is runtime fact, never saved
    # and never replayed: a restart ends it together with the process.
    requests: OrderedDict[str, dict[str, Any]] = field(default_factory=OrderedDict)  # request id → the CLI's request (adapter event)
    control: Control | None = None  # where answers and the interrupt are written while the turn runs
    mode: str | None = None  # the permission mode the CLI reported in its init (``auto``, or ``default`` when the model has no auto)
    interrupting: bool = False
    last_tool: str | None = None  # the tool call the running headless turn made last (where a steer lands)
    # Whether what the running headless turn reads (steer, a soft interrupt) is live: a two-way CLI (Claude) from the start; Codex
    # and Pi once their resident process says so (``resident`` event), None until then, False when the turn fell back to the one-shot
    # way. ``steer_why`` (says why the last turn fell back) stays until a turn is resident again.
    live_control: bool | None = None
    steer_why: str | None = None
    asked: set[str] = field(default_factory=set)  # tool calls put to the person this turn (the CLI lists a denied or interrupted one in permission_denials too: not auto's doing)
    seen_window: bool = False  # a terminal window has been attached to this pane (an unattended pane is not closed)
    detached_at: float | None = None  # since when no window is attached (only while the pane is otherwise idle)
    notes: list[dict[str, Any]] = field(default_factory=list)  # notices to show once the transcript is loaded (a turn a restart ended)


class Subscriber:
    def __init__(self) -> None:
        self.q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=2000)
        self.at = time.time()
        self.id = secrets.token_hex(6)
        # 0: not an executor; 1: an old page (runs what it is given, no claim); 2: claims a request before it runs it
        self.executor = 0
        # What an executor page reports about itself (executors.py ranks by it)
        self.visible: bool | None = None
        self.focused_at = 0.0
        self.answered_at: float | None = None
        self.failed_at: float | None = None

    def put(self, ev: dict[str, Any]) -> None:
        try:
            self.q.put_nowait(ev)
        except asyncio.QueueFull:
            pass


def summary_head(found: bool) -> str:
    """The first line of a session's summary: it says the native record is lost only when it is (an imported or a live session has its log; its summary is just a summary)."""
    if found:
        return "（下面是这个会话此前的对话摘要。）"
    return "（接着之前的讨论：原来的原生会话记录已经丢失，下面是 Agora 保存的轨迹摘要。）"


class AgentHub:
    def __init__(self, store: ProjectStore, *, terminals: Terminals | None = None, backend_factory=make_backend, local: Local | None = None) -> None:
        self.store = store
        self.local = local or Local(store)
        self.terms = terminals or Terminals(store.root, store.run_dir, socket=self.local.socket(), legacy=self.local.legacy_sockets())
        self.make_backend = backend_factory
        self.live: dict[str, Live] = {}
        # Sessions moved to the trash while this server runs: a headless turn that finishes later
        # must not write their native id, usage or status back (restore takes them off the list).
        self.dropped: set[str] = set()
        self.subs: list[Subscriber] = []
        self.bridge_waits: dict[str, asyncio.Future] = {}
        self.bridge_offers: dict[str, dict[str, Any]] = {}  # rid → which page it is offered to, who claimed it
        self._loop_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        # Reentrant: on the loop thread (`items()` at startup) `broadcast` calls the listeners inline while the follower
        # holds this, and a listener (dispatch.py) reads `live.items` under it too.
        self._follow_lock = threading.RLock()
        # Who else needs to know what the hub sees (dispatch.py): every broadcast event (on the loop
        # thread); the moment before a message is injected into a CLI (session id, send id; from a
        # worker thread or the loop, and it must not block); the first time the loop starts.
        self.listeners: list[Callable[[dict[str, Any]], None]] = []
        self.handoff_hooks: list[Callable[[str, str], None]] = []
        self.start_hooks: list[Callable[[], None]] = []
        # When no page can take an edit (page_help.py): the open command (set by the app; None = never open one), its clock and
        # timings (tests shorten them), and when a page was last opened.
        self.opener: Callable[[str], None] | None = None
        self.clock: Callable[[], float] = time.monotonic
        self.open_wait_s: float = page_help.OPEN_WAIT_S
        self.page_reply_s: float = executors_mod.PAGE_REPLY_S
        self.bridge_timeout_s: float = BRIDGE_TIMEOUT_S
        self._last_open: float | None = None
        self.residents = ResidentPool(store.run_dir / "residents")  # Codex / Pi: one long-lived process per session (resident.py)
        self._reap_orphans()

    # ——— lifecycle ———
    def ensure_started(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self._loop_task is None or self._loop_task.done():
            first = self._loop_task is None
            self._loop_task = self._loop.create_task(self._run_loop())
            if first:
                for hook in self.start_hooks:
                    hook()

    async def close(self) -> None:
        """Stop following and end every headless turn — the CLI processes too, and only then return
        (a process waiting for an answer nobody can give must not outlive `agora down`)."""
        if self._loop_task:
            self._loop_task.cancel()
        runs = [lv.run for lv in self.live.values() if lv.run and not lv.run.done()]
        for t in runs:
            t.cancel()
        if runs:
            await asyncio.wait(runs, timeout=2 * KILL_GRACE_S + 2)
        try:  # the resident processes and what they started go with the server (bounded: proctree's grace is KILL_GRACE_S)
            await asyncio.wait_for(self.residents.close_all(), 2 * KILL_GRACE_S + 2)
        except (TimeoutError, Exception):
            pass
        for fut in list(self.bridge_waits.values()):  # an edit waiting for a page: the server is going, tell the caller now
            if not fut.done():
                fut.set_exception(NoPage("Agora 服务正在关闭：这次改图没有执行。"))

    def _get(self, sid: str) -> Live:
        if sid not in self.live:
            self.live[sid] = Live(sid)
        return self.live[sid]

    def binding(self, sid: str) -> dict[str, Any]:
        b = self.store.read_binding(sid)
        if b is None:
            raise LookupError(f"session {sid} has no agent yet")
        return b

    # ——— events ———
    def broadcast(self, ev: dict[str, Any]) -> None:
        """Fan an event out to every page. Safe from worker threads (the log follower)."""
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if self._loop is not None and running is not self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._fanout, ev)
        else:
            self._fanout(ev)

    def _fanout(self, ev: dict[str, Any]) -> None:
        for s in list(self.subs):
            s.put(ev)
        for fn in list(self.listeners):
            try:
                fn(ev)
            except Exception:  # a listener must never stop the transcript
                pass

    def _handoff(self, sid: str, send_id: str) -> None:
        """Tell the hooks a message is about to be injected: what they persist is written before it is."""
        for fn in list(self.handoff_hooks):
            fn(sid, send_id)

    def subscribe(self, executor: bool | int) -> Subscriber:
        self.ensure_started()
        sub = Subscriber()
        sub.executor = int(executor)
        self.subs.append(sub)
        for sid in self.store.bindings():
            lv = self._get(sid)
            self._follow(sid, lv)
            sub.put({"t": "transcript", "sessionId": sid, "reset": True, "items": [public_item(i) for i in list(lv.items.values())[-MAX_ITEMS:]]})
            sub.put(self.status(sid))
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        if sub in self.subs:
            self.subs.remove(sub)

    def status(self, sid: str) -> dict[str, Any]:
        lv = self._get(sid)
        b = self.store.read_binding(sid) or {}
        return {
            "t": "status",
            "sessionId": sid,
            "binding": b,
            "copy": self.local.copies().get(sid),
            "native": lv.native,
            "stale": self.stale(sid, b),
            "snapshot": bool(lv.snap),
            "running": lv.running,
            "waiting": bool(lv.requests),
            "waitingSince": min((r["at"] for r in lv.requests.values()), default=None),  # ms: since when it has waited for the person
            "mode": {"actual": lv.mode, "asked": getattr(adapters.get(b["agent"]) if b else None, "asked_mode", ASKED_MODE)} if lv.mode else None,
            "busy": lv.state.busy,
            "queued": len(lv.headless) + len(lv.pane),
            "held": lv.held,
            "steer": self._steer_state(b, lv),
            "steerWhy": lv.steer_why,
            "activity": lv.activity,
            "error": lv.last_error,
            "terminal": self._terminal(sid, lv),
        }

    def _terminal(self, sid: str, lv: Live) -> dict[str, Any]:
        out: dict[str, Any] = {"alive": lv.pane_alive, "attach": self.terms.attach_command(sid), "clients": 0, "app": None}
        if lv.pane_alive:
            gate = self.terms.gate(sid)
            clients = self.terms.clients(sid)
            lv.seen_window = lv.seen_window or clients > 0
            out.update(app="tmux", clients=clients, inputRight=gate.input_right, paused=gate.paused, writers=gate.unmanaged_writers)
        return out

    def _status(self, sid: str) -> None:
        if sid in self.dropped:
            return
        self.broadcast(self.status(sid))

    # ——— transcript ———
    def _follow(self, sid: str, lv: Live) -> None:
        """Read what the session log gained since last time; push items and turn changes."""
        with self._follow_lock:
            self._follow_locked(sid, lv)

    def _follow_locked(self, sid: str, lv: Live) -> None:
        b = self.store.read_binding(sid)
        if not lv.runs_loaded:
            lv.runs_loaded = True
            # What Agora kept of the trajectory first: if the native log is gone, this is what the
            # panel shows (read-only); if it is there, reading it again brings the full records.
            for it in self._load_snapshot(sid, lv):
                lv.items[it["id"]] = it
            for it in self._load_runs(sid):
                lv.items[it["id"]] = it
            for it in lv.items.values():  # a wait the host marked lived only as long as the process that held the request
                if isinstance(it.get("tool"), dict) and it["tool"].pop("hostWait", None):
                    it["tool"]["waitsUser"] = bool(b and adapters.need(b["agent"]).classify(str(it["tool"].get("name")), {}, None).get("waitsUser"))
            for n in lv.notes:
                lv.items[n["id"]] = n
            if lv.notes:
                self._keep_snapshot(sid, lv, lv.notes)
                lv.state.busy = False  # the log still shows the turn open, but its process is gone
            lv.notes = []
        if not b or not b.get("nativeId"):
            return
        lv.state.root = str(self.store.root)
        if lv.tail is not None and time.time() - lv.located_at > RELOCATE_S:
            # The log may have moved since (Pi migration, Codex archiving): follow it to the new place.
            lv.located_at = time.time()
            again = agents.locate_log(b["agent"], b["nativeId"], self.store.root, hint=(b.get("log") or {}).get("path"))
            if again.path != lv.tail.path:
                # Moved, or gone while followed (Claude's cleanup, a deleted file): look it up again
                # below, which reports a missing log instead of following a file that is not there.
                lv.tail = None
        if lv.tail is None:
            look = agents.locate_log(b["agent"], b["nativeId"], self.store.root, hint=(b.get("log") or {}).get("path"))
            lv.located_at = time.time()
            problem = None
            if look.state != "found" and binding_started(b):
                problem = agents.NativeMissing(b["agent"], b["nativeId"], look).public()
            if problem != lv.native:
                lv.native = problem
                self._status(sid)
            if look.path is None:
                return
            adapter = adapters.need(b["agent"])
            lv.tail = adapter.tail(look.path) if hasattr(adapter, "tail") else Tail(look.path)  # a database log (Devin) is followed by its adapter
            # Several copies, one of them this project's (Claude after a move or a copy): follow
            # that one, which is also the one the CLI resumes, and say so instead of picking silently.
            lv.native = agents.duplicates_note(b["agent"], b["nativeId"], look)
            self._status(sid)
            if not self.store.gone():
                if b.get("started") is not True:
                    self.store.mark_started(sid)  # the log exists: from now on only ever resumed
                if (b.get("log") or {}).get("path") != str(look.path):
                    self.store.set_log(sid, str(look.path))
        recs = lv.tail.read()
        if not recs:
            return
        changed: list[dict[str, Any]] = []
        finished: list[dict[str, Any]] = []  # "done" events of turns the log ended in this read
        for rec in recs:
            drift.observe(b["agent"], rec)  # records its adapter does not know (notify-only)
            items, turns = project(b["agent"], rec, lv.state)
            for it in items:
                prev = lv.items.get(it["id"])
                if prev and it["kind"] == "tool":
                    merged = {**prev, **{k: v for k, v in it.items() if k != "tool"}, "tool": {**prev.get("tool", {}), **it.get("tool", {})}, "at": prev["at"]}
                else:
                    merged = {**(prev or {}), **it}
                lv.items[it["id"]] = merged
                changed.append(merged)
                if it["kind"] == "user" and lv.awaiting and (it.get("source") == "agora" or it.get("text", "").strip() == split_agora(lv.awaiting[0].prompt)[0].strip()):
                    lv.current = lv.awaiting.pop(0)  # the pane took the message we pasted
            for tc in turns:
                if tc["turn"] == "end" and lv.current is not None:
                    done, lv.current = lv.current, None
                    finished.append({"t": "done", "sessionId": sid, "sendId": done.send_id, "text": tc.get("text") or "", "error": tc.get("error"), "route": "terminal"})
        while len(lv.items) > MAX_ITEMS * 2:
            lv.items.popitem(last=False)
        for ev in lv.requests.values():  # a call the log has now, of a request that arrived first
            marked = self._flag(lv, ev, True)
            if marked is not None:
                changed.append(marked)
        if changed:
            latest = {i["id"]: i for i in changed}  # a call and its result in one read: send the merged item once
            self._keep_snapshot(sid, lv, list(latest.values()))
            self.broadcast({"t": "transcript", "sessionId": sid, "items": [public_item(i) for i in latest.values()]})
        for ev in finished:  # after the transcript: a page reads the finished turn when "done" comes (both can land in one read)
            self.broadcast(ev)
        self._status(sid)

    def item(self, sid: str, item_id: str) -> dict[str, Any]:
        """One transcript item in full (tool args and output past the preview)."""
        lv = self._get(sid)
        self._follow(sid, lv)
        it = lv.items.get(item_id)
        if it is None:
            raise LookupError(f"no item {item_id} in session {sid}")
        return it

    # ——— trajectory snapshot (sessions/snapshots/<id>.jsonl; web/docs/agent-sessions.md §7) ———
    # What the transcript showed, kept by Agora in case the native log disappears (Claude's 30-day
    # cleanup, another machine): user and assistant text in full, tool calls as name, one-line
    # summary and a preview of input and output (the page's preview), files touched. Local only,
    # append-only; the latest line per item id wins; capped per session.
    def _snapshot_path(self, sid: str) -> Path:
        return self.store.dir / "sessions" / "snapshots" / f"{sid}.jsonl"

    def _load_snapshot(self, sid: str, lv: Live) -> list[dict[str, Any]]:
        try:
            raw = self._snapshot_path(sid).read_bytes()
        except OSError:
            return []
        lv.snap_size = len(raw)
        items: dict[str, dict[str, Any]] = {}
        for line in raw.splitlines():
            try:
                it = json.loads(line)
            except ValueError:
                continue
            if isinstance(it, dict) and it.get("id"):
                items[it["id"]] = it
                lv.snap[it["id"]] = line.decode("utf-8", "replace")
        return list(items.values())

    def _keep_snapshot(self, sid: str, lv: Live, items: list[dict[str, Any]]) -> None:
        if sid in self.dropped or self.store.gone():
            return
        lines = []
        for it in items:
            if it.get("kind") == "run":
                continue  # headless usage has its own file (run/usage)
            line = json.dumps(public_item(it), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if lv.snap.get(it["id"]) != line:
                lv.snap[it["id"]] = line
                lines.append(line)
        if not lines or lv.snap_size > SNAPSHOT_MAX:
            return
        chunk = ("\n".join(lines) + "\n").encode()
        try:
            path = self._snapshot_path(sid)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "ab") as fh:
                fh.write(chunk)
            lv.snap_size += len(chunk)
        except OSError:
            pass  # a backstop: a full disk must not stop the transcript

    def summary(self, sid: str) -> str:
        """A message that carries a lost session into a new native one: what was said, turn by turn
        (the latest turns when it is long), from what Agora kept. No model is called."""
        lv = self._get(sid)
        self._follow(sid, lv)
        turns: list[list[str]] = []
        for it in sorted(lv.items.values(), key=lambda i: i.get("at") or 0):
            if it.get("kind") == "user" and (it.get("text") or "").strip():
                turns.append([f"用户：{it['text'].strip()}"])
            elif it.get("kind") == "assistant" and (it.get("text") or "").strip() and turns:
                turns[-1].append(f"助手：{it['text'].strip()}")
            elif it.get("kind") == "tool" and turns and (it.get("tool") or {}).get("name"):
                t = it["tool"]
                turns[-1].append(f"（工具 {t['name']}{': ' + t['input'] if t.get('input') else ''}）")
        b = self.store.read_binding(sid) or {}
        found = bool(b.get("nativeId")) and agents.locate_log(b["agent"], b["nativeId"], self.store.root, hint=(b.get("log") or {}).get("path")).state == "found"
        head = summary_head(found)
        blocks = [f"第 {n} 轮\n" + "\n".join(lines) for n, lines in enumerate(turns, 1)]
        out: list[str] = []
        size = len(head)
        for b in reversed(blocks):  # the latest turns first, then as many earlier ones as fit
            if size + len(b) + 2 > SUMMARY_MAX:
                out.append(f"（更早的 {len(blocks) - len(out)} 轮略）")
                break
            out.append(b)
            size += len(b) + 2
        return "\n\n".join([head, *reversed(out)]) if turns else head

    def restart(self, sid: str) -> dict[str, Any]:
        """The native log is gone: continue this Agora session in a new native session (the next
        message starts it; the page pre-fills a summary). Its transcript and snapshot stay; the old
        id stays in ``natives``. Only for a session whose log is really missing — never a silent
        replacement of one that is still there."""
        import uuid

        b = self.binding(sid)
        look = agents.locate_log(b["agent"], b.get("nativeId"), self.store.root) if b.get("nativeId") else agents.LogLookup("missing")
        if look.state == "found":
            raise ValueError("原生会话还在，不需要开新的；直接接着说")
        # A CLI that takes Agora's id up front gets a fresh one now; one that assigns its own (Codex) on the first run.
        new = str(uuid.uuid4()) if adapters.need(b["agent"]).assigns_id == "agora" else None
        self.store.rebind(sid, new, reason="fresh-after-loss", started=False)
        lv = self._get(sid)
        lv.tail, lv.native = None, None
        self.note_bind(sid, "rebind", reason="fresh-after-loss")
        self._status(sid)
        return self.store.read_binding(sid) or {}

    def stale(self, sid: str, b: dict[str, Any]) -> dict[str, Any] | None:
        """A CLI that deletes untouched session logs itself (Claude Code: 30 days, ``cleanupPeriodDays``;
        the adapter's ``prunes_logs_after_days``): warn from ``STALE_DAYS``."""
        lv = self._get(sid)
        a = adapters.get(b.get("agent"))
        if a is None or a.prunes_logs_after_days is None or lv.tail is None:
            return None
        try:
            idle = (time.time() - os.path.getmtime(lv.tail.path)) / 86400
        except OSError:
            return None
        return {"days": int(idle), "path": str(lv.tail.path)} if idle >= STALE_DAYS else None

    # Usage the runner reported for headless turns (Claude's cost is only in its result line,
    # not in the session log). Kept per session under .agora/run so a restart still shows it.
    def _runs_path(self, sid: str) -> Path:
        return self.store.run_dir / "usage" / f"{sid}.jsonl"

    def _load_runs(self, sid: str) -> list[dict[str, Any]]:
        try:
            lines = self._runs_path(sid).read_text().splitlines()
        except OSError:
            return []
        out = []
        for line in lines:
            try:
                it = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(it, dict) and it.get("id"):
                out.append(it)
        return out

    def _record_run(self, sid: str, lv: Live, send_id: str, started: float, result: dict[str, Any] | None) -> None:
        usage = (result or {}).get("usage")
        if not isinstance(usage, dict) or sid in self.dropped:
            return
        it = {"id": f"run-{send_id}", "kind": "run", "at": int(time.time() * 1000), "startAt": int(started * 1000), "usage": usage}
        with self._follow_lock:
            lv.items[it["id"]] = it
        if self.store.gone():
            return  # the project moved away: nothing is written at its old path
        try:
            path = self._runs_path(sid)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a") as fh:
                fh.write(json.dumps(it, ensure_ascii=False) + "\n")
        except OSError:
            pass
        self.broadcast({"t": "transcript", "sessionId": sid, "items": [it]})

    # ——— main loop ———
    async def _run_loop(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self._tick_sync)
                await self._tick_async()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # keep following; surface the problem
                self.broadcast({"t": "log", "level": "error", "text": f"agent hub: {exc}"})
            await asyncio.sleep(TICK_S)

    def _tick_sync(self) -> None:
        bound = self.store.bindings()
        for sid, b in bound.items():
            lv = self._get(sid)
            alive = self.terms.alive(sid) if (lv.pane_since or lv.pane_alive or lv.pane) else False
            if alive != lv.pane_alive:
                lv.pane_alive = alive
                if not alive:
                    lv.pane_since = None
                    self._pane_exited(sid, lv)
                self._status(sid)
            # A CLI that assigns its own id (Codex) does so when the interactive session starts:
            # adopt the new native session.
            if adapters.need(b["agent"]).assigns_id == "cli" and not b.get("nativeId") and not b.get("pendingFork") and lv.pane_since:
                taken = {x.get("nativeId") for x in bound.values()}
                tid = self._claim_native(sid, b, lv.pane_since, taken)
                if tid:
                    self.store.set_native(sid, tid)
                    self.note_bind(sid, "bind")
                    self._status(sid)
            # An interactive fork (``claude --fork-session``, ``pi --fork``, ``codex fork``) writes a new
            # native session in this project: adopt it as the session's native id.
            if b.get("pendingFork") and lv.pane_since:
                taken = {x.get("nativeId") for x in bound.values() if x.get("nativeId")} | {b["pendingFork"].get("from")}
                new = self._claim_native(sid, b, lv.pane_since, {t for t in taken if t})
                if new:
                    self.adopt_fork(sid, new)
            if lv.pane_alive:
                self._reap_detached(sid, lv)
            self._follow(sid, lv)

    def _reap_detached(self, sid: str, lv: Live) -> None:
        """The person closed the terminal window (Ctrl-B D, the window's ×): the CLI keeps running in its
        pane, but nobody is at it. Once it is idle the pane is closed, so the session is the panel's again
        and the next message is a headless turn that resumes the same native session. A window that is
        still attached, a takeover the person asked for (B1: it holds until given back), a turn in
        progress and a pane nobody ever attached to are all left alone."""
        if self.terms.clients(sid) > 0:
            lv.seen_window, lv.detached_at = True, None
            return
        if not lv.seen_window or self.terms.input_right(sid) is not None:
            return
        if lv.state.busy or lv.awaiting or lv.pane or lv.current is not None:
            lv.detached_at = None  # still working: look again when it is idle
            return
        now = time.time()
        if lv.detached_at is None:
            lv.detached_at = now
        elif now - lv.detached_at >= DETACH_GRACE_S:
            self.close_terminal(sid)

    def _claim_native(self, sid: str, b: dict[str, Any], since: float, taken: set[str]) -> str | None:
        """The native session this pane's CLI started. A CLI whose process keeps its session log open
        (Codex) is asked for that file: the one this pane's own process holds, never "the first new
        log in the directory", which another session started there at the same time would also match.
        The others have no such file; they are told by directory and time."""
        a = adapters.need(b["agent"])
        if a.claims_by_open_file:
            tid = a.native_from_open_files(self.terms.process_files(sid))
            return tid if tid and tid not in taken else None
        return agents.new_native_since(b["agent"], self.store.root, since, taken)

    def _pane_exited(self, sid: str, lv: Live) -> None:
        """The CLI in the pane is gone. What it wrote before going is read first; a turn still open in
        the log has no terminal record, and a message delivered but never seen in the log may or may
        not have been taken: both outcomes are unknown, said as such, not as done or failed."""
        self._follow(sid, lv)
        lost = [(p, "终端里的 CLI 已退出，这一轮没有结束记录，结果未知") for p in ([lv.current] if lv.current is not None else [])]
        lost += [(p, "终端里的 CLI 在日志里出现这条消息之前退出了，不知道它有没有收下、做了多少") for p in lv.awaiting]
        lv.current, lv.awaiting = None, []
        if lost:
            lv.state.busy = False
        for p, why in lost:
            self.broadcast({"t": "done", "sessionId": sid, "sendId": p.send_id, "text": "", "error": why, "outcome": "unknown", "route": "terminal"})

    async def _tick_async(self) -> None:
        for sid, lv in list(self.live.items()):
            if not lv.pane:
                if lv.held:
                    lv.held = None
                    self._status(sid)
                continue
            head = lv.pane[0]
            if not lv.pane_alive:
                # The terminal went away: the queued message goes the headless way.
                lv.headless.append(lv.pane.pop(0))
                self._kick(sid)
                continue
            # A person's input right comes first: nothing is typed over them, and nothing is lost (the queue stays).
            reason = gate_hold(await asyncio.to_thread(self.terms.gate, sid), force=head.force)
            if reason:
                pass
            elif lv.pane_since and time.time() - lv.pane_since < PANE_BOOT_S:
                # A paste into a CLI that is still loading (resume) is dropped.
                reason = "终端刚打开，等 CLI 启动好再投递"
            elif lv.state.busy:
                reason = "agent 正在回复，回复完再投递"
            if reason:
                if reason != lv.held:
                    lv.held = reason
                    self._status(sid)
                continue
            lv.held = None
            try:
                await asyncio.to_thread(self._handoff, sid, head.send_id)
            except Exception as exc:  # what the hooks persist could not be written: nothing was sent, say so
                lv.pane.pop(0)
                self._not_delivered(sid, lv, head, f"没能交付：{exc}", "terminal")
                continue
            try:
                await asyncio.to_thread(self.terms.paste, sid, head.prompt)
            except PasteSubmitFailed as exc:
                # It is in the CLI's input box, unsent. Running it again headless would do it twice: it is not known
                # whether it will be taken (the person may press Enter there), and the page says exactly that.
                lv.pane.pop(0)
                lv.last_error = f"已粘贴到终端的输入框，但回车没有成功：{exc}。不知道它会不会被收下，没有另外重发（在终端里按回车即可提交）"
                self.broadcast({"t": "done", "sessionId": sid, "sendId": head.send_id, "text": "", "error": lv.last_error, "outcome": "unknown", "route": "terminal"})
                self._status(sid)
                continue
            except (TerminalError, OSError) as exc:
                lv.last_error = f"投递到终端失败：{exc}"
                lv.headless.append(lv.pane.pop(0))
                self._kick(sid)
                continue
            lv.pane.pop(0)
            head.delivered_at = time.time()
            lv.awaiting.append(head)
            lv.state.busy = True  # the pane is answering now; confirmation comes from the log
            self.broadcast({"t": "delivered", "sessionId": sid, "sendId": head.send_id, "route": "terminal"})
            self._status(sid)
        # A delivery the log never showed: tell the page instead of waiting forever.
        now = time.time()
        for sid, lv in self.live.items():
            for p in list(lv.awaiting):  # still awaiting = its user message never appeared in the log
                if p.delivered_at and now - p.delivered_at > DELIVERY_CONFIRM_S:
                    lv.awaiting.remove(p)
                    lv.state.busy = False
                    self.broadcast({"t": "done", "sessionId": sid, "sendId": p.send_id, "text": "", "error": "终端没有确认收到这条消息（会话日志里没有出现）", "route": "terminal"})
                    self._status(sid)

    # ——— sending ———
    def check_native(self, sid: str, b: dict[str, Any]) -> None:
        """Refuse to resume a session whose native log is gone (``agents.NativeMissing``), or one
        that came along with a copy of the project and has not been forked here (``Copied``)."""
        lv = self._get(sid)
        copy = self.local.copies().get(sid)
        if copy is not None:
            raise Copied(sid, copy)
        fork = b.get("pendingFork")
        if fork:  # the fork's source must still be there; the session's own id is replaced by the fork
            src = fork.get("path")
            if not (src and Path(src).exists()) and agents.locate_log(b["agent"], fork.get("from"), None).path is None:
                raise agents.NativeMissing(b["agent"], fork.get("from") or "", agents.LogLookup("missing"))
            return
        try:
            agents.check_native(b["agent"], b.get("nativeId"), binding_started(b), self.store.root)
        except agents.NativeMissing as e:
            lv.native = e.public()
            self._status(sid)
            raise
        if lv.native is not None and lv.native.get("blocking"):
            lv.native = None
            self._status(sid)

    def send(self, sid: str, prompt: str, mode: str = "auto", images: tuple[str, ...] = ()) -> dict[str, Any]:
        """Say something to the session. ``how`` in the answer: ``turn`` (nothing was running: a new turn),
        ``steer`` (written into the running turn, which reads it at its next step), ``interrupt`` (the running
        turn was stopped and this starts a new one), ``queued`` (it waits for the turn to end).

        ``mode`` says what to do while a headless turn runs: ``steer`` (an error for a CLI that cannot), ``interrupt``,
        ``wait`` (the queue), or ``auto`` — steer when the CLI can, else wait: a caller that is not a person at a
        box (dispatch, the CLI's own) is not put to a choice. A terminal pane keeps its own rules (input right, busy)."""
        if mode not in SEND_MODES:
            raise ValueError(f"unknown send mode {mode!r}")
        self.ensure_started()
        b = self.binding(sid)
        if sid in self.local.copies():
            raise Copied(sid, self.local.copies()[sid])
        if not self.terms.alive(sid):
            # A live pane already holds the native session (delivery pastes into it, never starts a
            # CLI): only a headless turn needs the log check — same rule as the page's composer.
            self.check_native(sid, b)
        lv = self._get(sid)
        p = Pending(send_id=f"m-{secrets.token_hex(5)}", prompt=prompt, at=time.time(), images=images if adapters.need(b["agent"]).images else ())
        lv.last_error = None
        if self.terms.alive(sid):
            lv.pane_alive = True
            lv.pane.append(p)
            self._status(sid)
            return {"sendId": p.send_id, "route": "terminal", "how": "queued" if lv.state.busy or len(lv.pane) > 1 else "turn"}
        ad = adapters.need(b["agent"])
        turn_runs = bool(lv.running and lv.run and not lv.run.done())
        if mode == "steer" and turn_runs and (not ad.steer or lv.live_control is False):
            raise ValueError(f"{ad.name} 不能中途插话：{lv.steer_why or ad.no_steer}")
        # (a resident CLI that has not said yet that its process is up, ``live_control`` None: the words wait, none get lost)
        if turn_runs and mode in ("auto", "steer") and ad.steer and lv.live_control and lv.control is not None and not lv.interrupting:
            lv.control.send(ad.steer_line(prompt))
            self._steered(sid, lv, p)
            return {"sendId": p.send_id, "route": "headless", "how": "steer"}
        how = "turn"
        if turn_runs or lv.headless:
            how = "queued"
            if mode == "interrupt" and self.interrupt(sid):
                how = "interrupt"
                run = lv.run
                run.add_done_callback(lambda _t: self._kick(sid))
        lv.headless.append(p)
        self._kick(sid)
        self._status(sid)
        return {"sendId": p.send_id, "route": "headless", "how": how}

    def _steer_state(self, b: dict[str, Any], lv: Live) -> bool | None:
        """Whether words said now go into the turn: False for a CLI that cannot; for one that can, what the running turn said
        (None until its process is up); while idle, what the last turn found (a fallback says no)."""
        ad = adapters.get(b.get("agent")) if b else None
        if ad is None or not ad.steer:
            return False
        if lv.running:
            return lv.live_control
        return not lv.steer_why

    def _steered(self, sid: str, lv: Live, p: Pending) -> None:
        """The words went into the running turn: the transcript says at which step, the pages hear of it."""
        at = int(time.time() * 1000)
        text = p.prompt.split(MARKER)[0].strip()
        note = {"id": f"steer-{p.send_id}", "kind": "notice", "tone": "steer", "at": at, "afterId": lv.last_tool, "text": f"你在这里插了一句：{text}"}
        lv.items[note["id"]] = note
        changed = [note]
        self._keep_snapshot(sid, lv, changed)
        self.broadcast({"t": "transcript", "sessionId": sid, "items": [public_item(i) for i in changed]})
        self.broadcast({"t": "steered", "sessionId": sid, "sendId": p.send_id, "at": at, "afterTool": lv.last_tool, "text": text})
        self._status(sid)

    def _kick(self, sid: str) -> None:
        lv = self._get(sid)
        if lv.run is None or lv.run.done():
            lv.run = asyncio.get_running_loop().create_task(self._run_headless(sid))

    def env_for(self, sid: str, canvas_id: str | None = None) -> dict[str, str]:
        env = {"AGORA_PROJECT": str(self.store.root), "AGORA_SESSION": sid}
        try:
            env["AGORA_CANVAS"] = canvas_id or resolve_canvas(self.store, None, sid)
        except ValueError:
            pass
        return env

    async def _run_headless(self, sid: str) -> None:
        lv = self._get(sid)
        while lv.headless:
            p = lv.headless.pop(0)
            b = self.binding(sid)
            if self.terms.alive(sid):  # someone opened the terminal meanwhile
                lv.pane.append(p)
                continue
            fork = b.get("pendingFork")
            try:
                self.check_native(sid, b)
                if fork and not adapters.need(b["agent"]).can_fork_headless:
                    raise ValueError(f"{adapters.need(b['agent']).name} 只能在终端里分叉（{adapters.need(b['agent']).terminal_fork}）：点「在终端打开」，在终端里接着说")
            except (agents.NativeMissing, Copied, ValueError) as e:
                lv.last_error = str(e)
                self.broadcast({"t": "done", "sessionId": sid, "sendId": p.send_id, "text": "", "error": str(e), "route": "headless", **({"native": e.public()} if isinstance(e, agents.NativeMissing) else {})})
                self._status(sid)
                continue
            backend = self.make_backend(b["agent"])
            attach = getattr(backend, "attach_pool", None)
            if attach is not None:  # Codex / Pi: the way that takes words mid-turn keeps one process per session in this pool
                attach(self.residents)
            ad = adapters.need(b["agent"])
            lv.control = Control() if (ad.duplex or ad.steer) else None
            lv.live_control = True if ad.duplex else None
            lv.interrupting = False
            lv.last_tool = None
            lv.asked.clear()
            req = RunRequest(
                schema=None,
                system=None,
                prompt=p.prompt,
                images=p.images,
                options=ExecOptions(
                    backend=b["agent"],
                    model=b.get("model") or "",
                    effort=b.get("effort") or None,
                    session=None if fork else b.get("nativeId"),
                    new_session=not binding_started(b),
                    fork_from=(fork or {}).get("from"),
                    fork_path=(fork or {}).get("path"),
                ),
                cwd=str(self.store.root),
                env=self.env_for(sid),
                control=lv.control,
            )
            lv.activity = "启动中"
            lv.running = True
            started = time.time()
            self._status(sid)
            try:
                self._handoff(sid, p.send_id)
            except Exception as exc:  # what the hooks persist could not be written: not sent, and the session is not left "running"
                lv.running = False
                lv.activity = None
                self._end_turn(sid, lv)
                self._not_delivered(sid, lv, p, f"没能交付：{exc}", "headless")
                continue
            self.broadcast({"t": "delivered", "sessionId": sid, "sendId": p.send_id, "route": "headless"})
            result: dict[str, Any] | None = None
            try:
                async for ev in backend.run(req):
                    if ev["t"] == "start":
                        lv.activity = "思考中"
                    elif ev["t"] == "tool_use":
                        lv.activity = f"{ev.get('name')}"
                        lv.last_tool = ev.get("id")
                    elif ev["t"] == "text":
                        lv.activity = "回复中"
                    elif ev["t"] == "session" and ev.get("session") and not b.get("nativeId") and not fork and sid not in self.dropped:
                        # A CLI that names its session as it starts (Codex): the log is followed from now on, not only after the turn.
                        self.store.set_native(sid, ev["session"])
                        self.note_bind(sid, "bind")
                        b = self.binding(sid)
                    elif ev["t"] == "result":
                        result = ev
                    elif ev["t"] == "spawned":
                        self._write_marker(sid, ev)
                        continue
                    elif ev["t"] == "resident":
                        lv.live_control = bool(ev.get("ok"))
                        lv.steer_why = None if ev.get("ok") else str(ev.get("why") or "常驻进程起不来")
                        self._status(sid)
                        continue
                    elif ev["t"] == "mode":
                        lv.mode = ev["mode"]
                        self._status(sid)
                    elif ev["t"] == "request":
                        self._open_request(sid, lv, ev)
                    elif ev["t"] == "request_cancel":
                        self._close_request(sid, lv, ev["id"])
                    elif ev["t"] == "denied":
                        self._note_denied(sid, lv, ev)
                    if ev["t"] in ("start", "tool_use", "text"):
                        self._status(sid)
                    self.broadcast({"t": "run", "sessionId": sid, "sendId": p.send_id, "event": _compact(ev)})
            except asyncio.CancelledError:
                lv.activity = None
                lv.running = False
                self._end_turn(sid, lv)
                self.close_stopped_turn(sid, lv)
                self.broadcast({"t": "done", "sessionId": sid, "sendId": p.send_id, "text": "", "error": "已停止", "route": "headless"})
                self._status(sid)
                raise
            self._end_turn(sid, lv)
            if sid in self.dropped:  # trashed while the turn ran: nothing is written for it any more
                return
            native = (result or {}).get("session")
            if fork:
                if native and native != fork.get("from") and result and not result.get("error"):
                    self.adopt_fork(sid, native)
            elif native and not b.get("nativeId"):
                self.store.set_native(sid, native)
                self.note_bind(sid, "bind")
            if native and result and not result.get("error") and not self.store.gone():
                self.store.mark_started(sid)
            # Let the log catch up so the transcript shows the turn before "done".
            await asyncio.to_thread(self._follow, sid, lv)
            self._record_run(sid, lv, p.send_id, started, result)
            lv.state.busy = False
            lv.activity = None
            lv.running = False
            lv.last_error = (result or {}).get("error")
            self._status(sid)  # idle first, so a page that reacts to "done" sees the session free
            self.broadcast({
                "t": "done",
                "sessionId": sid,
                "sendId": p.send_id,
                "text": (result or {}).get("raw") or "",
                "error": (result or {}).get("error") or ("已停止" if (result or {}).get("interrupted") else None if result else "no result"),
                "usage": (result or {}).get("usage"),
                "route": "headless",
            })

    def cancel_send(self, sid: str, send_id: str) -> bool:
        """Take a message out of the queue before it was injected. False when it is already in a CLI."""
        lv = self._get(sid)
        for q in (lv.pane, lv.headless):
            for p in q:
                if p.send_id == send_id:
                    q.remove(p)
                    self._status(sid)
                    return True
        return False

    def items(self, sid: str) -> list[dict[str, Any]]:
        """The session's transcript items as of now (the native log read first)."""
        lv = self._get(sid)
        self._follow(sid, lv)
        return list(lv.items.values())

    def _not_delivered(self, sid: str, lv: Live, p: Pending, why: str, route: str) -> None:
        lv.last_error = why
        self._status(sid)
        self.broadcast({"t": "done", "sessionId": sid, "sendId": p.send_id, "text": "", "error": why, "route": route})

    def interrupt(self, sid: str) -> bool:
        """Stop the turn. A two-way CLI (Claude) is asked to: it ends the turn itself (its ``result``
        is what closes it), withdrawing whatever it had open with the person. Should it not answer
        within ``INTERRUPT_GRACE_S``, the process is stopped the hard way. Call on the event loop."""
        lv = self._get(sid)
        lv.headless.clear()
        if not (lv.run and not lv.run.done()):
            return False
        if lv.control is None or not lv.live_control:  # a process nobody can talk to (one-shot, or a resident one not up yet)
            lv.run.cancel()
            return True
        lv.interrupting = True
        lv.control.send(interrupt_request(f"i-{secrets.token_hex(4)}"))
        for rid in list(lv.requests):
            self._close_request(sid, lv, rid)
        task = lv.run
        if self._loop is not None:
            self._loop.call_later(INTERRUPT_GRACE_S, lambda: None if task.done() else task.cancel())
        return True

    # ——— what a two-way CLI asks the person ———
    def _open_request(self, sid: str, lv: Live, ev: dict[str, Any]) -> None:
        lv.requests[ev["id"]] = ev
        lv.asked.add(ev.get("toolUseId") or ev["id"])
        self._request_item(lv, ev)
        self._mark_wait(sid, lv, ev, True)
        self.broadcast({"t": "request", "sessionId": sid, "request": self.public_request(sid, ev)})
        self._status(sid)

    def _close_request(self, sid: str, lv: Live, rid: str) -> None:
        ev = lv.requests.pop(rid, None)
        if ev is None:
            return
        self._mark_wait(sid, lv, ev, False)
        self.broadcast({"t": "request_cancel", "sessionId": sid, "id": rid})
        self._status(sid)

    def _request_item(self, lv: Live, ev: dict[str, Any]) -> None:
        """The tool call a request is about, before the CLI's log has it (it writes the call when it runs): the
        transcript shows it at once, so the workstation has something to wait on. The log's own record merges in later."""
        tid = ev.get("toolUseId") or ""
        if not tid:
            return
        from server.canvas.adapters.claude import ask_text, classify
        from server.canvas.adapters.common import _full

        inp = ev.get("input") or {}
        facts = {k: v for k, v in classify(ev["tool"], inp, str(self.store.root)).items() if k != "files"}
        with self._follow_lock:
            if tid not in lv.items:
                summary = ask_text(inp) if ev["tool"] == "AskUserQuestion" else _summarize(inp)
                lv.items[tid] = {"id": tid, "kind": "tool", "at": ev["at"], "tool": {"name": ev["tool"], "input": summary, "args": _full(inp), **facts}}

    def _flag(self, lv: Live, ev: dict[str, Any], on: bool) -> dict[str, Any] | None:
        """Mark (or unmark) the tool call a request is about as "waiting for you"; the item when something changed.
        The caller holds ``_follow_lock`` — the log follower calls this while it holds it, so it must not take it."""
        it = lv.items.get(ev.get("toolUseId") or "")
        tool = it.get("tool") if it else None
        if not isinstance(tool, dict):
            return None
        native = bool(adapters.need("claude").classify(str(tool.get("name")), {}, None).get("waitsUser"))
        if on and not native and not tool.get("hostWait"):
            tool.update(waitsUser=True, hostWait=True)
        elif not on and tool.pop("hostWait", None):
            tool["waitsUser"] = native
        else:
            return None
        return it

    def _mark_wait(self, sid: str, lv: Live, ev: dict[str, Any], on: bool) -> None:
        """The tool call a request is about shows as "waiting for you" in the transcript (and so on the
        workstation), until it is answered or withdrawn. An ``AskUserQuestion`` already is one natively."""
        with self._follow_lock:
            it = self._flag(lv, ev, on)
        if it is not None:
            self.broadcast({"t": "transcript", "sessionId": sid, "items": [public_item(it)]})

    def _note_denied(self, sid: str, lv: Live, ev: dict[str, Any]) -> None:
        """Actions auto mode blocked inside the CLI: no request ever reaches the person, so say so in the conversation."""
        notes = [{"id": f"denied-{d['toolUseId'] or secrets.token_hex(4)}", "kind": "notice", "tone": "denied", "at": ev["at"], "text": f"被 auto 拦下：{d['tool']} {d['summary']}".rstrip()} for d in ev["denials"] if d["toolUseId"] not in lv.asked]
        if not notes:
            return
        with self._follow_lock:
            for n in notes:
                lv.items[n["id"]] = n
        self._keep_snapshot(sid, lv, notes)
        self.broadcast({"t": "transcript", "sessionId": sid, "items": notes})

    def _end_turn(self, sid: str, lv: Live) -> None:
        """The turn's process is gone: whatever it had open with the person went with it."""
        for rid in list(lv.requests):
            self._close_request(sid, lv, rid)
        lv.control = None
        lv.live_control = None
        lv.interrupting = False
        self._marker(sid).unlink(missing_ok=True)

    def close_stopped_turn(self, sid: str, lv: Live) -> None:
        """A turn the host stopped is over even when the CLI's log never says so (Devin's just ends after a tool
        call): its open calls end as stopped, the session is idle, and the transcript says why."""
        if not lv.state.busy and not lv.state.pending:
            return
        at = int(time.time() * 1000)
        changed: list[dict[str, Any]] = []
        for tid in list(lv.state.pending):
            it = lv.items.get(tid)
            if it is not None and isinstance(it.get("tool"), dict):
                it["endAt"] = at
                it["tool"] = {**it["tool"], "isError": True, "output": it["tool"].get("output") or "已停止"}
                changed.append(it)
        lv.state.pending.clear()
        lv.state.busy = False
        note = {"id": f"notice-{sid}-{at}", "kind": "notice", "tone": "interrupted", "at": at, "text": "这一轮被停止了：它没有做完。"}
        lv.items[note["id"]] = note
        changed.append(note)
        self._keep_snapshot(sid, lv, changed)
        self.broadcast({"t": "transcript", "sessionId": sid, "items": [public_item(i) for i in changed]})

    def public_request(self, sid: str, ev: dict[str, Any]) -> dict[str, Any]:
        """A request as the page shows it: a question (with its options) or an approval."""
        inp = ev.get("input") or {}
        ask = ev["tool"] == "AskUserQuestion"
        out: dict[str, Any] = {"id": ev["id"], "sessionId": sid, "kind": "question" if ask else "approval", "tool": ev["tool"], "toolUseId": ev.get("toolUseId"), "at": ev["at"]}
        if ask:
            out["questions"] = [
                {"question": str(q.get("question")), "header": q.get("header"), "multiSelect": bool(q.get("multiSelect")), "options": [{"label": str(o.get("label")), "description": o.get("description") or ""} for o in q.get("options") or [] if isinstance(o, dict)]}
                for q in inp.get("questions") or [] if isinstance(q, dict)
            ]
        else:
            out.update(summary=_summarize(inp), reason=ev.get("reason"), canSession=bool(ev.get("suggestions")), input=_preview(inp))
        return out

    def requests(self, sid: str) -> list[dict[str, Any]]:
        self.binding(sid)
        return [self.public_request(sid, e) for e in self._get(sid).requests.values()]

    def answer_request(self, sid: str, rid: str, answer: dict[str, Any]) -> None:
        """The person's answer to an open request: ``decision`` allow | allow_session | deny, ``message`` (why not),
        ``answers`` ({question text: option label(s)}) for a question. ValueError: the answer does not fit the
        request; KeyError: the request is not open any more (answered, withdrawn, or its turn ended)."""
        lv = self._get(sid)
        ev = lv.requests.get(rid)
        if ev is None or lv.control is None:
            raise KeyError(rid)
        decision = answer.get("decision")
        inp = ev.get("input") or {}
        if decision == "deny":
            line = deny_response(rid, answer.get("message"))
        elif decision in ("allow", "allow_session") and ev["tool"] == "AskUserQuestion":
            line = answer_response(rid, inp, answer.get("answers") or {})
        elif decision == "allow":
            line = approve_response(rid, inp, None)
        elif decision == "allow_session":
            if not ev.get("suggestions"):
                raise ValueError("这个请求没有「本会话以后都允许」的选项")
            line = approve_response(rid, inp, ev["suggestions"])
        else:
            raise ValueError(f"decision 应为 allow / allow_session / deny，收到 {decision!r}")
        lv.control.send(line)
        self._close_request(sid, lv, rid)

    # ——— a turn a restart ended ———
    def _marker(self, sid: str) -> Path:
        return self.store.run_dir / "headless" / f"{sid}.json"

    def _write_marker(self, sid: str, ev: dict[str, Any]) -> None:
        """Where this turn's CLI process is, so a server that starts later can end it if this one dies mid-turn."""
        if self.store.gone():
            return
        try:
            path = self._marker(sid)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"pid": ev["pid"], "argv": ev["argv"], "at": int(time.time() * 1000)}))
        except OSError:
            pass

    def _reap_orphans(self) -> None:
        """A turn's marker that is still there belongs to a server that died: its CLI process may still be
        waiting for an answer nobody can give. End it and record the turn as interrupted. It is never re-sent."""
        try:
            markers = sorted((self.store.run_dir / "headless").glob("*.json"))
        except OSError:
            return
        for path in markers:
            sid = path.stem
            try:
                m = json.loads(path.read_text())
            except (OSError, ValueError):
                m = {}
            path.unlink(missing_ok=True)
            _stop_process(m.get("pid"), m.get("argv"))
            at = int(m.get("at") or time.time() * 1000)
            self._get(sid).notes.append({"id": f"notice-{sid}-{at}", "kind": "notice", "tone": "interrupted", "at": int(time.time() * 1000), "text": "上一轮随服务重启中断了：它没有做完，也不会自动重来。"})
        # Resident processes (Codex / Pi) an earlier server left: stopped, and nothing is said about them — the session's next turn
        # starts a new process that resumes its thread from the CLI's own log, and no message is sent again.
        for m in self.residents.leftovers():
            _stop_process(m.get("pid"), m.get("argv"))

    # ——— terminal ———
    def open_terminal(self, sid: str, *, launch: bool, canvas_id: str | None = None) -> dict[str, Any]:
        """Blocking (tmux, terminal launch): call from a worker thread after ``ensure_started``.

        Agora's own tmux pane, with a Kitty / Terminal window attached when ``launch``."""
        b = self.binding(sid)
        lv = self._get(sid)
        if lv.running:
            raise Busy("这个会话正在无头运行一轮，结束后再在终端打开")
        if not self.terms.alive(sid):
            self.check_native(sid, b)
        argv = agents.interactive_argv(b["agent"], b.get("nativeId"), b.get("model") or None, b.get("effort") or None, new=not binding_started(b), root=self.store.root, fork=b.get("pendingFork"))
        env = {**self.env_for(sid, canvas_id), "PATH": agents.child_env()["PATH"]}
        created = self.terms.open(sid, argv, cwd=self.store.root, env=env)
        if created:
            lv.pane_since = time.time()
        lv.pane_alive = True
        launched = self.terms.launch(sid, f"Agora · {agents.NAMES[b['agent']]}") if launch else None
        self._status(sid)
        return {"created": created, "launched": launched, "attach": self.terms.attach_command(sid), "argv": argv}

    def takeover(self, sid: str) -> dict[str, Any]:
        """A person takes the pane's input: automatic delivery pauses (the queue stays) until ``give_back``."""
        self.binding(sid)
        self.terms.takeover(sid)
        self._status(sid)
        return {"inputRight": "human"}

    def give_back(self, sid: str) -> dict[str, Any]:
        """The person hands the input back: queued messages go into the pane again."""
        self.binding(sid)
        held = self.terms.give_back(sid)
        self._status(sid)
        return {"inputRight": "host", "wasHeld": held}

    def deliver_now(self, sid: str) -> dict[str, Any]:
        """The person overrides the input-right pause for the message at the head of the queue: it goes into
        the pane at the next tick, the ones behind it wait as before. (A busy CLI or one still loading still
        makes it wait: that is about the CLI, not about who holds the input.)"""
        self.binding(sid)
        lv = self._get(sid)
        if not lv.pane:
            raise ValueError("没有排队等着投递的消息")
        lv.pane[0].force = True
        self._status(sid)
        return {"sendId": lv.pane[0].send_id, "queued": len(lv.pane)}

    def close_terminal(self, sid: str) -> None:
        self.terms.kill(sid)
        lv = self._get(sid)
        lv.pane_alive, lv.pane_since = False, None
        lv.seen_window, lv.detached_at = False, None
        self._status(sid)

    # ——— identity (registry, forks) ———
    def note_bind(self, sid: str, t: str, **extra: Any) -> None:
        """Record the session's identity in the machine registry (ids, paths, titles; no content)."""
        b = self.store.read_binding(sid) or {}
        head = (self.store.read_session(sid) or ({}, ""))[0].get("session") or {}
        topic = next((d.get("topic") for d in (self.store.read_workspace_quiet() or {}).get("docs") or [] if isinstance(d, dict) and d.get("sessionId") == sid), None)
        self.local.note(
            t,
            sessionId=sid,
            agent=b.get("agent"),
            model=b.get("model"),
            effort=b.get("effort"),
            nativeId=b.get("nativeId"),
            started=b.get("started"),
            canvasId=head.get("canvasId"),
            topic=topic or None,
            logPath=(b.get("log") or {}).get("path"),
            **extra,
        )

    def fork(self, sid: str, source: dict[str, Any] | None = None) -> dict[str, Any]:
        """Continue a session here as a fork of its native session (``pendingFork``: the next run —
        a message, or the terminal — creates the new native id). For a session this copy brought
        along (``copies.json``), or — with ``source`` {agent, model, effort, nativeId} — one known
        only from the registry (another copy of the project on this machine)."""
        b = self.store.read_binding(sid)
        if b is None:
            if not source or source.get("agent") not in agents.KINDS or not source.get("nativeId"):
                raise LookupError(f"session {sid} has no agent binding here, and no source to fork was given")
            b = self.store.bind(sid, agent=source["agent"], model=source.get("model") or "", effort=source.get("effort") or "", at=int(time.time() * 1000), started=False)
            src_id = str(source["nativeId"])
        else:
            src_id = b.get("nativeId") or ""
            if not src_id:
                raise ValueError("这个会话还没有原生会话，不需要分叉")
        look = agents.locate_log(b["agent"], src_id, None)
        path = look.path or (look.candidates[0] if look.candidates else None)
        if path is None:
            raise agents.NativeMissing(b["agent"], src_id, look)
        self.store.set_fork(sid, src_id, str(path), reason="copy")
        self.local.drop_copy(sid)
        self.note_bind(sid, "rebind", reason="fork-pending", forkFrom=src_id)
        self._status(sid)
        return self.store.read_binding(sid) or {}

    def adopt_fork(self, sid: str, native_id: str) -> None:
        """The fork ran: the session now continues ``native_id`` (the old id stays in ``natives``)."""
        self.store.rebind(sid, native_id, reason="fork", started=True)
        lv = self._get(sid)
        lv.tail, lv.native = None, None
        self.note_bind(sid, "rebind", reason="fork")
        self._status(sid)

    async def forget(self, sid: str) -> bool:
        """The session was deleted: stop its headless turn, close its terminal pane
        and drop its runtime state. Returns whether a pane was closed."""
        self.dropped.add(sid)
        lv = self.live.pop(sid, None)
        if lv is not None:
            lv.headless.clear()
            lv.pane.clear()
            if lv.run and not lv.run.done():
                lv.run.cancel()
        alive = await asyncio.to_thread(self.terms.alive, sid)
        if alive:
            await asyncio.to_thread(self.terms.kill, sid)
        return alive

    def revive(self, sid: str) -> None:
        """A trashed session came back (restore): follow its native log again (the same one: the
        binding came back with it) and send pages its transcript and status."""
        self.dropped.discard(sid)
        self.live.pop(sid, None)
        lv = self._get(sid)
        self._follow(sid, lv)
        self.broadcast({"t": "transcript", "sessionId": sid, "reset": True, "items": [public_item(i) for i in list(lv.items.values())[-MAX_ITEMS:]]})
        self._status(sid)

    # ——— canvas bridge ———
    def executors(self) -> list[Subscriber]:
        """The open pages that can execute an edit, in the order requests are offered to them (executors.py)."""
        return list(executors_mod.order(s for s in self.subs if s.executor))

    def executor(self) -> Subscriber | None:
        ex = self.executors()
        return ex[0] if ex else None

    def page_state(self, sub_id: str, *, visible: bool, focused_at: float) -> bool:
        """A page says whether it is visible and when it was last focused (ms since the epoch or seconds: only the order counts)."""
        sub = next((s for s in self.subs if s.id == sub_id), None)
        if sub is None:
            return False
        sub.visible = bool(visible)
        sub.focused_at = float(focused_at or 0)
        return True

    def claim_bridge(self, rid: str, sub_id: str) -> bool:
        """A page asks to run request ``rid``. Granted to the page it is being offered to, once: a page that was
        skipped (frozen in a background tab) and wakes up later is refused, so an edit is never run twice."""
        offer = self.bridge_offers.get(rid)
        sub = next((s for s in self.subs if s.id == sub_id), None)
        if offer is None or offer["to"] != sub_id or (offer["claimed"] and offer["claimed"] != sub_id):
            return False
        if not offer["claimed"]:
            offer["claimed"] = sub_id
            offer["claim"].set()
        if sub is not None:
            sub.answered_at = time.time()
        return True

    async def bridge(self, kind: str, payload: dict[str, Any], timeout: float = BRIDGE_TIMEOUT_S, reply_s: float = executors_mod.PAGE_REPLY_S) -> dict[str, Any]:
        """Have a page execute ``kind``. The request goes to the first page in the order; if it does not take it within
        ``reply_s`` it is offered to the next, and so on, all inside ``timeout``. A page that took it is waited for —
        never replaced: its edit may already be on its canvas."""
        pages = self.executors()
        if not pages:
            raise NoPage("没有打开的 Agora 页面：改图要在页面里执行（它持有画布、做校验、记撤销）。先 `agora open`。")
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        rid = f"b-{secrets.token_hex(5)}"
        fut: asyncio.Future = loop.create_future()
        offer: dict[str, Any] = {"to": None, "claimed": None, "claim": asyncio.Event()}
        self.bridge_waits[rid] = fut
        self.bridge_offers[rid] = offer
        try:
            for i, sub in enumerate(pages):
                left = deadline - loop.time()
                if left <= 0:
                    break
                offer["to"] = sub.id
                sub.put({"t": "bridge", "rid": rid, "kind": kind, **payload})
                if sub.executor < 2:  # an old page does not claim: it runs what it is given, as before
                    offer["claimed"] = sub.id
                    offer["claim"].set()
                waiter = asyncio.ensure_future(offer["claim"].wait())
                try:
                    await asyncio.wait({waiter, fut}, timeout=left if i == len(pages) - 1 else min(reply_s, left), return_when=asyncio.FIRST_COMPLETED)
                finally:
                    waiter.cancel()
                if fut.done():
                    return fut.result()
                if offer["claimed"]:
                    try:
                        return await asyncio.wait_for(fut, max(deadline - loop.time(), 0.01))
                    except TimeoutError:
                        raise PageTookIt("页面已接手这次改图但没有回报：图上可能已经改了，先看一眼图，再决定要不要重试。") from None
                sub.failed_at = time.time()  # did not take it: behind the others until it does
                offer["to"] = None
            raise NoPage("开着的 Agora 页面都没有回应：把 Agora 的标签页切到前台再试一次。")
        finally:
            self.bridge_waits.pop(rid, None)
            self.bridge_offers.pop(rid, None)

    def bridge_result(self, rid: str, result: dict[str, Any]) -> bool:
        fut = self.bridge_waits.get(rid)
        if fut is None or fut.done():
            return False  # late: the request was given to another page, or is over
        fut.set_result(result)
        return True

    def auto_open_enabled(self) -> bool:
        return page_help.auto_open_enabled(self)

    def set_auto_open(self, on: bool) -> None:
        page_help.set_auto_open(self, on)

    async def edit(self, kind: str, payload: dict[str, Any], fallback: Callable[[], Any] | None = None) -> dict[str, Any]:
        """Have an edit done: an open page, else a page Agora opens, else the server (page_help.py)."""
        return await page_help.edit(self, kind, payload, fallback)

    async def canvas_read(self, canvas: str | None, session: str | None) -> dict[str, Any]:
        cid = resolve_canvas(self.store, canvas, session)
        got: dict[str, Any] | None = None
        if self.executor() is not None:
            try:
                got = await self.bridge("read", {"canvasId": cid}, timeout=10)
                got["source"] = "page"
            except NoPage:
                got = None
        if not got or got.get("error"):
            got = file_read(self.store, cid)
        else:
            got["scene"] = nested.annotate(self.store, cid, got["scene"], canvas_names(self.store))
        base = save_read(self.store, cid, got.pop("versions", {}))
        scene = got["scene"]
        out = {"canvas": {"id": cid, "name": got.get("name")}, "base": base, "source": got.get("source"), "scene": scene}
        # Nesting sits next to the canvas, not inside the node / arrow lists the ops refer to.
        for k in ("path", "parent"):
            if k in scene:
                out["canvas"][k] = scene.pop(k)
        return out

    async def canvas_apply(self, canvas: str | None, session: str | None, base: str, ops: list[Any], note: str | None) -> dict[str, Any]:
        read = load_read(self.store, base)
        cid = resolve_canvas(self.store, canvas or read["canvasId"], session)
        if cid != read["canvasId"]:
            raise ValueError(f"base {base} was read from canvas {read['canvasId']}, not {cid}")
        ops, layout = await graph_hub.expand(self, cid, session, ops)  # a trailing {"op": "layout"} becomes plain ops (graph_ops.py)
        plan = {"ops": ops, **({"note": note} if note else {})}

        async def by_server() -> dict[str, Any]:  # the few ops that need no page (fallback.py)
            return await asyncio.to_thread(fallback_mod.apply, self.store, cid, session, plan, read["versions"])

        done = await self.edit("apply", {"canvasId": cid, "sessionId": session, "plan": plan, "versions": read["versions"]}, by_server)
        return await graph_hub.annotate(self, cid, session, done, layout)  # …and the answer says how the diagram measures now

    async def canvas_link(self, canvas: str | None, session: str | None, links: dict[str, list[str]], clear: bool = False) -> dict[str, Any]:
        """Associate diagram elements with code paths (globs) — stored in the element's customData."""
        cid = resolve_canvas(self.store, canvas, session)
        if not isinstance(links, dict) or not links:
            raise ValueError("nothing to link: give an element and one or more globs")
        clean: dict[str, list[str]] = {}
        for el, globs in links.items():
            gs = [str(g).strip() for g in (globs or []) if str(g).strip()]
            if not gs and not clear:
                raise ValueError(f"no globs for {el!r} (use --clear to remove its paths)")
            clean[str(el)] = gs
        return await self.edit("link", {"canvasId": cid, "sessionId": session, "links": clean, "clear": clear})

    async def canvas_child(self, op: str, canvas: str | None, session: str | None, node: str | None, child: str | None, title: str | None) -> dict[str, Any]:
        """Nested canvases: ``create`` a child canvas for a node (or return the one it has),
        ``link`` an existing canvas to a node, ``unlink`` it, or ``list`` a canvas's children.
        Writes go through the page (it owns the workspace and the scenes, and records the change
        as one undoable step in the session)."""
        cid = resolve_canvas(self.store, canvas, session)
        names = canvas_names(self.store)
        if op == "list":
            return {"canvas": {"id": cid, "name": names.get(cid, cid)}, "children": nested.list_children(self.store, cid, names)}
        if op not in ("create", "link", "unlink"):
            raise ValueError(f"unknown child op {op!r}: create | link | unlink | list")
        if not node:
            raise ValueError("--node is required: the id or exact label of the node on the parent canvas")
        payload: dict[str, Any] = {"op": op, "canvasId": cid, "sessionId": session, "node": node}
        if op == "link":
            if not child:
                raise ValueError("--child is required for link: an existing canvas id or name")
            payload["child"] = resolve_canvas(self.store, child, None)
            if nested.descendants(payload["child"], nested.scenes(self.store)) & {cid} or payload["child"] == cid:
                raise ValueError(f"linking {payload['child']} under {cid} would make a loop")
        if op == "create" and title:
            payload["title"] = title.strip()[:80]
        return await self.edit("child", payload)

    async def canvas_anim(self, canvas: str | None, session: str | None, script: Any) -> dict[str, Any]:
        cid = resolve_canvas(self.store, canvas, session)
        errors = schemas.validate(schemas.load("anim.schema.json"), script)
        if errors:
            return {"status": "invalid", "errors": errors[:12]}
        return await self.edit("anim", {"canvasId": cid, "sessionId": session, "script": script})


def _summarize(inp: dict[str, Any]) -> str:
    from server.canvas.adapters.common import _summary

    return _summary(inp)


def _preview(inp: dict[str, Any]) -> dict[str, Any]:
    """A request's tool input for the page: long strings cut."""
    return {k: (v[:PREVIEW] if isinstance(v, str) else v) for k, v in inp.items()}


def _stop_process(pid: Any, argv: Any) -> None:
    """End a leftover CLI turn and its whole tree — only when the pid still runs the command that was recorded (pids are reused)."""
    if not isinstance(pid, int) or pid <= 1 or not isinstance(argv, list):
        return
    if proctree.command(pid) != " ".join(argv):
        return
    proctree.stop(pid)


def binding_started(b: dict[str, Any]) -> bool:
    """Whether the native session already exists. Bindings written before this flag existed
    count as started: resuming one whose log is gone must not silently start a new one."""
    return b.get("started", True) is not False


def _compact(ev: dict[str, Any]) -> dict[str, Any]:
    """Run events for the page's activity line (inputs and outputs trimmed)."""
    out = {k: v for k, v in ev.items() if k not in ("prompt", "raw", "input", "text")}
    if "text" in ev:
        out["text"] = str(ev["text"])[:400]
    if "input" in ev:
        out["input"] = json.dumps(ev["input"], ensure_ascii=False)[:400]
    return out
