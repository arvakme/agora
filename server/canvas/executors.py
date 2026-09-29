"""Which open Agora page executes a canvas edit (BR1). Pure: the hub (sessions.py) keeps the pages.

``agora canvas read/apply/anim/…`` are run by a page (it holds the canvas, validates, records the undo step). The
newest connection used to get every request; a page the browser froze in a background tab then took the edit and
never answered. A page reports whether it is visible and when it was last focused; the order is

1. a page that answered the last time it was asked (one that did not goes behind all the others until it answers once again),
2. a visible page,
3. the page focused most recently,
4. the page connected most recently.

A page that never said whether it is visible counts as not visible.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

# How long a page has to take a request before it is offered to the next one; the total limit stays sessions.BRIDGE_TIMEOUT_S.
PAGE_REPLY_S = 6.0


@dataclass
class Page:
    id: str
    at: float  # when it connected
    visible: bool | None = None
    focused_at: float = 0.0
    answered_at: float | None = None  # last time it took a request
    failed_at: float | None = None  # last time it did not


def failing(p: Any) -> bool:
    return p.failed_at is not None and (p.answered_at is None or p.failed_at > p.answered_at)


def order(pages: Iterable[Any]) -> Sequence[Any]:
    """The pages in the order requests are offered to them (duck-typed: ``Page`` or the hub's subscribers)."""
    return sorted(pages, key=lambda p: (failing(p), p.visible is not True, -p.focused_at, -p.at))
