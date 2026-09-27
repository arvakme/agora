"""The share gateway: the only thing a share's tunnel reaches. A separate app on its own local
port, so the owner's app (project files, sessions, terminals, agents) is never behind the tunnel.

Whitelist (everything else is 403):

    GET  /s/{token}          open the share: sets the share cookie (+ a guest id), redirects to /
    GET  /                   the canvas page (built frontend, guest mode, noindex)
    GET  /assets/*           the frontend's static files
    GET  /api/guest/state    the shared canvas (read-only), its comment threads, who you are
    POST /api/guest/comments new thread / reply (``{op: create|reply}``), as ``guest:<id>``
    GET  /api/guest/events   SSE: threads and canvas changes, and ``ended`` when the share ends

Every request must come for the hostname of an active share; every request past ``/s/`` must
carry that share's token (cookie, compared in constant time). Guests are rate limited per
client address (``CF-Connecting-IP``).
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import secrets
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

from server.canvas.events import Events
from server.canvas.project import ID_RE, NotFound, ProjectStore
from server.canvas.share import RateLimiter, Share, ShareManager, guest_elements, guest_threads

SHARE_COOKIE = "agora_share"
GUEST_COOKIE = "agora_guest"
GUEST_ID_RE = re.compile(r"^[a-z0-9]{16}$")
MAX_TEXT = 4000
MAX_NAME = 40
LIMITS = {
    "open": (10, 60.0),  # /s/<token> attempts per address per minute (right or wrong)
    "read": (120, 60.0),
    "write": (20, 60.0),
    "stream": (10, 60.0),
}
MAX_STREAMS_PER_SHARE = 50

SECURITY_HEADERS = {
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
}

GONE_PAGE = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>链接已失效 · Agora</title>
<style>
:root{--bg:#fff;--fg:#2c3136;--muted:#5e686d;--accent:#7048b4}
@media (prefers-color-scheme:dark){:root{--bg:#202428;--fg:#d9dee2;--muted:#a0a8ad;--accent:#bea5f5}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;
background-image:radial-gradient(circle,var(--accent) .9px,transparent 1px);background-size:7px 7px;background-blend-mode:normal}
main{background:var(--bg);padding:28px 32px;max-width:360px;margin:16px;box-shadow:0 0 0 32px var(--bg)}
h1{font-size:20px;font-weight:600;margin:0 0 8px}p{margin:0;color:var(--muted)}
</style>
<main><h1>这个分享链接已失效</h1><p>它可能已经到期、被作者撤销，或者链接不完整。需要继续查看的话，请向作者要一个新链接。</p></main></html>"""


def forbidden(request: Request, status: int = 403) -> Response:
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": "forbidden"}, status_code=status)
    return HTMLResponse(GONE_PAGE, status_code=status)


def client_addr(request: Request) -> str:
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")


def _finite(v: Any, lo: float = -1e7, hi: float = 1e7) -> float:
    if not isinstance(v, int | float) or isinstance(v, bool) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError("bad number")
    return float(v)


def clean_anchor(a: Any, element_ids: set[str]) -> dict[str, Any]:
    if not isinstance(a, dict):
        raise ValueError("anchor must be an object")
    ids = a.get("ids")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 8 or not all(isinstance(i, str) and i in element_ids for i in ids):
        raise ValueError("anchor must name elements on this canvas")
    rel, last = a.get("rel") or {}, a.get("last") or {}
    return {
        "ids": ids,
        "rel": {"x": _finite(rel.get("x"), 0, 1), "y": _finite(rel.get("y"), 0, 1)},
        "last": {"x": _finite(last.get("x")), "y": _finite(last.get("y"))},
    }


def clean_text(v: Any, n: int, what: str) -> str:
    if not isinstance(v, str) or not v.strip():
        raise ValueError(f"{what} is required")
    v = v.strip()
    if len(v) > n:
        raise ValueError(f"{what} is longer than {n} characters")
    return v


def create_gateway_app(store: ProjectStore, shares: ShareManager, events: Events, *, dist: Path) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    limiter = RateLimiter(LIMITS)
    streams: dict[str, int] = {}

    def share_for(request: Request) -> Share | None:
        return shares.verify(request.headers.get("host", ""), request.cookies.get(SHARE_COOKIE))

    def guest_of(request: Request) -> str | None:
        g = request.cookies.get(GUEST_COOKIE) or ""
        return g if GUEST_ID_RE.match(g) else None

    def canvas_title(canvas_id: str) -> str:
        ws = store.read("workspace")
        for d in ((ws or ({}, ""))[0] or {}).get("docs") or []:
            if d.get("id") == canvas_id:
                return str(d.get("title") or "")
        return ""

    @app.middleware("http")
    async def gate(request: Request, call_next):
        # Nothing is served for a hostname without an active share (expired, revoked, unknown).
        if shares.by_host(request.headers.get("host", "")) is None:
            resp = forbidden(request)
        else:
            path = request.url.path
            if path.startswith("/api/") or path.startswith("/s/"):
                kind = "open" if path.startswith("/s/") else "stream" if path == "/api/guest/events" else "write" if request.method == "POST" else "read"
            else:
                kind = "read"
            if not limiter.allow(kind, client_addr(request)):
                resp = JSONResponse({"error": "rate limited"}, status_code=429, headers={"retry-after": "30"})
            else:
                resp = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            resp.headers.setdefault(k, v)
        if request.url.path.startswith(("/api/", "/s/")) or request.url.path in ("/", "/index.html"):
            resp.headers["cache-control"] = "no-store"
        return resp

    @app.get("/s/{token}")
    def open_share(token: str, request: Request):
        share = shares.verify(request.headers.get("host", ""), token)
        if share is None:
            return forbidden(request)
        guest = guest_of(request)
        shares.note_visit(share, new_guest=guest is None)
        resp = RedirectResponse("/", status_code=303)
        max_age = None if share.expiresAt is None else max(1, (share.expiresAt - shares.now_ms()) // 1000)
        resp.set_cookie(SHARE_COOKIE, token, max_age=max_age, httponly=True, secure=True, samesite="lax", path="/")
        if guest is None:
            resp.set_cookie(GUEST_COOKIE, secrets.token_hex(8), max_age=90 * 86400, httponly=True, secure=True, samesite="lax", path="/")
        return resp

    def page(request: Request):
        if share_for(request) is None:
            return forbidden(request)
        index = dist / "index.html"
        if not index.exists():
            return HTMLResponse("<!doctype html><meta name=robots content=noindex><p>前端还没有构建。</p>", status_code=503)
        html = index.read_text().replace(
            "<head>",
            '<head>\n    <meta name="robots" content="noindex, nofollow" />\n    <meta name="agora-guest" content="1" />',
            1,
        )
        return HTMLResponse(html)

    app.get("/")(page)
    app.get("/index.html")(page)

    @app.get("/assets/{path:path}")
    def asset(path: str):
        base = (dist / "assets").resolve()
        f = (base / path).resolve()
        if not f.is_file() or base not in f.parents:
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(f, headers={"cache-control": "public, max-age=31536000, immutable"})

    @app.get("/api/guest/state")
    def state(request: Request):
        share = share_for(request)
        if share is None:
            return forbidden(request)
        scene = store.read("canvas", share.canvasId)
        threads = store.read("threads", share.canvasId)
        guest = guest_of(request)
        return {
            "project": {"name": store.config().get("project", {}).get("name") or store.root.name},
            "canvas": {"id": share.canvasId, "title": canvas_title(share.canvasId) or share.canvasTitle, "elements": guest_elements((scene or ({}, ""))[0].get("elements") or [])},
            "threads": guest_threads(threads[0] if threads else None),
            "me": {"id": f"guest:{guest}"} if guest else None,
            "share": {"expiresAt": share.expiresAt},
        }

    @app.post("/api/guest/comments")
    async def comment(request: Request):
        share = share_for(request)
        guest = guest_of(request)
        if share is None or guest is None:
            return forbidden(request)
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JSONResponse({"error": "bad json"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse({"error": "bad body"}, status_code=400)
        now = int(time.time() * 1000)
        try:
            by = {"id": f"guest:{guest}", "name": clean_text(body.get("name"), MAX_NAME, "name")}
            text = clean_text(body.get("text"), MAX_TEXT, "text")
            mid = body.get("id")
            if not isinstance(mid, str) or not ID_RE.match(mid) or len(mid) > 32:
                raise ValueError("id must be a short [A-Za-z0-9._-] string")
            msg = {"id": mid, "author": "human", "by": by, "text": text, "at": now}
            if body.get("op") == "create":
                scene = store.read("canvas", share.canvasId)
                element_ids = {e.get("id") for e in (scene or ({}, ""))[0].get("elements") or [] if not e.get("isDeleted")}
                tid = body.get("threadId")
                if not isinstance(tid, str) or not ID_RE.match(tid) or len(tid) > 32:
                    raise ValueError("threadId must be a short [A-Za-z0-9._-] string")
                op = {"op": "create", "thread": {"id": tid, "anchor": clean_anchor(body.get("anchor"), element_ids), "resolved": False, "createdAt": now, "createdBy": by, "messages": [msg]}}
            elif body.get("op") == "reply":
                op = {"op": "reply", "threadId": body.get("threadId"), "message": msg}
            else:
                raise ValueError("op must be create or reply")
            data, version, thread = await asyncio.to_thread(store.thread_op, share.canvasId, op)
        except NotFound:
            return JSONResponse({"error": "no such thread"}, status_code=404)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        shares.note_comment(share)
        events.publish({"t": "threads", "canvasId": share.canvasId, "data": data, "version": version})
        return {"thread": guest_threads({"threads": [thread]})["threads"][0]}

    @app.get("/api/guest/events")
    async def stream(request: Request):
        share = share_for(request)
        if share is None:
            return forbidden(request)
        if streams.get(share.id, 0) >= MAX_STREAMS_PER_SHARE:
            return JSONResponse({"error": "too many viewers"}, status_code=429)
        host = request.headers.get("host", "")
        token = request.cookies.get(SHARE_COOKIE)
        sub = events.subscribe(lambda ev: ev.get("canvasId") == share.canvasId or ev.get("t") == "shares")
        streams[share.id] = streams.get(share.id, 0) + 1

        async def gen():
            try:
                yield f"data: {json.dumps({'t': 'hello'})}\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        ev = await asyncio.wait_for(sub.q.get(), 2)
                    except TimeoutError:
                        ev = None
                    if shares.verify(host, token) is None:  # revoked or expired: tell the page, hang up
                        yield f"data: {json.dumps({'t': 'ended'})}\n\n"
                        break
                    if ev is None:
                        yield ": keepalive\n\n"
                    elif ev.get("t") == "threads":
                        yield f"data: {json.dumps({'t': 'threads', 'data': guest_threads(ev['data'])}, ensure_ascii=False)}\n\n"
                    elif ev.get("t") == "canvas":
                        scene = store.read("canvas", share.canvasId)
                        yield f"data: {json.dumps({'t': 'canvas', 'elements': guest_elements((scene or ({}, ''))[0].get('elements') or [])}, ensure_ascii=False)}\n\n"
            finally:
                events.unsubscribe(sub)
                streams[share.id] = max(0, streams.get(share.id, 1) - 1)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-store", "x-accel-buffering": "no"})

    @app.api_route("/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    def everything_else(rest: str, request: Request):
        return forbidden(request)

    return app
