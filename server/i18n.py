"""The language of the words the server and the CLI write for a person: Chinese (zh) or English (en).

``tr("保存失败", "Save failed")`` picks one at the call site, the same shape as the page's ``tr`` (web/src/i18n).
Which one, in this order:

1. the request being answered: an ``X-Agora-Lang`` header (the CLI sends its own language), else the
   ``agora_lang`` cookie the page sets for its interface language, else the browser's ``Accept-Language``;
2. outside a request (a turn's notices, a receipt written when a dispatch ends, a terminal title): the language
   the owner's page last sent, so what the server says on its own follows the page;
3. the process's locale: ``AGORA_LANG``, then ``LC_ALL`` / ``LC_MESSAGES`` / ``LANG`` (zh* → zh, anything else → en),
   English when none is set. This is what the CLI uses.

Machine-read text (exit codes, JSON keys, markers such as ``agora-page[…]``) never goes through here.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Literal

Lang = Literal["zh", "en"]

HEADER = b"x-agora-lang"
COOKIE = "agora_lang"

_request: ContextVar[Lang | None] = ContextVar("agora_lang", default=None)
#: What the owner's page last said (its cookie); ``None`` until a page has asked for anything.
_page: Lang | None = None


def parse(value: str | None) -> Lang | None:
    """``zh``, ``zh-CN``, ``zh_TW.UTF-8`` → zh; any other language tag → en; nothing → None."""
    v = (value or "").strip().lower()
    if not v:
        return None
    return "zh" if v.startswith("zh") else "en"


def env_lang(env: Mapping[str, str] | None = None) -> Lang:
    env = os.environ if env is None else env
    for key in ("AGORA_LANG", "LC_ALL", "LC_MESSAGES", "LANG"):
        got = parse(env.get(key))
        if got:
            return got
    return "en"


def lang() -> Lang:
    return _request.get() or _page or env_lang()


def tr(zh: str, en: str) -> str:
    """The string for the current language (Chinese first, as in the page)."""
    return en if lang() == "en" else zh


def remember(value: Lang | None) -> None:
    """Set what the owner's page last said (tests reset it with ``None``)."""
    global _page
    _page = value


def _cookie(header: str) -> Lang | None:
    for part in header.split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE:
            return parse(v)
    return None


def _accept_language(header: str) -> Lang | None:
    return parse(header.split(",")[0].split(";")[0])


class LangMiddleware:
    """ASGI middleware: the language of each HTTP or WebSocket request, for ``tr`` while it is answered (and for
    tasks it starts). ``remember``: this app is the owner's, so its page's cookie also becomes the language the
    server uses on its own (the share gateway's guests are other people and don't set it)."""

    def __init__(self, app, *, remember: bool = True) -> None:
        self.app = app
        self.remember = remember

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        cookie = _cookie(headers.get(b"cookie", b"").decode("latin-1"))
        if cookie and self.remember:
            remember(cookie)
        chosen = parse(headers.get(HEADER, b"").decode("latin-1")) or cookie or _accept_language(headers.get(b"accept-language", b"").decode("latin-1"))
        token = _request.set(chosen)
        try:
            await self.app(scope, receive, send)
        finally:
            _request.reset(token)
