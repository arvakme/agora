"""Project storage API (``/api/project``) over one ``ProjectStore``, plus the per-project app
that ``agora up`` serves: this router, the canvas router (turns, animations, library) with the
project's agent defaults, the vendored libraries and the built frontend.

Writes carry ``base`` (the version the client last saw); a stale base answers 409 with the
file's current version so the UI can offer "reload" or "keep mine" (``force``).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from server.canvas.events import Events
from server.canvas.project import Conflict, NotEmpty, ProjectStore
from server.canvas.share import ShareError, ShareManager, check_max_opens, check_ttl
from server.canvas.runner import DEFAULT_BACKEND, DEFAULT_MODEL, EFFORTS, ExecOptions

REPO = Path(__file__).resolve().parents[2]
WEB = REPO / "web"


class Write(BaseModel):
    data: Any
    base: str | None = None
    force: bool = False


class Records(BaseModel):
    records: list[dict[str, Any]]
    base: str | None = None
    force: bool = False


def conflict(e: Conflict) -> JSONResponse:
    return JSONResponse(status_code=409, content={"conflict": True, "file": e.file, "current": e.current, "base": e.base})


class Merge(BaseModel):
    data: dict[str, Any]


class NewShare(BaseModel):
    canvasId: str
    ttl: int | None = None  # seconds; None = until revoked
    maxOpens: int | None = None  # distinct guests that may open it; None = unlimited


def sse(events: Events, request: Request, accept=None, *, tick: float = 15.0) -> StreamingResponse:
    sub = events.subscribe(accept)

    async def gen():
        try:
            yield f"data: {json.dumps({'t': 'hello', 'at': int(time.time() * 1000)})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(sub.q.get(), tick)
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            events.unsubscribe(sub)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})


def create_project_router(store: ProjectStore, events: Events | None = None) -> APIRouter:
    router = APIRouter()
    events = events or Events()

    def guard(f):
        try:
            return f()
        except Conflict as e:
            return conflict(e)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @router.get("")
    def info():
        return {**store.info(), "empty": store.is_empty()}

    @router.get("/health")
    def health():
        return {"ok": True, "root": str(store.root), "pid": os.getpid()}

    @router.get("/snapshot")
    def snapshot():
        return store.snapshot()

    @router.put("/workspace")
    def put_workspace(body: Write):
        return guard(lambda: {"version": store.write("workspace", None, body.data, base=body.base, force=body.force)})

    @router.put("/canvases/{id}")
    def put_canvas(id: str, body: Write):
        out = guard(lambda: {"version": store.write("canvas", id, body.data, base=body.base, force=body.force)})
        if isinstance(out, dict):
            events.publish({"t": "canvas", "canvasId": id, "version": out["version"]})
        return out

    @router.delete("/canvases/{id}")
    def delete_canvas(id: str):
        def go():
            store.delete("canvas", id)
            store.delete("threads", id)
            return {"ok": True}

        return guard(go)

    @router.put("/threads/{id}")
    def put_threads(id: str, body: Write):
        return guard(lambda: {"version": store.write("threads", id, body.data, base=body.base, force=body.force)})

    @router.post("/threads/{id}/merge")
    def merge_threads(id: str, body: Merge):
        """The owner's page saves its threads by merging (share guests write the same file)."""

        def go():
            data, version, changed = store.merge_threads(id, body.data)
            if changed:
                events.publish({"t": "threads", "canvasId": id, "data": data, "version": version})
            return {"version": version, "data": data}

        return guard(go)

    @router.get("/events")
    async def project_events(request: Request):
        """SSE for the owner's page: threads written by someone else (share guests), share changes."""
        return sse(events, request, lambda ev: ev.get("t") in ("threads", "shares"))

    @router.post("/sessions/{id}/append")
    def append_session(id: str, body: Records):
        return guard(lambda: {"version": store.append_session(id, body.records, base=body.base, force=body.force)})

    @router.put("/sessions/{id}")
    def put_session(id: str, body: Records):
        return guard(lambda: {"version": store.replace_session(id, body.records, base=body.base, force=body.force)})

    @router.delete("/sessions/{id}")
    def delete_session(id: str):
        # The agent binding goes with the log; undoing the delete re-binds (PUT /api/agent/sessions/{id}).
        return guard(lambda: (store.delete("session", id), store.delete("binding", id), {"ok": True})[2])

    @router.post("/import")
    def import_all(payload: dict[str, Any]):
        try:
            store.import_all(payload)
        except NotEmpty:
            raise HTTPException(status_code=409, detail="project already has data") from None
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return store.snapshot()

    return router


def create_share_router(store: ProjectStore, shares: ShareManager, events: Events) -> APIRouter:
    """``/api/share`` for the owner (local only): create, list, revoke."""
    router = APIRouter()

    def title_of(canvas_id: str) -> str:
        ws = store.read("workspace")
        for d in ((ws or ({}, ""))[0] or {}).get("docs") or []:
            if d.get("id") == canvas_id:
                return str(d.get("title") or "")
        return ""

    @router.get("")
    def list_shares():
        return {"shares": shares.list(), "gateway": shares.gateway_port is not None}

    @router.post("")
    def create_share(body: NewShare):
        try:
            check_ttl(body.ttl)
            check_max_opens(body.maxOpens)
            if store.read("canvas", body.canvasId) is None:
                raise ValueError(f"no canvas {body.canvasId!r} in this project")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        try:
            share, url = shares.create(body.canvasId, body.ttl, title_of(body.canvasId), max_opens=body.maxOpens)
        except ShareError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
        except Exception as e:  # Cloudflare / cloudflared failures: say what failed, keep serving
            raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {e}") from e
        return {"share": share, "url": url}

    @router.delete("/{id}")
    def revoke_share(id: str):
        try:
            return {"share": shares.revoke(id)}
        except KeyError:
            raise HTTPException(status_code=404, detail="no such share") from None

    return router


def exec_options(store: ProjectStore, env: dict[str, str] | None = None) -> ExecOptions:
    """``[agent]`` in config.toml sets the project's defaults; ``AGORA_CANVAS_*`` env still wins."""
    env = os.environ if env is None else env
    agent = store.config().get("agent", {})
    effort = env.get("AGORA_CANVAS_EFFORT") or agent.get("effort") or None
    if effort is not None and effort not in EFFORTS:
        raise ValueError(f"effort must be one of {EFFORTS}, got {effort!r}")
    return ExecOptions(
        backend=env.get("AGORA_CANVAS_BACKEND") or agent.get("backend") or DEFAULT_BACKEND,
        model=env.get("AGORA_CANVAS_MODEL") or agent.get("model") or DEFAULT_MODEL,
        effort=effort,
    )


NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Agora</title>
<body style="font:14px system-ui;padding:40px;max-width:560px">
<h3>前端还没有构建</h3><p>在 Agora 仓库里运行 <code>cd web &amp;&amp; npm run build</code>，
或用 <code>agora up --dev</code> 走 vite 开发服务器。项目 API 已在 <code>/api/project</code> 就绪。</p>"""


SWEEP_S = 5.0


def create_project_app(
    root: Path | str,
    *,
    dist: Path | None = None,
    canvas_router: APIRouter | None = None,
    hub=None,
    shares: ShareManager | None = None,
    gateway: bool = False,
) -> FastAPI:
    """The app one ``agora up`` serves for one project. ``gateway`` also starts the share gateway
    (share_gateway.py) on its own local port, the sweeper that ends expired shares, and resumes
    the tunnel for shares that are still active."""
    from contextlib import asynccontextmanager

    from server.canvas.agent_router import create_agent_router
    from server.canvas.sessions import AgentHub
    from server.canvas.share_gateway import create_gateway_app

    store = ProjectStore(root)
    store.init()
    hub = hub or AgentHub(store)
    events = Events()
    shares = shares or ShareManager(store)
    shares.on_change = lambda: events.publish({"t": "shares"})
    dist = dist or WEB / "dist"
    gateway_app = create_gateway_app(store, shares, events, dist=dist)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        tasks: list[asyncio.Task] = []
        server = None
        if gateway:
            import uvicorn

            from agora_cli.main import free_port

            port = free_port()
            server = uvicorn.Server(uvicorn.Config(gateway_app, host="127.0.0.1", port=port, log_level="warning", proxy_headers=False))
            tasks.append(asyncio.create_task(server.serve()))
            shares.gateway_port = port
            await asyncio.to_thread(shares.resume)

            async def sweeper():
                while True:
                    await asyncio.sleep(SWEEP_S)
                    try:
                        await asyncio.to_thread(shares.sweep)
                    except Exception as e:  # keep sweeping; the next pass retries
                        print(f"share sweep failed: {e}", flush=True)

            tasks.append(asyncio.create_task(sweeper()))
        yield
        if server is not None:
            server.should_exit = True
        for t in tasks[1:]:
            t.cancel()
        await asyncio.to_thread(shares.shutdown)
        await hub.close()

    app = FastAPI(title=f"agora · {store.info()['name']}", lifespan=lifespan)
    app.state.store = store
    app.state.hub = hub
    app.state.shares = shares
    app.state.events = events
    app.state.gateway = gateway_app

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        # The owner's app is never meant to be reached through a tunnel or another hostname
        # (DNS rebinding): refuse anything Cloudflare forwarded or addressed to the share domain.
        host = request.headers.get("host", "").split(":")[0].lower()
        if any(k.startswith("cf-") for k in request.headers.keys()) or (shares.by_host(host) is not None):
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return await call_next(request)

    app.include_router(create_project_router(store, events), prefix="/api/project")
    app.include_router(create_share_router(store, shares, events), prefix="/api/share")
    app.include_router(create_agent_router(hub), prefix="/api/agent")
    if canvas_router is None:
        from server.canvas.router import create_router

        canvas_router = create_router(options=exec_options(store))
    app.include_router(canvas_router, prefix="/api/canvas")
    libs = WEB / "libraries"
    if libs.is_dir():
        app.mount("/libraries", StaticFiles(directory=str(libs)), name="libraries")
    if (dist / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="web")
    else:

        @app.get("/", response_class=HTMLResponse)
        def not_built():
            return NOT_BUILT

    return app


def app_from_env() -> FastAPI:
    """``uvicorn --factory server.canvas.project_router:app_from_env`` with ``AGORA_PROJECT_ROOT``."""
    return create_project_app(os.environ.get("AGORA_PROJECT_ROOT") or os.getcwd())
