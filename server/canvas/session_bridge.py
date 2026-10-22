"""The canvas bridge half of ``AgentHub`` (sessions.py): ``agora canvas …`` commands are
forwarded to the open page that executes them (executors.py), and fall back to the project
files where a page is not needed. A mixin so sessions.py stays about routing messages."""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import Callable
from typing import Any

from server.canvas import executors as executors_mod, fallback as fallback_mod, graph_hub, nested, page_help, schemas
from server.canvas.session_live import BRIDGE_TIMEOUT_S, NoPage, PageTookIt, Subscriber, canvas_names, file_read, load_read, resolve_canvas, save_read
from server.i18n import tr


class CanvasBridge:
    """Mixed into ``AgentHub``; uses its ``store``, ``_subs``, ``broadcast`` and bridge state."""

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
            raise NoPage(tr("没有打开的 Agora 页面：改图要在页面里执行（它持有画布、做校验、记撤销）。先 `agora open`。", "No Agora page is open: edits run in the page (it holds the canvas, validates, and records undo). Run `agora open` first."))
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
                        raise PageTookIt(tr("页面已接手这次改图但没有回报：图上可能已经改了，先看一眼图，再决定要不要重试。", "A page took this edit but never reported back: the diagram may already have changed. Look at it before deciding whether to retry.")) from None
                sub.failed_at = time.time()  # did not take it: behind the others until it does
                offer["to"] = None
            raise NoPage(tr("开着的 Agora 页面都没有回应：把 Agora 的标签页切到前台再试一次。", "None of the open Agora pages answered: bring the Agora tab to the front and try again."))
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
