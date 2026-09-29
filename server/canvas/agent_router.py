"""``/api/agent``: agent sessions (bind, send, terminal), the page event stream, and the
canvas bridge the ``agora canvas`` CLI talks to. Business rules live in sessions.py."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from server.canvas import adapters, agents, nested
from server.canvas.project import Gone, Locked
from server.canvas.sessions import AgentHub, Busy, Copied, NoPage, agora_prompt, canvas_names
from server.canvas.terminal import TerminalError


class Bind(BaseModel):
    agent: str
    model: str = ""
    effort: str = ""
    nativeId: str | None = None
    # Undoing a delete: whether that native session had already started (None: it did if nativeId is given).
    started: bool | None = None


class Fork(BaseModel):
    # {agent, model, effort, nativeId}: a session known only from the registry (no binding here yet).
    source: dict[str, Any] | None = None


class Send(BaseModel):
    text: str
    canvasId: str | None = None
    # Extra context line for the footer (e.g. which comment thread this came from).
    context: str = ""
    raw: bool = False  # send text as-is (no Agora footer)


class Term(BaseModel):
    launch: bool = True
    canvasId: str | None = None


class CanvasCall(BaseModel):
    canvas: str | None = None
    session: str | None = None
    base: str | None = None
    ops: list[Any] | None = None
    note: str | None = None
    script: Any = None
    links: dict[str, list[str]] | None = None
    clear: bool = False
    op: str | None = None
    node: str | None = None
    child: str | None = None
    title: str | None = None


def create_agent_router(hub: AgentHub) -> APIRouter:
    router = APIRouter()
    store = hub.store

    def fail(e: Exception):
        if isinstance(e, Gone):
            return JSONResponse(status_code=410, content={"gone": True, "error": str(e)})
        if isinstance(e, Locked):
            return JSONResponse(status_code=409, content={"error": str(e), "locked": True})
        if isinstance(e, Busy):
            return JSONResponse(status_code=409, content={"error": str(e)})
        if isinstance(e, agents.NativeMissing):
            return JSONResponse(status_code=409, content={"error": str(e), "nativeMissing": True, "native": e.public()})
        if isinstance(e, Copied):
            return JSONResponse(status_code=409, content={"error": str(e), "copied": True, "copy": e.info})
        if isinstance(e, NoPage):
            return JSONResponse(status_code=503, content={"error": str(e), "noPage": True})
        if isinstance(e, LookupError):
            return JSONResponse(status_code=404, content={"error": str(e)})
        if isinstance(e, (ValueError, TerminalError)):
            return JSONResponse(status_code=400, content={"error": str(e)})
        raise e

    @router.get("/catalog")
    async def catalog():
        return await asyncio.to_thread(agents.catalog, store.root)

    @router.get("/adapters")
    async def adapter_list(catalog: int = 0, versions: int = 1):
        """``AgentInfo[]`` (web/src/session/agents.ts): every CLI Agora has an adapter for, its tier
        and capabilities; ``catalog=1`` adds the session agents' model catalogs, ``versions=0`` skips
        ``--version`` (cached 10 minutes)."""

        def build() -> list[dict]:
            from server.canvas.adapters import drift

            # Drift is notify-only: ``degraded`` says what the tier would drop to and why; nothing is enforced.
            return drift.adapter_infos(store.root, with_versions=bool(versions), with_catalog=bool(catalog))

        return await asyncio.to_thread(build)

    @router.get("/runs")
    async def agent_runs(session: str | None = None, kind: str | None = None, native: str | None = None, depth: str = "all", canvas: str | None = None, items: int = 0):
        """The run tree of a session (web/docs/cli-adapters.md §7): the session and its native
        sub-agents, each with a timeline. ``session=<sid>`` for an
        Agora session, or ``kind=<cli>&native=<id>`` for any native session Agora can read. ``depth``:
        levels to expand (default ``all``; each run carries ``descendants`` for folding);
        ``canvas=<id>`` adds the canvas node each segment's file maps to; ``items=1`` adds each run's
        transcript items."""
        from server.canvas.adapters import runs as runs_mod
        from server.canvas.adapters.base import NativeRef, valid_id
        from server.canvas.adapters.common import worktrees
        from server.canvas.project import ID_RE

        if canvas is not None and not ID_RE.match(canvas):  # the store's own canvas-id rule
            return JSONResponse(status_code=400, content={"error": "invalid canvas id"})
        if session:
            b = store.read_binding(session)
            if b is None:
                return JSONResponse(status_code=404, content={"error": f"no agent binding for session {session}"})
            k, nid = b["agent"], b.get("nativeId")
        elif kind and native:
            k, nid = kind, native
            if not valid_id(nid):  # never a path: "/", "..", glob characters are refused
                return JSONResponse(status_code=400, content={"error": "invalid native id"})
        else:
            return JSONResponse(status_code=400, content={"error": "give session=<sid>, or kind=<cli>&native=<id>"})
        if adapters.get(k) is None:
            return JSONResponse(status_code=400, content={"error": f"no adapter for {k!r}"})
        if not nid:
            return JSONResponse(status_code=409, content={"error": "this session has no native session yet (it never ran)"})
        d = None if depth == "all" or not depth.isdigit() else max(0, int(depth))

        def build() -> dict | JSONResponse:
            hint = ((store.read_binding(session) or {}).get("log") or {}).get("path") if session else None
            if not session:
                # Only this project's sessions (its root or one of its worktrees), never any log on the machine.
                roots = list(dict.fromkeys([str(store.root), *worktrees(str(store.root))]))
                mine = {r["nativeId"]: r["path"] for r in adapters.need(k).sessions_for(roots) if r.get("nativeId") == nid}
                if nid not in mine:
                    return JSONResponse(status_code=404, content={"error": f"no {k} session {nid} in this project"})
                look = agents.LogLookup("found", Path(mine[nid]), (Path(mine[nid]),))
            else:
                look = agents.locate_log(k, nid, store.root, hint=hint)
            path = look.path or (look.candidates[0] if look.candidates else None)
            ref = NativeRef(k, nid, path, str(store.root))
            return runs_mod.build(ref, root=str(store.root), session_id=session, depth=d, store=store, canvas=canvas, with_items=bool(items))

        return await asyncio.to_thread(build)

    @router.put("/sessions/{sid}")
    async def bind(sid: str, body: Bind):
        try:
            # A new binding's model must be one the agent may run (Pi: its enabledModels scope) and
            # its effort one that model really takes (the CLI's own catalog, agent_models.py); an
            # existing binding is only ever confirmed or refused (409).
            # A binding that carries a native id restores or imports a session that already exists
            # with the model it ran with: the current catalog (Pi's enabledModels, a model the CLI
            # no longer lists) must not refuse it and lose the link to the native session.
            if store.read_binding(sid) is None and not body.nativeId:
                await asyncio.to_thread(agents.check_binding, body.agent, body.model, body.effort, store.root)
            b = store.bind(sid, agent=body.agent, model=body.model, effort=body.effort, native_id=body.nativeId, at=int(time.time() * 1000), started=body.started)
        except Exception as e:
            return fail(e)
        # Claude and Pi accept the id up front (``assigns_id == "agora"``); Codex assigns its own on the first run.
        if not b.get("nativeId") and adapters.need(body.agent).assigns_id == "agora":
            import uuid

            b = store.set_native(sid, str(uuid.uuid4()), reason="bind")
        await asyncio.to_thread(hub.note_bind, sid, "import" if body.nativeId else "bind")
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
            pid = str(store.info().get("id") or "")
            prompt = body.text if body.raw else agora_prompt(body.text, canvas_id=body.canvasId, canvas_name=names.get(body.canvasId or ""), extra=body.context, session_id=sid, project_id=pid)
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

    @router.post("/sessions/{sid}/fork")
    async def fork(sid: str, body: Fork):
        """Continue here as a fork: a session this copy of the project brought along, or (with a
        source) one another copy on this machine owns. The next message or terminal forks it."""
        try:
            b = await asyncio.to_thread(hub.fork, sid, body.source)
        except Exception as e:
            return fail(e)
        hub.ensure_started()
        return b

    @router.get("/sessions/{sid}/summary")
    async def summary(sid: str):
        """The lost conversation as a message to start a new native session with (the page lets the person edit it)."""
        try:
            return {"text": await asyncio.to_thread(hub.summary, sid)}
        except Exception as e:
            return fail(e)

    @router.post("/sessions/{sid}/restart")
    async def restart(sid: str):
        """The native log is gone: the next message starts a new native session for this Agora session."""
        try:
            b = await asyncio.to_thread(hub.restart, sid)
        except Exception as e:
            return fail(e)
        hub.ensure_started()
        return b

    @router.post("/sessions/{sid}/interrupt")
    def interrupt(sid: str):
        return {"stopped": hub.interrupt(sid)}

    @router.post("/sessions/{sid}/terminal")
    async def open_terminal(sid: str, body: Term):
        hub.ensure_started()
        try:
            return await asyncio.to_thread(hub.open_terminal, sid, launch=body.launch, canvas_id=body.canvasId)
        except Exception as e:
            return fail(e)

    @router.get("/terminals")
    async def terminals():
        """Where「在终端打开」can open: Kitty / macOS Terminal on this machine."""
        return {"kitty": hub.terms.kitty() is not None}

    @router.post("/sessions/{sid}/takeover")
    async def takeover(sid: str):
        """A person takes the pane's input over: automatic delivery pauses, the queue stays. Detaching
        does not give it back; ``/return`` does."""
        try:
            return await asyncio.to_thread(hub.takeover, sid)
        except Exception as e:
            return fail(e)

    @router.post("/sessions/{sid}/return")
    async def give_back(sid: str):
        try:
            return await asyncio.to_thread(hub.give_back, sid)
        except Exception as e:
            return fail(e)

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
        index = nested.parent_index(nested.scenes(store))
        return {
            "canvases": [{"id": i, "name": n, **({"parent": index[i][0], "parentNode": index[i][1]} if i in index else {})} for i, n in names.items()],
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

    @router.post("/canvas/child")
    async def canvas_child(body: CanvasCall):
        try:
            return await hub.canvas_child(body.op or "list", body.canvas, body.session, body.node, body.child, body.title)
        except Exception as e:
            return fail(e)

    @router.post("/canvas/anim")
    async def canvas_anim(body: CanvasCall):
        try:
            return await hub.canvas_anim(body.canvas, body.session, body.script)
        except Exception as e:
            return fail(e)

    return router
