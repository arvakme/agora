"""Project storage API (``/api/project``) over one ``ProjectStore``, plus the per-project app
that ``agora up`` serves: this router, the canvas router (turns, animations, library) with the
project's agent defaults, the vendored libraries and the built frontend.

Writes carry ``base`` (the version the client last saw); a stale base answers 409 with the
file's current version so the UI can offer "reload" or "keep mine" (``force``).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from server.canvas.project import Conflict, NotEmpty, ProjectStore
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


def create_project_router(store: ProjectStore) -> APIRouter:
    router = APIRouter()

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
        return guard(lambda: {"version": store.write("canvas", id, body.data, base=body.base, force=body.force)})

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


def create_project_app(root: Path | str, *, dist: Path | None = None, canvas_router: APIRouter | None = None, hub=None) -> FastAPI:
    """The app one ``agora up`` serves for one project."""
    from contextlib import asynccontextmanager

    from server.canvas.agent_router import create_agent_router
    from server.canvas.sessions import AgentHub

    store = ProjectStore(root)
    store.init()
    hub = hub or AgentHub(store)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await hub.close()

    app = FastAPI(title=f"agora · {store.info()['name']}", lifespan=lifespan)
    app.state.store = store
    app.state.hub = hub
    app.include_router(create_project_router(store), prefix="/api/project")
    app.include_router(create_agent_router(hub), prefix="/api/agent")
    if canvas_router is None:
        from server.canvas.router import create_router

        canvas_router = create_router(options=exec_options(store))
    app.include_router(canvas_router, prefix="/api/canvas")
    libs = WEB / "libraries"
    if libs.is_dir():
        app.mount("/libraries", StaticFiles(directory=str(libs)), name="libraries")
    dist = dist or WEB / "dist"
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
