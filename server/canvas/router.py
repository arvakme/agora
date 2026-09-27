"""Canvas workbench API, mounted by server/main.py at ``/api/canvas``.

- ``POST /turns``        streams one planning turn as SSE (Accept: application/json → plain result)
- ``POST /anim``         generates an animation script (JSON)
- ``GET  /library/*``    asset library search/item/list (panel, executor, MCP parity)

Everything model-shaped goes through ``OneShotRunner`` — phase 1 runs ``claude -p`` as a
subprocess; a later phase swaps in the native host runner. The router holds no business
rules beyond request parsing; scoring/validation live in library.py / runner.py.

This module also doubles as a standalone app for local development::

    uv run uvicorn server.canvas.router:app --port 8000
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from server.canvas import schemas
from server.canvas.library import Library
from server.canvas.runner import (
    ANIM_SYSTEM,
    PLAN_SYSTEM,
    ClaudeCliRunner,
    OneShotRunner,
    build_prompt,
    library_mcp_config,
)


def create_router(
    *,
    runner: OneShotRunner | None = None,
    library: Library | None = None,
) -> APIRouter:
    """Wire the canvas endpoints. ``runner``/``library`` are injectable for tests."""
    runner = runner or ClaudeCliRunner()
    library = library or Library()
    router = APIRouter()

    async def turn_events(ctx: dict[str, Any]):
        async for ev in runner.run(
            schema=schemas.load("plan.schema.json"),
            system=PLAN_SYSTEM,
            prompt=build_prompt(ctx),
            mcp_config=library_mcp_config(),
        ):
            yield ev

    @router.post("/turns")
    async def turns(request: Request):
        ctx = await request.json()
        if "application/json" in request.headers.get("accept", ""):
            result: dict[str, Any] | None = None
            async for ev in turn_events(ctx):
                if ev["t"] == "result":
                    result = {k: v for k, v in ev.items() if k != "t"}
            return result or {"raw": None, "error": "no result event"}

        async def sse():
            # StreamingResponse cancels this generator when the client disconnects;
            # the runner's cleanup then kills the `claude` child process.
            async for ev in turn_events(ctx):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

        return StreamingResponse(
            sse(),
            media_type="text/event-stream",
            headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
        )

    @router.post("/anim")
    async def anim(request: Request):
        body = await request.json()
        script_schema = schemas.load("anim.schema.json")
        ask_engine = bool(body.get("askEngine"))
        schema = schemas.load("anim-ask.schema.json") if ask_engine else script_schema
        prompt = str(body.get("request") or "")
        errors = body.get("errors") or []
        if errors:
            prompt += f"\n\nThe previous attempt failed validation; fix it. Errors: {json.dumps(errors)}"
        result = None
        async for ev in runner.run(schema=schema, system=ANIM_SYSTEM, prompt=prompt):
            if ev["t"] == "result":
                result = ev
        if result is None:
            return {"raw": None, "error": "no result event"}
        out: dict[str, Any] = {"raw": result.get("raw"), "costUsd": result.get("costUsd"), "durationMs": result.get("durationMs")}
        if result.get("error"):
            out["error"] = result["error"]
            return out
        engine = "excalidraw"
        raw = result["raw"]
        if isinstance(raw, dict) and "engine" in raw:
            engine = "tldraw" if raw.get("engine") == "tldraw" else "excalidraw"
            raw = raw.get("script")
        out["raw"], out["engine"] = raw, engine
        return out

    @router.get("/library/search")
    async def library_search(q: str = "", limit: int = Query(8, ge=1, le=50)):
        if not q.strip():
            return {"items": []}
        return {"items": library.search(q, limit)}

    @router.get("/library/item")
    async def library_item(id: str = ""):
        hit = library.item(id)
        if hit is None:
            raise HTTPException(status_code=404, detail=f"unknown library item: {id}")
        return hit

    @router.get("/library/libs")
    async def library_libs():
        return {"libraries": library.libs()}

    return router


# Standalone dev app (the real service mounts create_router() under /api/canvas in main.py).
def create_app():
    from fastapi import FastAPI

    app = FastAPI(title="agora canvas workbench")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://localhost:5181", "http://localhost:4000"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(create_router(), prefix="/api/canvas")
    # Serve the vendored libraries statically so /libraries/* works outside vite too.
    libs = Path(__file__).resolve().parents[2] / "web" / "libraries"
    if libs.is_dir():
        app.mount("/libraries", StaticFiles(directory=str(libs)), name="libraries")
    return app


app = create_app()
