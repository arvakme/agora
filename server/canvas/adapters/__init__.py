"""CLI adapters: one module per coding-agent CLI (web/docs/cli-adapters.md).

``registry.ADAPTERS`` lists them; ``agents.py`` and ``transcript.py`` keep their old entry points
as forwarding shims."""

from server.canvas.adapters.registry import ADAPTERS, by_seedmux_name, get, implemented_tier, info, need, register, session_kinds

__all__ = ["ADAPTERS", "by_seedmux_name", "get", "implemented_tier", "info", "need", "register", "session_kinds"]
