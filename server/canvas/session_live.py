"""The pieces of an agent session the hub (sessions.py) is built from: its live state, the pages
subscribed to it, the messages waiting to go out, and the canvas helpers shared with the
``agora canvas`` CLI. Split out of sessions.py so that file holds only ``AgentHub``."""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from server.canvas import nested
from server.canvas.model_view import model_view, versions
from server.canvas.project import ProjectStore
from server.canvas.runner import Control
from server.canvas.transcript import MARKER, State, Tail
from server.i18n import lang, tr

SIGNAL_WAIT_S = 45.0  # a CLI that reports its state has said nothing this long after its pane opened: it is most likely waiting for the person (a trust prompt)
BRIDGE_TIMEOUT_S = 25.0
PREVIEW = 4000  # tool args / output characters pushed to the page; the rest on request
READS_KEPT = 64


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
        super().__init__(tr(f"这个会话是从 {info.get('from')} 复制过来的，原来那份项目还在用它的原生会话；要在这里接着用，先「在这里分叉继续」。", f"This session was copied from {info.get('from')}, and that copy of the project still uses its native session. To keep going here, first choose “Fork here and continue”."))


def agora_prompt(body: str, *, canvas_id: str | None, canvas_name: str | None, extra: str = "", session_id: str | None = None, project_id: str | None = None) -> str:
    """What Agora sends: the person's words, then a context footer (hidden in the transcript).

    The footer's ``(canvas=… session=… project=…)`` names the canvas, the Agora session and the
    project (first 8 characters of its id), so a native log can later be matched back to the
    Agora session it belongs to even when ``.agora/sessions/`` is gone."""
    ids = " ".join(f"{k}={v}" for k, v in (("canvas", canvas_id), ("session", session_id), ("project", (project_id or "").replace("-", "")[:8] or None)) if v)
    if lang() == "en":
        where = f"canvas “{canvas_name or canvas_id}”" if canvas_id else "this project's canvas"
        footer = f"{MARKER} From Agora · {where}{f'({ids})' if ids else ''}. Use the agora skill (`agora canvas …`) to read, edit or animate the diagram. {extra}".rstrip()
    else:
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
    reports: bool = False  # the CLI in the pane was started so that it reports its state (pane_state.py)
    cli_state: str | None = None  # what it last reported: idle / running / waiting / exited; None before it has said anything
    pane_id: str = ""  # which opening of the pane this is: what a CLI's report must carry (``AGORA_PANE``), so the late word of a closed pane is not taken for the new one's
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
    window_seen: tuple[int, int, bool] | None = None  # (windows attached, writable ones, takeover) as last pushed to the page
    notes: list[dict[str, Any]] = field(default_factory=list)  # notices to show once the transcript is loaded (a turn a restart ended)

    def forget_pane(self) -> None:
        """Everything that belongs to one opening of the pane. When the pane is gone, so is all of it: the next pane
        starts from nothing, not from what the last one had seen or been told."""
        self.pane_alive, self.pane_since = False, None
        self.reports, self.cli_state, self.pane_id = False, None, ""
        self.seen_window, self.detached_at = False, None


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
        return tr("（下面是这个会话此前的对话摘要。）", "(Below is a summary of this session's conversation so far.)")
    return tr("（接着之前的讨论：原来的原生会话记录已经丢失，下面是 Agora 保存的轨迹摘要。）", "(Continuing the earlier discussion: the original native session record is lost; below is the trajectory summary Agora kept.)")


def cli_hold(state: str | None, since: float | None, now: float, *, force: bool = False) -> str | None:
    """Why a message is not pasted into a pane whose CLI reports its state (pane_state.py): None when the CLI said it is
    idle. Silence is not "ready": until the CLI speaks nothing is pasted; after ``SIGNAL_WAIT_S`` the person may say go."""
    if state == "idle":
        return None
    if state == "waiting":
        return tr("CLI 在等你在终端里确认权限，确认后再投递", "The CLI is waiting for you to approve a permission in the terminal; delivering after that")
    if state == "running":
        return tr("CLI 正在忙，空闲后再投递", "The CLI is busy; delivering when it is idle")
    if state == "exited":
        return tr("终端里的 CLI 已退出", "The CLI in the terminal has exited")
    if since is not None and now - since >= SIGNAL_WAIT_S:
        return None if force else tr("CLI 一直没有就绪：可能在等你在终端里确认（信任目录、审批提示等），确认后会自动投递；已经确认过的话点「现在送出」", "The CLI never became ready: it may be waiting for you to confirm something in the terminal (trusting the folder, an approval prompt…). It delivers on its own once you do; if you already did, click “Send now”")
    return tr("终端刚打开，等 CLI 就绪再投递", "The terminal just opened; delivering once the CLI is ready")
