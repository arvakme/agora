"""The share gateway: the only thing a share's tunnel reaches. A separate app on its own local
port, so the owner's app (project files, sessions, terminals, agents) is never behind the tunnel.

Whitelist (everything else is 403):

    GET  /s/{token}          open the share: sets the share cookie (+ a guest id), redirects to /;
                             counts one opening per new guest, refused once ``maxOpens`` is used up
    GET  /                   the canvas page (built frontend, guest mode, noindex)
    GET  /assets/*           the frontend's static files
    GET  /api/guest/state    the shared canvas (read-only), its comment threads, who you are;
                             ``?canvas=<id>`` a canvas nested below it (web/docs/nested-canvas.md)
    POST /api/guest/comments new thread / reply / edit / delete / restore
                             (``{op: create|reply|edit|delete|restore}``), as ``guest:<id>``;
                             edit, delete and restore only on the guest's own messages
    GET  /api/guest/bundle   the shared canvases and their comments as a file (``agora import``)
    GET  /api/guest/events   SSE: threads and canvas changes, and ``ended`` when the share ends

Every request must come for the hostname of an active share; every request past ``/s/`` must
carry that share's token (cookie, compared in constant time) and, for a share with an opening
limit, a guest id the share admitted. Guests are rate limited per client address
(``CF-Connecting-IP``); that is flood protection, separate from the owner's opening limit.
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse

from server.canvas import build_log, nested
from server.canvas.events import Events
from server.canvas.project import ID_RE, NotFound, NotYours, ProjectStore
from server.canvas.share import MAX_NAME, MAX_TEXT, RateLimiter, Share, ShareManager, canvas_titles, clean_anchor, clean_moment, clean_text, export_bundle, finite, guest_canvas, guest_elements, guest_threads, slug

SHARE_COOKIE = "agora_share"
GUEST_COOKIE = "agora_guest"
GUEST_ID_RE = re.compile(r"^[a-z0-9]{16}$")
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


FULL_PAGE = GONE_PAGE.replace("<title>链接已失效", "<title>打开次数已用完").replace(
    "<h1>这个分享链接已失效</h1><p>它可能已经到期、被作者撤销，或者链接不完整。需要继续查看的话，请向作者要一个新链接。</p>",
    "<h1>这个分享链接的打开次数已用完</h1><p>作者给它设了最多能被几个人打开，名额已经满了。已经打开过它的浏览器还能继续看；需要查看的话，请向作者要一个新链接。</p>",
)


def forbidden(request: Request, status: int = 403) -> Response:
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": "forbidden"}, status_code=status)
    return HTMLResponse(GONE_PAGE, status_code=status)


def client_addr(request: Request) -> str:
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")


def create_gateway_app(store: ProjectStore, shares: ShareManager, events: Events, *, dist: Path) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    limiter = RateLimiter(LIMITS)
    streams: dict[str, int] = {}

    def share_for(request: Request) -> Share | None:
        share = shares.verify(request.headers.get("host", ""), request.cookies.get(SHARE_COOKIE))
        if share is None or not shares.is_admitted(share, guest_of(request)):
            return None
        return share

    def guest_of(request: Request) -> str | None:
        g = request.cookies.get(GUEST_COOKIE) or ""
        return g if GUEST_ID_RE.match(g) else None

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
        gid = guest or secrets.token_hex(8)
        if not shares.admit(share, gid):
            return HTMLResponse(FULL_PAGE, status_code=403)
        shares.note_visit(share, new_guest=guest is None)
        resp = RedirectResponse("/", status_code=303)
        max_age = None if share.expiresAt is None else max(1, (share.expiresAt - shares.now_ms()) // 1000)
        resp.set_cookie(SHARE_COOKIE, token, max_age=max_age, httponly=True, secure=True, samesite="lax", path="/")
        if guest is None:
            resp.set_cookie(GUEST_COOKIE, gid, max_age=90 * 86400, httponly=True, secure=True, samesite="lax", path="/")
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

    def reach(share: Share) -> set[str]:
        """The shared canvas and every canvas nested below it; nothing else is readable."""
        return nested.reachable(store, share.canvasId)

    def open_count(cid: str) -> int:
        th = store.read("threads", cid)
        return sum(1 for t in (th[0] if th else {}).get("threads") or [] if not t.get("resolved") and not t.get("deleted") and any(not m.get("deleted") for m in t.get("messages") or []))

    @app.get("/api/guest/state")
    def state(request: Request, canvas: str | None = None):
        share = share_for(request)
        if share is None:
            return forbidden(request)
        allowed = reach(share)
        cid = canvas or share.canvasId
        if cid not in allowed:
            return forbidden(request)
        view = guest_canvas(store, cid, allowed)
        guest = guest_of(request)
        sc = nested.scenes(store)
        chain = nested.ancestry(cid, nested.parent_index(sc))
        chain = chain[chain.index(share.canvasId):] if share.canvasId in chain else [cid]
        titles = canvas_titles(store)
        title = lambda c: titles.get(c) or (share.canvasTitle if c == share.canvasId else "")  # noqa: E731
        return {
            "project": {"name": store.config().get("project", {}).get("name") or store.root.name},
            "canvas": {"id": cid, "title": title(cid), "elements": view["elements"]},
            "threads": view["threads"],
            "me": {"id": f"guest:{guest}"} if guest else None,
            "share": {"expiresAt": share.expiresAt, "root": share.canvasId, "buildReplay": share.buildReplay},
            "path": [{"id": c, "title": title(c)} for c in chain],
            # Open comments per canvas, counting everything below it (the marker on its parent node).
            "canvases": {c: {"title": title(c), "open": sum(open_count(x) for x in {c} | nested.descendants(c, sc))} for c in sorted(allowed)},
        }

    @app.get("/api/guest/bundle")
    def bundle(request: Request):
        """The whole share as a file (web/docs/sharing.md §9): what ``agora import`` takes."""
        share = share_for(request)
        if share is None:
            return forbidden(request)
        data = export_bundle(store, share.canvasId, share.canvasTitle, build=share.buildReplay)
        name = f"{slug(share.canvasTitle or share.canvasId)}.agora-share.json"
        return Response(json.dumps(data, ensure_ascii=False), media_type="application/json", headers={"content-disposition": f'attachment; filename="{name}"'})

    @app.get("/api/guest/build")
    def build(request: Request):
        """How the shared canvas was built, from nothing to now (web/docs/share-build-replay.md) — only when the owner allowed it when sharing. Times are counted from the first step."""
        share = share_for(request)
        if share is None or not share.buildReplay:
            return forbidden(request)
        try:
            return build_log.build_timeline(store, share.canvasId, relative=True)
        except ValueError:
            return forbidden(request)

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
        cid = body.get("canvasId") or share.canvasId
        if not isinstance(cid, str) or cid not in reach(share):
            return forbidden(request)
        now = int(time.time() * 1000)
        actor = f"guest:{guest}"
        kind = body.get("op")
        try:
            mid = body.get("id")
            if not isinstance(mid, str) or not ID_RE.match(mid) or len(mid) > 32:
                raise ValueError("id must be a short [A-Za-z0-9._-] string")
            if kind in ("create", "reply"):
                by = {"id": actor, "name": clean_text(body.get("name"), MAX_NAME, "name")}
                msg = {"id": mid, "author": "human", "by": by, "text": clean_text(body.get("text"), MAX_TEXT, "text"), "at": now}
            if kind == "create":
                scene = store.read("canvas", cid)
                element_ids = {e.get("id") for e in (scene or ({}, ""))[0].get("elements") or [] if not e.get("isDeleted")}
                tid = body.get("threadId")
                if not isinstance(tid, str) or not ID_RE.match(tid) or len(tid) > 32:
                    raise ValueError("threadId must be a short [A-Za-z0-9._-] string")
                anchor = None if body.get("anchor") is None else clean_anchor(body.get("anchor"), element_ids)  # None: a comment on the whole canvas
                moment = None if body.get("moment") is None else clean_moment(body.get("moment"))
                if moment is not None and not share.buildReplay:
                    raise ValueError("this share has no build replay to comment on")
                op = {"op": "create", "thread": {"id": tid, "anchor": anchor, **({"moment": moment} if moment else {}), "resolved": False, "createdAt": now, "createdBy": by, "messages": [msg]}}
            elif kind == "reply":
                op = {"op": "reply", "threadId": body.get("threadId"), "message": msg}
            elif kind == "edit":
                op = {"op": "edit", "threadId": body.get("threadId"), "id": mid, "text": clean_text(body.get("text"), MAX_TEXT, "text"), "actor": actor, "at": now}
            elif kind == "delete":
                op = {"op": "delete", "threadId": body.get("threadId"), "id": mid, "actor": actor, "at": now}
            elif kind == "restore":
                edited = body.get("editedAt")
                op = {"op": "restore", "threadId": body.get("threadId"), "id": mid, "text": clean_text(body.get("text"), MAX_TEXT, "text"), "actor": actor, "at": now,
                      **({"editedAt": int(finite(edited, 0, 1e14))} if edited is not None else {})}
            else:
                raise ValueError("op must be create, reply, edit, delete or restore")
            data, version, thread = await asyncio.to_thread(store.thread_op, cid, op)
        except NotFound:
            return JSONResponse({"error": "no such thread or message"}, status_code=404)
        except NotYours:
            return JSONResponse({"error": "you can only change your own messages"}, status_code=403)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        if kind in ("create", "reply"):
            shares.note_comment(share)
        events.publish({"t": "threads", "canvasId": cid, "data": data, "version": version})
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
        allowed = reach(share)
        sub = events.subscribe(lambda ev: ev.get("canvasId") in allowed or ev.get("t") == "shares")
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
                        yield f"data: {json.dumps({'t': 'threads', 'canvasId': ev['canvasId'], 'open': open_count(ev['canvasId']), 'data': guest_threads(ev['data'])}, ensure_ascii=False)}\n\n"
                    elif ev.get("t") == "canvas":
                        allowed = reach(share)  # the owner may have linked or unlinked a child
                        scene = store.read("canvas", ev["canvasId"])
                        yield f"data: {json.dumps({'t': 'canvas', 'canvasId': ev['canvasId'], 'elements': guest_elements((scene or ({}, ''))[0].get('elements') or [], allowed)}, ensure_ascii=False)}\n\n"
            finally:
                events.unsubscribe(sub)
                streams[share.id] = max(0, streams.get(share.id, 1) - 1)

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"cache-control": "no-store", "x-accel-buffering": "no"})

    @app.api_route("/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
    def everything_else(rest: str, request: Request):
        return forbidden(request)

    return app
