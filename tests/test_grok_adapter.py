"""Grok adapter (v2, behind AGORA_EXPERIMENTAL=grok): off by default, observed only. Its recorded
fixture runs through the shared contract test (tests/test_adapter_contracts.py turns the flag on)."""

from server.canvas import adapters
from server.canvas.adapters import registry
from server.canvas.adapters.grok import enc_cwd


def test_grok_is_off_by_default(monkeypatch):
    monkeypatch.delenv("AGORA_EXPERIMENTAL", raising=False)
    registry.refresh()
    assert "grok" not in registry.ADAPTERS
    assert [a["kind"] for a in registry.adapter_infos(with_versions=False)] == ["pi", "claude", "codex"]


def test_grok_is_observed_only_when_enabled(monkeypatch):
    monkeypatch.setenv("AGORA_EXPERIMENTAL", "grok")
    registry.refresh()
    try:
        g = adapters.need("grok")
        assert adapters.implemented_tier(g) == "T2" and "grok" not in adapters.session_kinds()
        assert enc_cwd("/private/tmp/x y") == "%2Fprivate%2Ftmp%2Fx%20y"
    finally:
        monkeypatch.delenv("AGORA_EXPERIMENTAL")
        registry.refresh()
