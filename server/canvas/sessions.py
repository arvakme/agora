"""Agent sessions for one project: each Agora session is one native Pi / Claude Code /
Codex session. This hub routes messages to it, follows its log, runs its terminal pane,
and bridges canvas commands (``agora canvas …``) to the open page.

Routing a message (``send``):

- a terminal pane holds the session → deliver into the pane (bracketed paste + Enter),
  held while the agent is still answering or someone typed in the terminal within
  ``TYPING_HOLD_S``;
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
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from server.canvas import agents, schemas
from server.canvas.model_view import model_view, versions
from server.canvas.project import ProjectStore
from server.canvas.runner import ExecOptions, RunRequest, make_backend
from server.canvas.terminal import TerminalError, Terminals
from server.canvas.transcript import MARKER, State, Tail, project, split_agora

TICK_S = 0.4
TYPING_HOLD_S = 4.0
DELIVERY_CONFIRM_S = 30.0
BRIDGE_TIMEOUT_S = 25.0
MAX_ITEMS = 1500
PREVIEW = 4000  # tool args / output characters pushed to the page; the rest on request
READS_KEPT = 64


class NoPage(RuntimeError):
    """A write needs an open Agora page (it owns the live scene) and none is connected."""


class Busy(RuntimeError):
    pass


def agora_prompt(body: str, *, canvas_id: str | None, canvas_name: str | None, extra: str = "") -> str:
    """What Agora sends: the person's words, then a context footer (hidden in the transcript)."""
    where = f"画布「{canvas_name or canvas_id}」(canvas={canvas_id})" if canvas_id else "这个项目的画布"
    footer = f"{MARKER} 来自 Agora · {where}。读图、改图、做动画用 agora-canvas skill（`agora canvas …`）。{extra}".rstrip()
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
    return {"canvasId": canvas_id, "name": canvas_names(store).get(canvas_id, canvas_id), "scene": model_view(elements), "versions": versions(elements), "source": "file"}


def save_read(store: ProjectStore, canvas_id: str, vers: dict[str, str]) -> str:
    """Remember the element versions a read saw; the token becomes ``apply --base``."""
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


class Subscriber:
    def __init__(self) -> None:
        self.q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=2000)
        self.at = time.time()
        self.executor = False

    def put(self, ev: dict[str, Any]) -> None:
        try:
            self.q.put_nowait(ev)
        except asyncio.QueueFull:
            pass


class AgentHub:
    def __init__(self, store: ProjectStore, *, terminals: Terminals | None = None, backend_factory=make_backend) -> None:
        self.store = store
        self.terms = terminals or Terminals(store.root, store.run_dir)
        self.make_backend = backend_factory
        self.live: dict[str, Live] = {}
        self.subs: list[Subscriber] = []
        self.bridge_waits: dict[str, asyncio.Future] = {}
        self._loop_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._follow_lock = threading.Lock()

    # ——— lifecycle ———
    def ensure_started(self) -> None:
        self._loop = asyncio.get_running_loop()
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = self._loop.create_task(self._run_loop())

    async def close(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
        for lv in self.live.values():
            if lv.run and not lv.run.done():
                lv.run.cancel()

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
        if self._loop is not None and running is not self._loop:
            self._loop.call_soon_threadsafe(self._fanout, ev)
        else:
            self._fanout(ev)

    def _fanout(self, ev: dict[str, Any]) -> None:
        for s in list(self.subs):
            s.put(ev)

    def subscribe(self, executor: bool) -> Subscriber:
        self.ensure_started()
        sub = Subscriber()
        sub.executor = executor
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
            "running": lv.running,
            "busy": lv.state.busy,
            "queued": len(lv.headless) + len(lv.pane),
            "held": lv.held,
            "activity": lv.activity,
            "error": lv.last_error,
            "terminal": {"alive": lv.pane_alive, "attach": self.terms.attach_command(sid), "clients": self.terms.clients(sid) if lv.pane_alive else 0},
        }

    def _status(self, sid: str) -> None:
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
            for it in self._load_runs(sid):
                lv.items[it["id"]] = it
        if not b or not b.get("nativeId"):
            return
        lv.state.root = str(self.store.root)
        if lv.tail is None:
            path = agents.find_log(b["agent"], b["nativeId"])
            if path is None:
                return
            lv.tail = Tail(path)
        recs = lv.tail.read()
        if not recs:
            return
        changed: list[dict[str, Any]] = []
        for rec in recs:
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
                    self.broadcast({"t": "done", "sessionId": sid, "sendId": done.send_id, "text": tc.get("text") or "", "error": tc.get("error"), "route": "terminal"})
        while len(lv.items) > MAX_ITEMS * 2:
            lv.items.popitem(last=False)
        if changed:
            latest = {i["id"]: i for i in changed}  # a call and its result in one read: send the merged item once
            self.broadcast({"t": "transcript", "sessionId": sid, "items": [public_item(i) for i in latest.values()]})
        self._status(sid)

    def item(self, sid: str, item_id: str) -> dict[str, Any]:
        """One transcript item in full (tool args and output past the preview)."""
        lv = self._get(sid)
        self._follow(sid, lv)
        it = lv.items.get(item_id)
        if it is None:
            raise LookupError(f"no item {item_id} in session {sid}")
        return it

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
        if not isinstance(usage, dict):
            return
        it = {"id": f"run-{send_id}", "kind": "run", "at": int(time.time() * 1000), "startAt": int(started * 1000), "usage": usage}
        with self._follow_lock:
            lv.items[it["id"]] = it
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
                self._status(sid)
            # Codex assigns its id when the interactive session starts: adopt the new rollout.
            if b["agent"] == "codex" and not b.get("nativeId") and lv.pane_since:
                taken = {x.get("nativeId") for x in bound.values()}
                for tid, _ in agents.codex_rollouts_since(self.store.root, lv.pane_since):
                    if tid not in taken:
                        self.store.set_native(sid, tid)
                        self._status(sid)
                        break
            self._follow(sid, lv)

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
            reason = None
            if lv.state.busy:
                reason = "agent 正在回复，回复完再投递"
            else:
                last = await asyncio.to_thread(self.terms.last_input, sid)
                if last is not None and time.time() - last < TYPING_HOLD_S:
                    reason = "终端里有人在输入，停下几秒后投递"
            if reason:
                if reason != lv.held:
                    lv.held = reason
                    self._status(sid)
                continue
            lv.held = None
            try:
                await asyncio.to_thread(self.terms.paste, sid, head.prompt)
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
    def send(self, sid: str, prompt: str) -> dict[str, Any]:
        self.ensure_started()
        self.binding(sid)
        lv = self._get(sid)
        p = Pending(send_id=f"m-{secrets.token_hex(5)}", prompt=prompt, at=time.time())
        lv.last_error = None
        if self.terms.alive(sid):
            lv.pane_alive = True
            lv.pane.append(p)
            route = "terminal"
        else:
            lv.headless.append(p)
            route = "headless"
            self._kick(sid)
        self._status(sid)
        return {"sendId": p.send_id, "route": route}

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
            backend = self.make_backend(b["agent"])
            req = RunRequest(
                schema=None,
                system=None,
                prompt=p.prompt,
                options=ExecOptions(backend=b["agent"], model=b.get("model") or "", effort=b.get("effort") or None, session=b.get("nativeId")),
                cwd=str(self.store.root),
                env=self.env_for(sid),
            )
            lv.activity = "启动中"
            lv.running = True
            started = time.time()
            self._status(sid)
            self.broadcast({"t": "delivered", "sessionId": sid, "sendId": p.send_id, "route": "headless"})
            result: dict[str, Any] | None = None
            try:
                async for ev in backend.run(req):
                    if ev["t"] == "start":
                        lv.activity = "思考中"
                    elif ev["t"] == "tool_use":
                        lv.activity = f"{ev.get('name')}"
                    elif ev["t"] == "text":
                        lv.activity = "回复中"
                    elif ev["t"] == "result":
                        result = ev
                    if ev["t"] in ("start", "tool_use", "text"):
                        self._status(sid)
                    self.broadcast({"t": "run", "sessionId": sid, "sendId": p.send_id, "event": _compact(ev)})
            except asyncio.CancelledError:
                lv.activity = None
                lv.running = False
                self.broadcast({"t": "done", "sessionId": sid, "sendId": p.send_id, "text": "", "error": "已停止", "route": "headless"})
                self._status(sid)
                raise
            native = (result or {}).get("session")
            if native and not b.get("nativeId"):
                self.store.set_native(sid, native)
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
                "error": (result or {}).get("error") or (None if result else "no result"),
                "usage": (result or {}).get("usage"),
                "route": "headless",
            })

    def interrupt(self, sid: str) -> bool:
        lv = self._get(sid)
        lv.headless.clear()
        if lv.run and not lv.run.done():
            lv.run.cancel()
            return True
        return False

    # ——— terminal ———
    def open_terminal(self, sid: str, *, launch: bool, canvas_id: str | None = None) -> dict[str, Any]:
        """Blocking (tmux, terminal launch): call from a worker thread after ``ensure_started``."""
        b = self.binding(sid)
        lv = self._get(sid)
        if lv.running:
            raise Busy("这个会话正在无头运行一轮，结束后再在终端打开")
        argv = agents.interactive_argv(b["agent"], b.get("nativeId"), b.get("model") or None, b.get("effort") or None)
        created = self.terms.open(sid, argv, cwd=self.store.root, env={**self.env_for(sid, canvas_id), "PATH": agents.child_env()["PATH"]})
        if created:
            lv.pane_since = time.time()
        lv.pane_alive = True
        launched = self.terms.launch(sid, f"Agora · {agents.NAMES[b['agent']]}") if launch else None
        self._status(sid)
        return {"created": created, "launched": launched, "attach": self.terms.attach_command(sid), "argv": argv}

    def close_terminal(self, sid: str) -> None:
        self.terms.kill(sid)
        lv = self._get(sid)
        lv.pane_alive, lv.pane_since = False, None
        self._status(sid)

    # ——— canvas bridge ———
    def executor(self) -> Subscriber | None:
        ex = [s for s in self.subs if s.executor]
        return max(ex, key=lambda s: s.at) if ex else None

    async def bridge(self, kind: str, payload: dict[str, Any], timeout: float = BRIDGE_TIMEOUT_S) -> dict[str, Any]:
        sub = self.executor()
        if sub is None:
            raise NoPage("没有打开的 Agora 页面：改图要在页面里执行（它持有画布、做校验、记撤销）。先 `agora open`。")
        rid = f"b-{secrets.token_hex(5)}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.bridge_waits[rid] = fut
        sub.put({"t": "bridge", "rid": rid, "kind": kind, **payload})
        try:
            return await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            raise NoPage(f"页面 {timeout:.0f}s 内没有回应（页面可能在后台或已关闭）") from None
        finally:
            self.bridge_waits.pop(rid, None)

    def bridge_result(self, rid: str, result: dict[str, Any]) -> bool:
        fut = self.bridge_waits.get(rid)
        if fut is None or fut.done():
            return False
        fut.set_result(result)
        return True

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
        base = save_read(self.store, cid, got.pop("versions", {}))
        return {"canvas": {"id": cid, "name": got.get("name")}, "base": base, "source": got.get("source"), "scene": got["scene"]}

    async def canvas_apply(self, canvas: str | None, session: str | None, base: str, ops: list[Any], note: str | None) -> dict[str, Any]:
        read = load_read(self.store, base)
        cid = resolve_canvas(self.store, canvas or read["canvasId"], session)
        if cid != read["canvasId"]:
            raise ValueError(f"base {base} was read from canvas {read['canvasId']}, not {cid}")
        return await self.bridge("apply", {"canvasId": cid, "sessionId": session, "plan": {"ops": ops, **({"note": note} if note else {})}, "versions": read["versions"]})

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
        return await self.bridge("link", {"canvasId": cid, "sessionId": session, "links": clean, "clear": clear})

    async def canvas_anim(self, canvas: str | None, session: str | None, script: Any) -> dict[str, Any]:
        cid = resolve_canvas(self.store, canvas, session)
        errors = schemas.validate(schemas.load("anim.schema.json"), script)
        if errors:
            return {"status": "invalid", "errors": errors[:12]}
        return await self.bridge("anim", {"canvasId": cid, "sessionId": session, "script": script})


def _compact(ev: dict[str, Any]) -> dict[str, Any]:
    """Run events for the page's activity line (inputs and outputs trimmed)."""
    out = {k: v for k, v in ev.items() if k not in ("prompt", "raw", "input", "text")}
    if "text" in ev:
        out["text"] = str(ev["text"])[:400]
    if "input" in ev:
        out["input"] = json.dumps(ev["input"], ensure_ascii=False)[:400]
    return out


def terminals_for(root: Path) -> Terminals:
    return Terminals(root, root / ".agora" / "run")
