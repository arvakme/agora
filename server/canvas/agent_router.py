"""``/api/agent``: agent sessions (bind, send, terminal), the page event stream, and the
canvas bridge the ``agora canvas`` CLI talks to. Business rules live in sessions.py."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from server.canvas import agents
from server.canvas.project import Locked
from server.canvas.sessions import AgentHub, Busy, NoPage, agora_prompt, canvas_names
from server.canvas.terminal import TerminalError


class Bind(BaseModel):
    agent: str
    model: str = ""
    effort: str = ""
    nativeId: str | None = None


class Send(BaseModel):
    text: str
    canvasId: str | None = None
    # Extra context line for the footer (e.g. which comment thread this came from).
    context: str = ""
    raw: bool = False  # send text as-is (no Agora footer)


class Term(BaseModel):
    launch: bool = True
    canvasId: str | None = None
    app: Literal["kitty", "seedmux"] | None = None


class CanvasCall(BaseModel):
    canvas: str | None = None
    session: str | None = None
    base: str | None = None
    ops: list[Any] | None = None
    note: str | None = None
    script: Any = None
    links: dict[str, list[str]] | None = None
    clear: bool = False


def create_agent_router(hub: AgentHub) -> APIRouter:
    router = APIRouter()
    store = hub.store

    def fail(e: Exception):
        if isinstance(e, Locked):
            return JSONResponse(status_code=409, content={"error": str(e), "locked": True})
        if isinstance(e, Busy):
            return JSONResponse(status_code=409, content={"error": str(e)})
        if isinstance(e, NoPage):
            return JSONResponse(status_code=503, content={"error": str(e), "noPage": True})
        if isinstance(e, LookupError):
            return JSONResponse(status_code=404, content={"error": str(e)})
        if isinstance(e, (ValueError, TerminalError)):
            return JSONResponse(status_code=400, content={"error": str(e)})
        raise e

    @router.get("/catalog")
    async def catalog():
        return await asyncio.to_thread(agents.catalog)

    @router.put("/sessions/{sid}")
    async def bind(sid: str, body: Bind):
        try:
            b = store.bind(sid, agent=body.agent, model=body.model, effort=body.effort, native_id=body.nativeId, at=int(time.time() * 1000))
        except Exception as e:
            return fail(e)
        # Claude and Pi accept the id up front; Codex assigns its own on the first run.
        if not b.get("nativeId") and body.agent in ("claude", "pi"):
            import uuid

            b = store.set_native(sid, str(uuid.uuid4()))
        # The terminal CLI finds the canvas skill in the project (Pi also gets --skill).
        try:
            await asyncio.to_thread(agents.install_skill, store.root, [body.agent])
        except OSError:
            pass
        hub.ensure_started()
        hub.broadcast(hub.status(sid))
        return b

    @router.get("/sessions/{sid}")
    async def get_session(sid: str):
        b = store.read_binding(sid)
        if b is None:
            raise HTTPException(404, "no agent binding")
        return hub.status(sid)

    @router.post("/sessions/{sid}/send")
    async def send(sid: str, body: Send):
        if not body.text.strip():
            raise HTTPException(400, "empty message")
        try:
            names = canvas_names(store)
            prompt = body.text if body.raw else agora_prompt(body.text, canvas_id=body.canvasId, canvas_name=names.get(body.canvasId or ""), extra=body.context)
            return hub.send(sid, prompt)
        except Exception as e:
            return fail(e)

    @router.get("/sessions/{sid}/items/{item_id}")
    async def get_item(sid: str, item_id: str):
        """A transcript item in full: tool args and output past the preview the page got."""
        try:
            return await asyncio.to_thread(hub.item, sid, item_id)
        except Exception as e:
            return fail(e)

    @router.post("/sessions/{sid}/interrupt")
    def interrupt(sid: str):
        return {"stopped": hub.interrupt(sid)}

    @router.post("/sessions/{sid}/terminal")
    async def open_terminal(sid: str, body: Term):
        hub.ensure_started()
        try:
            return await asyncio.to_thread(hub.open_terminal, sid, launch=body.launch, canvas_id=body.canvasId, app=body.app)
        except Exception as e:
            return fail(e)

    @router.get("/terminals")
    async def terminals():
        """Where「在终端打开」can open: Kitty / macOS Terminal on this machine, and Seedmux's bridge."""
        smx = await asyncio.to_thread(hub.terms.seedmux_status)
        return {"kitty": hub.terms.kitty() is not None, "seedmux": smx}

    @router.delete("/sessions/{sid}/terminal")
    async def close_terminal(sid: str):
        hub.ensure_started()
        await asyncio.to_thread(hub.close_terminal, sid)
        return {"ok": True}

    @router.get("/events")
    async def events(request: Request, executor: int = 0):
        sub = hub.subscribe(bool(executor))

        async def stream():
            try:
                yield f"data: {json.dumps({'t': 'hello', 'at': int(time.time() * 1000)})}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(sub.q.get(), 15)
                        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    except TimeoutError:
                        yield ": keepalive\n\n"
            finally:
                hub.unsubscribe(sub)

        return StreamingResponse(stream(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})

    @router.post("/bridge/{rid}")
    def bridge_result(rid: str, result: dict[str, Any]):
        return {"ok": hub.bridge_result(rid, result)}

    # ——— the `agora canvas` CLI ———
    @router.get("/canvas/list")
    def canvas_list():
        names = canvas_names(store)
        bindings = store.bindings()
        return {
            "canvases": [{"id": i, "name": n} for i, n in names.items()],
            "sessions": [{"id": sid, "agent": b.get("agent"), "model": b.get("model"), "nativeId": b.get("nativeId")} for sid, b in bindings.items()],
            "page": hub.executor() is not None,
        }

    @router.post("/canvas/read")
    async def canvas_read(body: CanvasCall):
        try:
            return await hub.canvas_read(body.canvas, body.session)
        except Exception as e:
            return fail(e)

    @router.post("/canvas/apply")
    async def canvas_apply(body: CanvasCall):
        if not body.base:
            return JSONResponse(status_code=400, content={"error": "missing base: pass the `base` printed by `agora canvas read`"})
        try:
            return await hub.canvas_apply(body.canvas, body.session, body.base, body.ops or [], body.note)
        except Exception as e:
            return fail(e)

    @router.post("/canvas/link")
    async def canvas_link(body: CanvasCall):
        try:
            return await hub.canvas_link(body.canvas, body.session, body.links or {}, body.clear)
        except Exception as e:
            return fail(e)

    @router.post("/canvas/anim")
    async def canvas_anim(body: CanvasCall):
        try:
            return await hub.canvas_anim(body.canvas, body.session, body.script)
        except Exception as e:
            return fail(e)

    return router
