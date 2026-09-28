"""Every adapter Agora ships, and the tier each one reaches (web/docs/cli-adapters.md §2).

A tier is not a label on a CLI: it is computed from the capabilities its adapter implements,
capped by ``max_tier`` (the user decided which CLIs may be session agents), and — once drift is
known (drift.py) — what it *would* degrade to is reported alongside (notify-only for now).
"""

from __future__ import annotations

from server.canvas.adapters.base import TIERS, Adapter, Binding, Catalog, Headless, Interactive, Locator, Projector, Tier, ToolVocab
from server.canvas.adapters.claude import ClaudeAdapter
from server.canvas.adapters.codex import CodexAdapter
from server.canvas.adapters.pi import PiAdapter

# Order matters: the first three are the session agents, in the order the picker shows them.
ADAPTERS: dict[str, Adapter] = {a.kind: a for a in (PiAdapter(), ClaudeAdapter(), CodexAdapter())}


def register(a: Adapter) -> Adapter:
    ADAPTERS[a.kind] = a
    return a


def get(kind: str | None) -> Adapter | None:
    return ADAPTERS.get(kind or "")


def need(kind: str) -> Adapter:
    a = ADAPTERS.get(kind)
    if a is None:
        raise ValueError(f"unknown agent {kind!r}")
    return a


def implemented_tier(a: Adapter) -> Tier:
    """The highest tier the adapter's capabilities reach, capped by its ``max_tier``."""
    t2 = isinstance(a, Locator) and isinstance(a, Projector) and isinstance(a, ToolVocab)
    t1 = t2 and isinstance(a, Headless) and isinstance(a, Interactive) and isinstance(a, Catalog) and isinstance(a, Binding)
    got: Tier = "T1" if t1 else "T2" if t2 else "T3" if getattr(a, "receipts_only", False) else "T0"
    return got if TIERS.index(got) >= TIERS.index(a.max_tier) else a.max_tier


def session_kinds() -> tuple[str, ...]:
    """Kinds an Agora session can be bound to (T1)."""
    return tuple(k for k, a in ADAPTERS.items() if implemented_tier(a) == "T1")


def by_seedmux_name(name: str | None) -> Adapter | None:
    """The adapter Seedmux's ``meta.agent`` (``cursor-agent``, ``claude``…) refers to."""
    n = (name or "").strip()
    for a in ADAPTERS.values():
        if n == a.kind or n in a.seedmux_names:
            return a
    return None
