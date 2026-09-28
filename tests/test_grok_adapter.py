"""Grok adapter (v2, behind AGORA_EXPERIMENTAL=grok): off by default; when enabled, its recorded
fixture (1.0.41, a spawn_subagent run) passes the same contract as every other adapter."""

import pytest

from server.canvas import adapters
from server.canvas.adapters import registry
from server.canvas.adapters.grok import GrokAdapter, enc_cwd
from tests import test_adapter_contracts as contracts
from tests.agent_fixtures import versions


def test_grok_is_off_by_default():
    from server.canvas.adapters.experimental import enabled

    if not enabled("grok"):
        assert "grok" not in registry.ADAPTERS
        assert [a["kind"] for a in registry.adapter_infos(with_versions=False)] == ["pi", "claude", "codex"]


@pytest.fixture()
def grok():
    had = registry.ADAPTERS.get("grok")
    registry.register(GrokAdapter())
    yield adapters.need("grok")
    if had is None:
        registry.ADAPTERS.pop("grok", None)


@pytest.mark.parametrize("folder", versions("grok"), ids=lambda p: p.name)
def test_grok_fixture_contract(grok, folder, home):
    contracts.test_fixture_contract("grok", folder, home)


def test_grok_is_observed_only(grok):
    assert adapters.implemented_tier(grok) == "T2" and "grok" not in adapters.session_kinds()
    assert enc_cwd("/private/tmp/x y") == "%2Fprivate%2Ftmp%2Fx%20y"


home = contracts.home
