"""Grok adapter: registered by default since its contract held against the installed 1.0.41 (2026-09-29),
observed only (T2). Its recorded fixture runs through the shared contract test."""

from server.canvas import adapters
from server.canvas.adapters import registry
from server.canvas.adapters.grok import enc_cwd


def test_grok_is_registered_and_observed_only():
    registry.refresh()
    g = adapters.need("grok")
    assert adapters.implemented_tier(g) == "T2" and "grok" not in adapters.session_kinds()
    assert enc_cwd("/private/tmp/x y") == "%2Fprivate%2Ftmp%2Fx%20y"


def test_memory_bookkeeping_records_are_known():
    """Seen in the local 1.0.41 logs after the fixture was recorded: memory flushes carry no content."""
    g = adapters.need("grok")
    for t in ("memory_flush_started", "memory_flush_completed", "memory_session_saved"):
        assert g.record_type({"params": {"update": {"sessionUpdate": t}}}) in g.known_types
