"""Every adapter Agora ships, and the tier each one reaches (web/docs/cli-adapters.md §2).

A tier is not a label on a CLI: it is computed from the capabilities its adapter implements,
capped by ``max_tier`` (the user decided which CLIs may be session agents), and — once drift is
known (drift.py) — what it *would* degrade to is reported alongside (notify-only for now).
"""

from __future__ import annotations

from typing import Any

from server.canvas.adapters.base import TIERS, Adapter, Binding, Catalog, Headless, Interactive, Locator, Projector, Subagents, Tier, ToolVocab
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


def info(a: Adapter, *, version: str | None = None, installed: bool | None = None) -> dict[str, Any]:
    """``AgentInfo`` for the page (web/src/session/agents.ts): what the CLI is, which tier it reaches
    and what the page may rely on. Degradation (drift.py) is added by the caller."""
    tier = implemented_tier(a)
    return {
        "kind": a.kind,
        "name": a.name,
        "tier": tier,
        "maxTier": a.max_tier,
        "installed": (a.installed() is not None) if installed is None else installed,
        **({"version": version} if version else {}),
        "tested": a.tested.label(),
        "testedSpec": a.tested.spec,
        "caps": {
            "headless": isinstance(a, Headless),
            "terminal": isinstance(a, Interactive),
            "catalog": isinstance(a, Catalog),
            "subagents": isinstance(a, Subagents),
            "forkHeadless": bool(getattr(a, "can_fork_headless", False)),
            "cost": a.has_cost,
            "waits": a.waits,
        },
        "icon": {"kind": "mark", "src": a.icon or a.kind},
        "logDir": a.log_dir,
        "deleteCommand": a.delete_hint or None,
        "seedmuxNames": list(a.seedmux_names),
    }


_versions: dict[str, tuple[float, str | None]] = {}


def cached_version(a: Adapter, env: dict[str, str] | None = None, ttl_s: float = 600) -> str | None:
    """``a.version()`` (``<binary> --version``), cached for ``ttl_s``: never on a hot path."""
    import time

    hit = _versions.get(a.kind)
    if hit is None or time.time() - hit[0] > ttl_s:
        hit = (time.time(), a.version(env))
        _versions[a.kind] = hit
    return hit[1]


def adapter_infos(root: Any = None, *, with_versions: bool = True, with_catalog: bool = False) -> list[dict[str, Any]]:
    """``AgentInfo`` for every adapter (``GET /api/agent/adapters``)."""
    from server.canvas import agents

    cat = agents.catalog(root) if with_catalog else {}
    out = []
    for a in ADAPTERS.values():
        inst = a.installed() is not None
        d = info(a, version=cached_version(a, agents.child_env()) if with_versions and inst else None, installed=inst)
        if a.kind in cat:
            d["catalog"] = cat[a.kind]
        out.append(d)
    return out


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
