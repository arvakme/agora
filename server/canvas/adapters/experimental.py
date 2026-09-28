"""v2 features that are finished and isolated but not part of v1 (scope decided 2026-09-28): off
unless ``AGORA_EXPERIMENTAL`` names them (comma-separated, or ``all``).

- ``grok``: the Grok adapter (T2, observed only) — registry.py registers it only when enabled.
- ``seedmux-receipts``: Seedmux tickets as T3 runs in ``/api/agent/runs`` (receipts.py).

Backlog and what is still missing: web/docs/cli-adapters.md §9.
"""

from __future__ import annotations

import os

FLAGS = {
    "grok": "Grok adapter (T2): trajectory, native sub-agents, Seedmux sid",
    "seedmux-receipts": "Seedmux tickets as T3 runs linked to the dispatching session (read-only)",
}


def enabled(name: str) -> bool:
    raw = os.environ.get("AGORA_EXPERIMENTAL", "")
    on = {x.strip() for x in raw.split(",") if x.strip()}
    return "all" in on or name in on
