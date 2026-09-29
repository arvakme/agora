"""Dispatches: session A gives a task to session B, and Agora sees whether B took it, how far it got,
and whether it handed anything back — without either CLI having to tell Agora anything but the receipt.

Deep interface (``Dispatches``): ``dispatch · reply · status · wait · interrupt · takeover / give_back ·
recover``. The state machine is ``native_protocol``'s (start, hand_off, apply, withdraw, mark_uncertain,
plan_recovery); the record format and the state it stands for are ``dispatch_store``; the only way to put a
message into a session is ``AgentHub.send`` (tmux only through terminal.py).

One dispatch, in order:

1. a record is written (``pending``) before anything is sent;
2. the message goes to B through the hub queue: one line saying where the task is, then Agora's footer
   with ``dispatch=<id>`` and the ``agora-req-<id>`` marker (``native_protocol.binding_marker``);
3. the hub calls ``_on_handoff`` right before the message is injected: ``in_flight`` is on disk before
   the CLI could have seen it, so a crash in that window is ``reconcile_first``, never a resend;
4. B's own log showing a user message that carries the marker is ``accepted`` (no ack from B needed);
   the turn's end record in that log settles the turn;
5. ``agora reply`` (B's receipt) plus the turn's end is ``done`` / ``failed`` / ``blocked``; a turn that
   ended without a receipt is ``idle_no_reply``, and a receipt that comes late still moves it;
6. A is told through the same hub queue (a comment thread gets the answer posted into it instead).

While a person holds the pane's input (terminal.py), the message just waits in the queue: the record stays
``dispatched`` and says why (``queued_because``); nothing is failed, nothing is resent.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import secrets
import threading
import time
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5

from native_protocol import (
    DeliveryRequest,
    NativeEvent,
    NativeSession,
    RequestOrigin,
    apply,
    binding_marker,
    channel_released,
    hand_off,
    mark_uncertain,
    plan_recovery,
    publishable_result,
    start,
    withdraw,
)
from server.canvas import adapters, agents
from server.canvas.dispatch_store import REPLY_STATUSES, Dispatch, DispatchStore, derive_state, is_final
from server.canvas.project import NotFound
from server.canvas.sessions import AgentHub, agora_prompt, canvas_names

NS = UUID("6f0b1e52-3a7c-4d1e-9b8a-2c5d7e9f0a13")
ADAPTER = {"claude": "claude_code", "codex": "codex", "pi": "pi", "devin": "devin", "cursor": "cursor", "grok": "grok"}
REPLY_MAX = 600  # characters of the receipt told to the source; the rest is in reply.md
PERMISSION = {
    "claude": {"mode": "headless", "detail": "claude -p: only `agora canvas|reply|dispatch` run without asking; other tools follow the user's Claude settings"},
    "codex": {"mode": "user-config", "detail": "codex exec / codex: the user's own Codex configuration"},
    "pi": {"mode": "user-config", "detail": "pi: the user's own Pi configuration"},
    "devin": {"mode": "headless", "detail": "devin -p --permission-mode dangerous: every tool runs without asking (no boundary)"},
    "cursor": {"mode": "headless", "detail": "cursor-agent -p --force: every tool runs without asking (no boundary)"},
    "grok": {"mode": "headless", "detail": "grok --always-approve: every tool runs without asking (no boundary)"},
}


class DispatchError(ValueError):
    pass


def _ms() -> int:
    return int(time.time() * 1000)


def envelope(rid: str, source_name: str, task_path: Path, scope: list[str]) -> str:
    """The one line B reads first (the task itself is in the file)."""
    where = f"范围：{'、'.join(scope)}。" if scope else ""
    return (
        f"[Agora 派发 {rid[:8]}] 来自 {source_name}：先读任务文件 {task_path}。{where}"
        f"做完后运行 `agora reply --request {rid} --status done|failed|blocked -f <你的答复文件>` 交回执（受阻用 blocked，做不了用 failed，一两句话说明）。"
    )


class Dispatches:
    def __init__(self, hub: AgentHub) -> None:
        self.hub = hub
        self.store = hub.store
        self.files = DispatchStore(hub.store.dir)
        self.lock = threading.RLock()
        self._sends: dict[str, str] = {}  # hub send id -> request id (this process only)
        self._send_of: dict[str, str] = {}  # request id -> hub send id
        # one number per request, never repeated (a record may go away, two may be made at once)
        self._seq = itertools.count(max((d.delivery.request.origin.request_seq for d in self.files.all()), default=0) + 1)
        self._notifying: set[tuple[str, str]] = set()  # (request id, state) whose note to the source is being sent
        self._open: dict[str, str] = {d.id: d.target["sessionId"] for d in self.files.all() if not is_final(derive_state(d))}  # request id -> target session, while it can still change
        hub.listeners.append(self._on_event)
        hub.handoff_hooks.append(self._on_handoff)
        hub.start_hooks.append(self.recover)

    # ——— reading ———
    def get(self, rid: str) -> Dispatch | None:
        return self.files.read(rid)

    def list(self, *, session: str | None = None, active: bool = False) -> list[dict[str, Any]]:
        out = []
        for d in self.files.all():
            if session and session not in (d.source.get("sessionId"), d.target.get("sessionId")):
                continue
            if active and is_final(derive_state(d)):
                continue
            out.append(self.summary(d))
        return out

    def summary(self, d: Dispatch) -> dict[str, Any]:
        state = derive_state(d)
        r = d.delivery
        out: dict[str, Any] = {
            "id": d.id,
            "state": state,
            "turnState": r.turn_state,
            "withdrawn": r.withdrawn,
            "source": d.source,
            "target": d.target,
            "task": d.task,
            "permission": d.permission,
            "expectsReply": d.expects_reply,
            "reply": d.reply,
            "stopped": d.stopped,
            "error": d.error,
            "createdAt": d.created_at,
            "updatedAt": d.updated_at,
            "history": d.history,
            "dir": str(self.files.folder(d.id)),
        }
        if r.result:
            out["result"] = {"outcome": r.result.outcome, "summary": r.result.summary, "published": publishable_result(r) is not None}
        if r.note:
            out["note"] = r.note
        if state == "dispatched" and r.turn_state == "pending":
            lv = self.hub.live.get(d.target["sessionId"])
            if lv is not None and lv.held:
                out["queuedBecause"] = lv.held
        return out

    def status(self, rid: str) -> dict[str, Any]:
        d = self._need(rid)
        self._take_reply_file(d)
        d = self._need(rid)
        d = self._sync(d, self.hub.items(d.target["sessionId"]))
        return self.summary(d)

    async def wait(self, rid: str, timeout: float = 600.0) -> dict[str, Any]:
        end = time.monotonic() + timeout
        while True:
            d = self._need(rid)
            self._take_reply_file(d)
            s = self.summary(self._need(rid))
            if is_final(s["state"]) or time.monotonic() >= end:
                return s
            await asyncio.sleep(1.0)

    def _need(self, rid: str) -> Dispatch:
        d = self.files.read(rid) if rid else None
        if d is None:
            raise NotFound(f"dispatch {rid}")
        return d

    # ——— dispatch ———
    async def dispatch(
        self,
        *,
        source: dict[str, Any],
        task: str,
        to: str | None = None,
        new: str | None = None,
        scope: list[str] | None = None,
        model: str = "",
        effort: str = "",
        inline: bool = False,
        expects_reply: bool = True,
        canvas_id: str | None = None,
    ) -> dict[str, Any]:
        """Hand ``task`` to session ``to``, or to a new session of agent ``new``. Returns the record's summary."""
        if not task.strip():
            raise DispatchError("empty task")
        if bool(to) == bool(new):
            raise DispatchError("give exactly one of --to <session> and --new <claude|codex|pi>")
        src_sid = source.get("sessionId")
        if src_sid and self.store.read_binding(src_sid) is None:
            raise DispatchError(f"source session {src_sid} has no agent")
        if to:
            b = self.store.read_binding(to)
            if b is None:
                raise DispatchError(f"session {to} has no agent yet")
            if b["agent"] not in agents.KINDS:
                raise DispatchError(f"{b['agent']} cannot be dispatched to (only {', '.join(agents.KINDS)})")
            sid, agent, is_new = to, b["agent"], False
        else:
            if new not in agents.KINDS:
                raise DispatchError(f"--new takes one of {', '.join(agents.KINDS)}")
            sid, agent, is_new = await asyncio.to_thread(self._new_session, new, model, effort, canvas_id or self._canvas_of(src_sid))
        if sid == src_sid:
            raise DispatchError("a session cannot dispatch to itself")
        rid = str(uuid.uuid4())
        folder = self.files.folder(rid)
        task_path = self.files.write_text(rid, "task.md", task if task.endswith("\n") else task + "\n")
        locator = sid
        name = self._name(src_sid) if src_sid else (source.get("kind") == "comment" and f"画布评论 #{source.get('threadN')}") or "你"
        body = task.strip() if inline else envelope(rid, name, task_path, scope or [])
        request = DeliveryRequest(
            request_id=UUID(rid),
            origin=RequestOrigin(room_id=uuid5(NS, self.store.info().get("id") or str(self.store.root)), request_seq=next(self._seq), requested_by=uuid5(NS, f"source:{src_sid or source.get('kind')}")),
            session=NativeSession(
                deployment=str(self.store.root),
                participant_id=uuid5(NS, f"session:{sid}"),
                computer_id=uuid5(NS, "computer:local"),
                adapter=ADAPTER[agent],
                tmux_target=self.hub.terms.name(sid),
                native_locator=locator,
            ),
            body=body,
        )
        now = _ms()
        d = Dispatch(
            id=rid,
            delivery=start(request),
            task={"summary": task.strip().splitlines()[0][:200], "scope": scope or [], "file": "task.md", "inline": inline},
            source=source,
            target={"sessionId": sid, "agent": agent, "new": is_new},
            permission=PERMISSION[agent],
            expects_reply=expects_reply,
            created_at=now,
            updated_at=now,
        )
        self._record(d)  # 1. on disk before anything is sent
        self._send(d, body, name, folder)
        if is_new and self._need(rid).error:  # the new, empty session it made for nothing does not stay behind
            self.hub.live.pop(sid, None)
            self.store.discard_session(sid)
        elif source.get("kind") == "comment" and not self._need(rid).error:
            self._bind_thread(source, sid, agent)  # the thread is now one conversation with ``sid``
        return self.summary(self._need(rid))

    def _new_session(self, agent: str, model: str, effort: str, canvas_id: str | None) -> tuple[str, str, bool]:
        sid = f"s-{secrets.token_hex(4)}"
        agents.check_binding(agent, model, effort, self.store.root)
        b = self.store.bind(sid, agent=agent, model=model, effort=effort, at=_ms())
        if not b.get("nativeId") and adapters.need(agent).assigns_id == "agora":
            self.store.set_native(sid, str(uuid.uuid4()), reason="bind")
        if canvas_id:
            # the head record in the shape the page writes (web/src/session/store.ts Session)
            self.store.append_session(sid, [{"t": "session", "session": {"id": sid, "canvasId": canvas_id, "createdAt": _ms(), "turnIds": []}}], base=None)
        self.hub.note_bind(sid, "bind")
        try:
            agents.install_skill(self.store.root, [agent])
        except OSError:
            pass
        return sid, agent, True

    def _canvas_of(self, sid: str | None) -> str | None:
        got = self.store.read_session(sid) if sid else None
        return ((got or ({}, ""))[0].get("session") or {}).get("canvasId")

    def _name(self, sid: str | None) -> str:
        b = (self.store.read_binding(sid) if sid else None) or {}
        return f"{agents.NAMES.get(b.get('agent'), '会话')} 会话 {sid}" if sid else "你"

    def _send(self, d: Dispatch, body: str, name: str, folder: Path) -> None:
        sid = d.target["sessionId"]
        pid = str(self.store.info().get("id") or "")
        cid = d.source.get("canvasId") or self._canvas_of(sid)
        extra = f"dispatch={d.id} from={d.source.get('sessionId') or d.source.get('kind')} {binding_marker(UUID(d.id))}"
        prompt = agora_prompt(body, canvas_id=cid, canvas_name=canvas_names(self.store).get(cid or ""), extra=extra, session_id=sid, project_id=pid)
        try:
            sent = self.hub.send(sid, prompt)
        except Exception as e:  # the target cannot take it at all (log gone, a copy of the project…)
            with self.lock:
                d = self._need(d.id)
                d.error = str(e)
                self._record(d)
            return
        self._sends[sent["sendId"]] = d.id
        self._send_of[d.id] = sent["sendId"]

    # ——— the hub tells us ———
    def _on_handoff(self, sid: str, send_id: str) -> None:
        rid = self._sends.get(send_id)
        if rid is None:
            return
        with self.lock:
            d = self.files.read(rid)
            if d is None or d.delivery.turn_state != "pending" or d.delivery.withdrawn:
                return
            d.delivery = hand_off(d.delivery)  # 3. persisted before the CLI can have seen the message
            self._record(d)

    def _on_event(self, ev: dict[str, Any]) -> None:
        t = ev.get("t")
        if t not in ("transcript", "done"):
            return
        if t == "done" and ev.get("outcome") == "unknown":
            self._uncertain(ev)  # a message that reached a pane but may or may not have been taken
        sid = ev.get("sessionId")
        with self.lock:  # `reply()` changes it from a worker thread
            rids = [r for r, s in self._open.items() if s == sid]
        for rid in rids:
            live = self.hub.live.get(sid)
            d = self.files.read(rid)
            if d is not None:
                self._sync(d, list(live.items.values()) if live else ev.get("items") or [])

    def _uncertain(self, ev: dict[str, Any]) -> None:
        rid = self._sends.get(ev.get("sendId") or "")
        if rid is None:
            return
        with self.lock:
            d = self.files.read(rid)
            if d is not None and d.delivery.turn_state == "in_flight" and not d.delivery.withdrawn:
                d.delivery = mark_uncertain(d.delivery, str(ev.get("error") or "the message may or may not have been taken"))
                self._record(d)

    def _sync(self, d: Dispatch, items: list[dict[str, Any]]) -> Dispatch:
        """Fold what the target's own log shows into the record: the marker (accepted), the turn's end."""
        with self.lock:
            d = self._need(d.id)
            before = d.delivery
            locator = d.delivery.request.session.native_locator
            turn = next((i for i in items if i.get("kind") == "user" and i.get("dispatch") == d.id), None)
            if turn is not None and d.delivery.bound is None:
                d.delivery = apply(d.delivery, NativeEvent(event_id=uuid5(NS, f"{d.id}:accepted"), kind="input_accepted", evidence="native_record", session=locator, turn_id=str(turn["id"]))).record
            if turn is not None and d.delivery.bound is not None:
                # The turn's end is the first end record after the marked message: the CLIs name a turn
                # differently (Codex's turn id is not the message's id), their order is the same.
                at = next(k for k, i in enumerate(items) if i is turn)
                end = next((i for i in items[at + 1 :] if i.get("kind") == "end"), None)
                if end is not None:
                    text = ""
                    for i in items[at + 1 :]:
                        if i.get("kind") == "assistant":
                            text = i.get("text") or text
                        if i is end:
                            break
                    failed = bool(end.get("error"))
                    d.delivery = apply(d.delivery, NativeEvent(event_id=uuid5(NS, f"{d.id}:end"), kind="execution_failed" if failed else "execution_completed", evidence="native_record", session=locator, turn_id=d.delivery.bound.turn, summary=(end.get("error") or text)[:4000])).record
            if d.delivery is not before:
                self._record(d)
            return d

    def _take_reply_file(self, d: Dispatch) -> None:
        """A receipt written to ``<id>/reply.status`` when the server could not be reached (agora reply)."""
        f = self.files.folder(d.id) / "reply.status"
        if not f.exists():
            return
        try:
            status = f.read_text().strip()
            f.unlink()
        except OSError:
            return
        text = self.files.read_text(d.id, "reply.md") or ""
        if status in REPLY_STATUSES:
            self.reply(d.id, status, text)

    # ——— B's receipt ———
    def reply(self, rid: str, status: str, text: str = "", session: str | None = None) -> dict[str, Any]:
        if status not in REPLY_STATUSES:
            raise DispatchError(f"--status is one of {', '.join(REPLY_STATUSES)}")
        with self.lock:
            d = self._need(rid)
            if session and session != d.target["sessionId"]:
                raise DispatchError(f"dispatch {rid[:8]} was given to session {d.target['sessionId']}, not {session}")
            self.files.write_text(rid, "reply.md", text if text.endswith("\n") or not text else text + "\n")
            d.reply = {"status": status, "at": _ms(), "summary": text.strip()[:REPLY_MAX], "file": "reply.md"}
            self._record(d)
        return self.summary(self._need(rid))

    # ——— interrupt, takeover ———
    def interrupt(self, rid: str) -> dict[str, Any]:
        """Withdraw the dispatch (it is never delivered again and its result is never published) and stop
        what can be stopped: a message still queued is taken out; a headless run is cancelled (recorded
        ``interrupted``). A turn already running in a terminal pane has no stop key here: the record says
        so (``unknown`` until that turn ends), it is not pretended to have stopped."""
        with self.lock:
            d = self._need(rid)
            if d.delivery.withdrawn:
                return self.summary(d)
            d.delivery = withdraw(d.delivery, "interrupted by the source")
            sid = d.target["sessionId"]
            handed = d.delivery.turn_state != "pending"
            send_id = self._send_of.get(rid)
            if not handed and send_id:
                self.hub.cancel_send(sid, send_id)
            elif handed and not channel_released(d.delivery):
                lv = self.hub.live.get(sid)
                if lv is not None and lv.running and self.hub.interrupt(sid):
                    d.stopped = {"at": _ms(), "how": "headless run cancelled"}
                else:
                    d.delivery = replace(d.delivery, note="the turn runs in a terminal pane: it cannot be stopped from here, its result will not be published")
            self._record(d)
        return self.summary(self._need(rid))

    def takeover(self, sid: str) -> dict[str, Any]:
        return self.hub.takeover(sid)

    def give_back(self, sid: str) -> dict[str, Any]:
        """Hand the pane back; queued dispatches go in, and any that were in flight are reconciled with the log."""
        res = self.hub.give_back(sid)
        for d in self.files.all():
            if d.target["sessionId"] == sid and d.delivery.turn_state in ("in_flight", "uncertain") and not d.delivery.withdrawn:
                self._reconcile(d)
        return res

    # ——— restart ———
    def recover(self) -> None:
        """After a restart: for every record that is not settled, ``plan_recovery`` says what may be done.
        Never a resend of anything that may have been injected."""
        for d in self.files.all():
            state = derive_state(d)
            if is_final(state):
                # ended, but the source may never have been told (a crash in between, a send that failed)
                if state != "interrupted" and d.notified != state:
                    self._notify_soon(d.id, state, restarted=True)
                continue
            action = plan_recovery(d.delivery)
            if action == "deliver":
                body = d.delivery.request.body
                self._send(d, body, self._name(d.source.get("sessionId")), self.files.folder(d.id))
            elif action in ("reconcile_first", "await_native"):
                self._reconcile(d, restarted=True)

    def _reconcile(self, d: Dispatch, restarted: bool = False) -> None:
        """Read the target's log for what the record cannot know. A turn this process did not start and whose
        end the log does not show is ``uncertain`` (never resent; a later end record in the log still settles it)."""
        d = self._sync(d, self.hub.items(d.target["sessionId"]))
        with self.lock:
            d = self._need(d.id)
            r = d.delivery
            if r.bound is None and r.turn_state in ("in_flight", "uncertain"):
                d.delivery = mark_uncertain(r, "restarted while the message may have been injected: not resent, the target's log shows no marker")
                self._record(d)
            elif restarted and r.bound is not None and r.turn_state == "accepted":
                d.delivery = mark_uncertain(r, "restarted while the turn was running: the target's log shows no end yet")
                self._record(d)

    # ——— bookkeeping ———
    def _record(self, d: Dispatch) -> None:
        """Write the record; when its state changed, note it, tell pages, and tell the source."""
        state = derive_state(d)
        d.updated_at = _ms()
        if not d.history or d.history[-1]["state"] != state:
            d.history.append({"at": d.updated_at, "state": state})
        self.files.write(d)
        if (is_final(state) and d.notified == state) or (state == "interrupted" and channel_released(d.delivery)):
            self._open.pop(d.id, None)
        else:
            self._open[d.id] = d.target["sessionId"]
        self.hub.broadcast({"t": "dispatch", "dispatch": self.summary(d)})
        if is_final(state) and d.notified != state and state != "interrupted":
            self._notify_soon(d.id, state)

    def _on_loop(self, fn) -> None:
        loop = self.hub._loop
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if loop is not None and running is not loop and not loop.is_closed():
            loop.call_soon_threadsafe(fn)
        else:
            fn()

    def _answer(self, d: Dispatch) -> str:
        if d.reply and d.reply["summary"]:
            return d.reply["summary"]
        r = publishable_result(d.delivery)
        return (r.summary if r else "").strip()

    def _notify_soon(self, rid: str, state: str, *, restarted: bool = False) -> None:
        """Tell the source on the loop, once per (dispatch, state) at a time. ``notified`` is written only
        after the note went out (``_notice``); until then the record says the source was not told."""
        with self.lock:
            if (rid, state) in self._notifying:
                return
            self._notifying.add((rid, state))
        self._on_loop(lambda: self._notice(rid, state, restarted))

    def _notice(self, rid: str, state: str, restarted: bool) -> None:
        try:
            d = self.files.read(rid)
            if d is None or d.notified == state:
                return
            try:
                if not (restarted and self._already_told(d, state)):
                    self._notify(d, state)
            except Exception as e:  # a source that cannot take the note (gone, a copy): the record says so, a restart tries once more
                with self.lock:
                    d = self.files.read(rid)
                    if d is not None:
                        d.delivery = replace(d.delivery, note=f"通知没有发出（{state}）：{e}")
                        self.files.write(d)
                return
            with self.lock:
                d = self.files.read(rid)
                if d is not None:
                    d.delivery = d.delivery if not (d.delivery.note or "").startswith("通知没有发出") else replace(d.delivery, note=None)
                    d.notified = state
                    self.files.write(d)
                    self._open.pop(rid, None)
        finally:
            with self.lock:
                self._notifying.discard((rid, state))

    def _already_told(self, d: Dispatch, state: str) -> bool:
        """The source's own log already shows this note (the server died after sending, before writing ``notified``)."""
        sid = d.source.get("sessionId")
        if d.source.get("kind") != "session" or not sid:
            return False
        try:
            items = self.hub.items(sid)
        except Exception:
            return False
        return any(i.get("kind") == "user" and i.get("receipt") == f"{d.id}:{state}" for i in items)

    def _notify(self, d: Dispatch, state: str) -> None:
        """Tell the source (raises when it cannot be told). The record is the fact; this only reaches it sooner."""
        if d.delivery.withdrawn or (d.error and d.source.get("kind") == "comment"):
            return  # (a comment that could not even be handed over is refused to the page that asked, not posted)
        target = self._name(d.target["sessionId"])
        answer = self._answer(d)
        src = d.source
        if src.get("kind") == "comment":
            self._post_thread(d, state, answer)
        elif src.get("kind") == "session" and src.get("sessionId"):
            head = {"done": "完成了", "failed": "失败了", "blocked": "受阻", "idle_no_reply": "对方这一轮结束了，但没有交回执"}.get(state, state)
            more = f"答复：{answer}" if answer else "没有答复内容"
            msg = f"[Agora 派发回执 {d.id[:8]}] 你派给 {target} 的任务：{head}。{more}（记录 {self.files.folder(d.id)}；`agora dispatch status {d.id}` 查看）（这是通知，不需要回复；有下一步再做。）"
            self.hub.send(src["sessionId"], agora_prompt(msg, canvas_id=None, canvas_name=None, extra=f"dispatch-receipt={d.id} agora-receipt-{d.id}:{state}", session_id=src["sessionId"]))

    def _bind_thread(self, src: dict[str, Any], sid: str, agent: str, *, if_absent: bool = False) -> None:
        """Write the binding into the thread's own record (``handoff``), the only place it lives; replies
        without an @ go to ``sid`` from now on, until the person ends the hand-off."""
        handoff = {"sessionId": sid, "agent": agent, "name": str(src.get("name") or f"评论 #{src.get('threadN')}")}
        try:
            data, version, _ = self.store.thread_op(src["canvasId"], {"op": "bind", "threadId": src["threadId"], "handoff": handoff, **({"ifAbsent": True} if if_absent else {})})
        except NotFound:
            return
        events = getattr(self.hub, "events", None)
        if events is not None:
            events.publish({"t": "threads", "canvasId": src["canvasId"], "data": data, "version": version})

    def _post_thread(self, d: Dispatch, state: str, answer: str) -> None:
        src = d.source
        ok = state in ("done",)
        text = answer if ok else (f"Agent 没有完成：{answer or state}" if state != "idle_no_reply" else answer or "（Agent 没有文字答复）")
        if ok and not text:
            text = "（Agent 没有文字答复）"
        msg = {
            "id": f"m-{d.id[:8]}",
            "author": "agent" if ok or state == "idle_no_reply" else "system",
            "text": text,
            "at": _ms(),
            "sessionId": d.target["sessionId"],
            **({} if ok or state == "idle_no_reply" else {"tone": "error"}),
        }
        # The page dispatches the moment it creates a thread and saves the file a little later, so the binding made at
        # send time may have found no thread: settle it now (never over an ending the person chose meanwhile).
        self._bind_thread(src, d.target["sessionId"], d.target["agent"], if_absent=True)
        try:
            data, version, _ = self.store.thread_op(src["canvasId"], {"op": "reply", "threadId": src["threadId"], "message": msg})
        except NotFound:
            return
        events = getattr(self.hub, "events", None)
        if events is not None:  # open pages take the answer in without a reload
            events.publish({"t": "threads", "canvasId": src["canvasId"], "data": data, "version": version})

    # ——— for the run tree ———
    def from_session(self, sid: str) -> list[Dispatch]:
        return [d for d in self.files.all() if d.source.get("sessionId") == sid]


def dumps(d: Any) -> str:
    return json.dumps(d, ensure_ascii=False)
