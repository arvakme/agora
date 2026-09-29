"""Project storage API (``/api/project``) over one ``ProjectStore``, plus the per-project app
that ``agora up`` serves: this router, the canvas router (turns, animations, library) with the
project's agent defaults, the vendored libraries and the built frontend.

Writes carry ``base`` (the version the client last saw); a stale base answers 409 with the
file's current version so the UI can offer "reload" or "keep mine" (``force``).
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from server.canvas import shutdown
from server.canvas.backup import Backups, FileHistory
from server.canvas.discover import full_text, session_history
from server.canvas.events import Events
from server.canvas.local import Local, session_origins
from server.canvas.project import Conflict, EmptyOverwrite, Gone, NotEmpty, ProjectStore
from server.canvas.share import ShareError, ShareManager, check_max_opens, check_ttl
from server.canvas.trash import Trash, TrashError, canvas_sessions
from server.canvas.runner import DEFAULT_BACKEND, DEFAULT_MODEL, EFFORTS, ExecOptions

REPO = Path(__file__).resolve().parents[2]
WEB = REPO / "web"


class Write(BaseModel):
    data: Any
    base: str | None = None
    force: bool = False
    #: The writer says an empty scene is the user's own clear/delete (not a page that lost its scene).
    clear: bool = False


class Records(BaseModel):
    records: list[dict[str, Any]]
    base: str | None = None
    force: bool = False


def conflict(e: Conflict) -> JSONResponse:
    extra = {"code": e.code} if isinstance(e, EmptyOverwrite) else {}
    return JSONResponse(status_code=409, content={"conflict": True, "file": e.file, "current": e.current, "base": e.base, **extra})


def gone(e: Gone) -> JSONResponse:
    """The project directory moved away while this server ran: 410, never a write at the old path."""
    return JSONResponse(status_code=410, content={"gone": True, "error": f"{e}。在项目的新位置运行 `agora up`；这个页面里没保存的改动还在，先别关掉它。"})


def write_failed(e: OSError, store: ProjectStore) -> JSONResponse:
    """A write the disk refused (full, read-only, permissions): say which file and why. The old
    file is intact (writes are atomic)."""
    why = {errno.ENOSPC: "磁盘空间不足", errno.EACCES: "没有写入权限", errno.EPERM: "没有写入权限", errno.EROFS: "文件系统是只读的", errno.EDQUOT: "超出磁盘配额"}.get(e.errno or 0, e.strerror or type(e).__name__)
    file = e.filename
    try:
        if file:
            p = Path(file)
            m = re.match(r"^\.(.+)\.\d+\.[0-9a-f]+\.tmp$", p.name)  # _atomic's temp file → the file it replaces
            file = str((p.parent / m.group(1) if m else p).relative_to(store.dir))
    except ValueError:
        pass
    return JSONResponse(status_code=507 if e.errno in (errno.ENOSPC, errno.EDQUOT) else 500, content={"error": f"保存失败：{why}", "file": file, "errno": e.errno})


class Merge(BaseModel):
    data: dict[str, Any]


class ToTrash(BaseModel):
    # The page owns workspace.json: it sends the entry and where its tab was, so a restore puts it back.
    entry: dict[str, Any] | None = None
    place: dict[str, Any] | None = None
    title: str = ""


class NewShare(BaseModel):
    canvasId: str
    ttl: int | None = None  # seconds; None = until revoked
    maxOpens: int | None = None  # distinct guests that may open it; None = unlimited
    quick: bool = False  # account-less trycloudflare.com address (one share at a time)


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


def create_project_router(store: ProjectStore, events: Events | None = None, *, shares: ShareManager | None = None, hub=None, local: Local | None = None, trash: Trash | None = None) -> APIRouter:
    """``shares`` (optional): trashing a canvas ends its shares. ``hub`` (optional, an AgentHub):
    trashing a session closes its terminal pane and stops its headless turn. ``local``: this copy's
    machine-local state (instance, copies, registry). ``trash``: where deleted items go."""
    router = APIRouter()
    events = events or Events()
    local = local or (hub.local if hub is not None else Local(store))
    trash = trash or Trash(store)

    def guard(f):
        try:
            return f()
        except Conflict as e:
            return conflict(e)
        except Gone as e:
            return gone(e)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except OSError as e:
            return write_failed(e, store)

    @router.get("")
    def info():
        return {**store.info(), "empty": store.is_empty(), "instanceId": local.instance_id()}

    @router.get("/health")
    def health():
        return {"ok": True, "root": str(store.root), "pid": os.getpid(), "gone": store.gone()}

    @router.get("/snapshot")
    def snapshot():
        # ``local``: which copy this is and what changed since the page last looked (moved, copied,
        # a fresh clone); ``origins``: listed sessions that cannot simply be resumed here.
        return {**store.snapshot(), "local": {"instanceId": local.instance_id(), "change": local.change()}, "origins": session_origins(store, local)}

    @router.post("/local/ack")
    def ack_change():
        """The page showed the move / copy / clone notice once; don't show it again."""
        return guard(lambda: (local.ack(), {"ok": True})[1])

    @router.put("/workspace")
    def put_workspace(body: Write):
        return guard(lambda: {"version": store.write("workspace", None, body.data, base=body.base, force=body.force)})

    @router.get("/canvases/{id}")
    def get_canvas(id: str):
        """One canvas as the server holds it now: a page that (re)mounts loads this before it may save."""
        got = guard(lambda: store.read("canvas", id))
        if not isinstance(got, tuple):
            raise HTTPException(status_code=404, detail=f"no canvas {id}")
        return {"scene": got[0], "version": got[1]}

    @router.put("/canvases/{id}")
    def put_canvas(id: str, body: Write):
        out = guard(lambda: {"version": store.write("canvas", id, body.data, base=body.base, force=body.force, clear=body.clear)})
        if isinstance(out, dict):
            events.publish({"t": "canvas", "canvasId": id, "version": out["version"]})
        return out


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
        return sse(events, request, lambda ev: ev.get("t") in ("threads", "shares", "trash"))

    @router.post("/sessions/{id}/append")
    def append_session(id: str, body: Records):
        return guard(lambda: {"version": store.append_session(id, body.records, base=body.base, force=body.force)})

    @router.put("/sessions/{id}")
    def put_session(id: str, body: Records):
        return guard(lambda: {"version": store.replace_session(id, body.records, base=body.base, force=body.force)})

    # ——— trash (deleting is moving here; web/docs/project-storage.md §1) ———
    def trash_guard(f):
        try:
            return guard(f)
        except TrashError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        except KeyError as e:
            raise HTTPException(status_code=404, detail=f"not found: {e}") from None

    @router.get("/trash")
    def list_trash():
        return {"items": trash.list(), "keepDays": trash.keep_ms // (24 * 3600 * 1000)}

    @router.post("/trash/canvas/{id}")
    def trash_canvas(id: str, body: ToTrash):
        """A canvas and its comments go to the trash. Its shares end first (a guest would see a
        blank page; a failure to end them leaves the canvas where it is), its sessions stay."""

        def go():
            store.check_alive()
            ended = shares.end_for_canvas(id, "canvas-deleted") if shares is not None else []
            m = trash.put("canvas", id, title=body.title, entry=body.entry, place=body.place, linked=canvas_sessions(store, id), sharesEnded=ended)
            local.note("trash", kind="canvas", itemId=id, trashId=m["trashId"], title=body.title or None)
            events.publish({"t": "trash"})
            return m

        return trash_guard(go)

    @router.post("/trash/session/{id}")
    async def trash_session(id: str, body: ToTrash):
        """A session goes to the trash with its binding, record, snapshot and usage; its terminal
        pane and a running headless turn end first. The native log stays."""
        try:
            store.check_alive()
        except Gone as e:
            return gone(e)
        b = store.read_binding(id) or {}
        closed = await hub.forget(id) if hub is not None else False

        def go():
            native = {k: v for k, v in {"agent": b.get("agent"), "nativeId": b.get("nativeId"), "logPath": (b.get("log") or {}).get("path")}.items() if v}
            m = trash.put("session", id, title=body.title, entry=body.entry, place=body.place, native=native or None, terminalClosed=closed)
            local.drop_copy(id)
            local.note("trash", kind="session", itemId=id, sessionId=id, trashId=m["trashId"], title=body.title or None, agent=b.get("agent"), nativeId=b.get("nativeId"))
            events.publish({"t": "trash"})
            return m

        out = await asyncio.to_thread(trash_guard, go)
        if hub is not None and not isinstance(out, dict):  # nothing moved: the session is still here
            hub.revive(id)
        return out

    @router.post("/trash/{trash_id}/restore")
    def restore_trash(trash_id: str):
        """Put an item back. Returns what the page needs to show it again right away: the scene and
        threads (canvas) or the folded record and binding (session). Shares are not restored."""

        def go():
            m = trash.restore(trash_id)
            id = m["id"]
            out: dict[str, Any] = {"item": m, "id": id}
            if m["kind"] == "canvas":
                got = store.read("canvas", id)
                th = store.read("threads", id)
                out["canvas"] = {"scene": got[0] if got else {"elements": []}, "version": got[1] if got else None, "threads": None if th is None else {"data": th[0], "version": th[1]}}
            else:
                sess = store.read_session(id)
                out["session"] = None if sess is None else {"state": sess[0], "version": sess[1]}
                out["binding"] = store.read_binding(id)
                if hub is not None:
                    hub.revive(id)
            local.note("restore", kind=m["kind"], itemId=id, trashId=trash_id, sessionId=id if m["kind"] == "session" else None)
            events.publish({"t": "trash"})
            return out

        return trash_guard(go)

    @router.delete("/trash/{trash_id}")
    def purge_trash(trash_id: str):
        """Delete for good. A session's native conversation stays in the CLI's own log (``native``)."""

        def go():
            m = trash.purge(trash_id)
            local.note("purge", kind=m["kind"], itemId=m["id"], trashId=trash_id, sessionId=m["id"] if m["kind"] == "session" else None)
            events.publish({"t": "trash"})
            return {"ok": True, "native": m.get("native")}

        return trash_guard(go)

    # ——— 会话历史 (web/docs/agent-sessions.md §8) ———
    @router.get("/history")
    def history():
        """Every session of this project wherever it is now, plus native sessions found on this
        machine that belong to it (footer, registry) or ran in its directory."""
        return session_history(store, local, trash)

    @router.get("/history/search")
    def history_search(q: str):
        """Full text (what was said) across the sessions' native logs, or their snapshots when a log is gone."""
        if len(q.strip()) < 2:
            raise HTTPException(status_code=400, detail="search for at least 2 characters")
        h = session_history(store, local, trash)
        paths: dict[str, tuple[str, str]] = {}
        for r in [*h["rows"], *h["found"]]:
            key = r.get("sessionId") or r.get("nativeId")
            snap = store.dir / "sessions" / "snapshots" / f"{r.get('sessionId')}.jsonl"
            if r.get("logPath") and Path(r["logPath"]).exists():
                paths[key] = (r.get("agent") or "claude", r["logPath"])
            elif r.get("sessionId") and snap.exists():
                paths[key] = ("snapshot", str(snap))
        return {"matches": full_text(store, paths, q.strip())}

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
            share, url = shares.create(body.canvasId, body.ttl, title_of(body.canvasId), max_opens=body.maxOpens, quick=body.quick)
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
TRASH_SWEEP_S = 3600.0


def allowed_hosts() -> set[str]:
    """Host names the owner app answers to: loopback names, this machine's name, and ``AGORA_ALLOWED_HOSTS``."""
    import socket

    names = {"127.0.0.1", "localhost", "::1"}
    try:
        h = socket.gethostname().lower()
        names |= {h, h.split(".")[0], h.split(".")[0] + ".local"}
    except OSError:
        pass
    names |= {x.strip().lower() for x in os.environ.get("AGORA_ALLOWED_HOSTS", "").split(",") if x.strip()}
    return names


def host_name(header: str) -> str:
    """``Host`` without its port (``[::1]:5173`` → ``::1``)."""
    h = header.strip().lower()
    if h.startswith("["):
        return h[1 : h.find("]")] if "]" in h else h
    return h.rsplit(":", 1)[0] if h.count(":") == 1 else h


class LocalHostOnly:
    """ASGI middleware: 421 for HTTP and WebSocket requests whose Host is not a local name."""

    def __init__(self, app) -> None:
        self.app = app
        self.allowed = allowed_hosts()

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            host = next((v.decode("latin-1") for k, v in scope.get("headers") or [] if k == b"host"), "")
            if host_name(host) not in self.allowed:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                body = b'{"error":"host not allowed"}'
                await send({"type": "http.response.start", "status": 421, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


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
    from server.canvas.terminal import Terminals

    store = ProjectStore(root)
    store.init()
    local = hub.local if hub is not None else Local(store)
    # Moved, copied or freshly cloned since last time: settle this copy's identity first (a moved
    # project's Pi logs follow it; a copy gets its own id and read-only sessions).
    probe = Terminals(store.root, store.run_dir, socket=local.socket(), legacy=local.legacy_sockets())
    local.reconcile(alive=probe.alive)
    hub = hub or AgentHub(store, local=local)
    events = Events()
    hub.events = events  # a dispatch answering a comment thread tells open pages (dispatch.py)
    shares = shares or ShareManager(store)
    shares.on_change = lambda: events.publish({"t": "shares"})
    dist = dist or WEB / "dist"
    gateway_app = create_gateway_app(store, shares, events, dist=dist)
    gateway_app.add_middleware(shutdown.CloseStreamsOnShutdown)

    trash = Trash(store)
    # Safety nets outside the project: earlier versions of committed files, daily local backups.
    history = FileHistory(local)
    store.on_overwrite = history.keep
    backups = Backups(store, local)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        tasks: list[asyncio.Task] = []
        server = gateway_task = None

        async def trash_sweeper():
            # Items past the 30 days go (at start, then hourly); each is noted in the registry.
            while True:
                try:
                    for m in await asyncio.to_thread(trash.sweep):
                        local.note("purge", kind=m["kind"], itemId=m["id"], trashId=m["trashId"], reason="expired")
                    await asyncio.to_thread(backups.make)  # once a day
                    existing = {str(f.relative_to(store.dir)) for sub in ("canvases", "threads") for f in (store.dir / sub).glob("*") if f.is_file()} | {"workspace.json"}
                    await asyncio.to_thread(history.prune, existing)
                except Exception as e:  # keep serving; the next pass retries
                    print(f"trash sweep / backup failed: {e}", flush=True)
                await asyncio.sleep(TRASH_SWEEP_S)

        tasks.append(asyncio.create_task(trash_sweeper()))
        hub.ensure_started()  # dispatches left open by a restart are reconciled now, not when a page first connects
        if gateway:
            import uvicorn

            from agora_cli.main import free_port

            port = free_port()
            # its own server must neither take the process's signals from the main one nor wait for a guest's open stream
            server = shutdown.GatewayServer(uvicorn.Config(gateway_app, host="127.0.0.1", port=port, log_level="warning", proxy_headers=False, timeout_graceful_shutdown=shutdown.GRACE_S))
            shutdown.on_stop(lambda: setattr(server, "should_exit", True))
            gateway_task = asyncio.create_task(server.serve())  # stops on should_exit, not cancelled
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
        # Every step has a limit: one that hangs must not keep the process from ending (shutdown.py).
        if server is not None:
            server.should_exit = True
        for t in tasks:
            t.cancel()
        await shutdown.bounded(asyncio.gather(*tasks, return_exceptions=True), 3, "background tasks")
        if gateway_task is not None:
            await shutdown.bounded(gateway_task, shutdown.GRACE_S + 2, "share gateway")
        await shutdown.bounded(asyncio.to_thread(shares.shutdown), 8, "shares.shutdown")
        await shutdown.bounded(hub.close(), 12, "hub.close")

    app = FastAPI(title=f"agora · {store.info()['name']}", lifespan=lifespan)
    # The owner app answers only to local names (DNS rebinding: a page on another origin that resolves
    # its own name to 127.0.0.1 must not reach it). The share gateway is a separate app, unaffected.
    app.add_middleware(LocalHostOnly)
    app.add_middleware(shutdown.CloseStreamsOnShutdown)  # event streams end when the server is told to stop (shutdown.py)
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

    app.include_router(create_project_router(store, events, shares=shares, hub=hub, local=local, trash=trash), prefix="/api/project")
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
