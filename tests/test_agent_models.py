"""Effort levels per agent and model come from each CLI's own catalog (agent_models.py).

Fixtures in tests/fixtures/efforts/ are recorded outputs (2026-09-28): Claude Code 2.1.283's
``initialize`` response and ``--help``, Pi 0.87.1's RPC ``get_available_models`` (a subset) and
``--help``, and Codex's ``models_cache.json`` (slugs and reasoning levels only)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.canvas import agent_models as am
from server.canvas import agents

FIX = Path(__file__).parent / "fixtures" / "efforts"


def load(name):
    text = (FIX / name).read_text()
    return json.loads(text) if name.endswith(".json") else text


def test_help_choices_read_the_cli_vocabulary():
    assert am.help_choices(load("claude-help.txt"), "--effort") == ["low", "medium", "high", "xhigh", "max"]
    assert am.help_choices(load("pi-help.txt"), "--thinking") == ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    assert am.help_choices("no such flag here", "--effort") == []


def test_codex_levels_per_model_from_models_cache():
    cat = am.codex_catalog_from(load("codex-models_cache.json"), {"model_reasoning_effort": "xhigh"})
    assert cat["models"][:3] == ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]  # Codex's own priority order
    assert "gpt-reserve" not in cat["models"] and "codex-auto-review" not in cat["models"]  # hidden
    assert cat["modelEfforts"]["gpt-6-astra"] == ["low", "medium", "high", "xhigh", "max", "ultra"]
    assert "max" in cat["modelEfforts"]["gpt-6-luna"] and "ultra" not in cat["modelEfforts"]["gpt-6-luna"]
    assert cat["modelEfforts"]["gpt-5.5"] == ["low", "medium", "high", "xhigh"]  # no max for this one
    # config.toml's effort is the default where the model takes it
    assert cat["modelDefaultEffort"]["gpt-6-astra"] == "xhigh"
    # otherwise the model's own default_reasoning_level
    plain = am.codex_catalog_from(load("codex-models_cache.json"), {})
    assert plain["modelDefaultEffort"]["gpt-6-sol"] == "low" and plain["modelDefaultEffort"]["gpt-6-astra"] == "medium"
    tight = am.codex_catalog_from(load("codex-models_cache.json"), {"model_reasoning_effort": "max"})
    assert tight["modelDefaultEffort"]["gpt-5.5"] == "medium"
    # "" (no -m) is the first model; no cache → no levels at all, never a made-up list
    assert cat["modelEfforts"][""] == cat["modelEfforts"]["gpt-6-astra"]
    empty = am.codex_catalog_from(None, {})
    assert empty["models"] == [] and empty["efforts"] == [] and empty["modelEfforts"][""] == []


def test_claude_levels_per_model_from_initialize():
    settings = {"model": "claude-opus-5-5", "modelSettings": {"claude-sonnet-5": {"effortLevel": "high"}, "claude-fable-5-1": {"effortLevel": "xhigh"}}}
    cat = am.claude_catalog_from(load("claude-initialize.json"), settings, ["low", "medium", "high", "xhigh", "max"])
    assert cat["effortSource"] == "claude initialize"
    assert cat["models"][0] == "claude-opus-5-5" and "default" not in cat["models"]
    assert cat["modelEfforts"]["opus"] == ["low", "medium", "high", "xhigh", "max"]
    assert cat["modelEfforts"]["claude-opus-5-5"] == ["low", "medium", "high", "xhigh", "max"]  # via resolvedModel
    assert cat["modelEfforts"]["claude-opus-4-6"] == ["low", "medium", "high", "max"]  # no xhigh
    assert cat["modelEfforts"]["haiku"] == []  # effort not supported
    # per-model defaults from modelSettings, matched by alias or resolved id
    assert cat["modelDefaultEffort"]["sonnet"] == "high" and cat["modelDefaultEffort"]["claude-fable-5-1"] == "xhigh"
    assert cat["modelDefaultEffort"]["opus"] == "" and cat["modelDefaultEffort"]["haiku"] == ""


def test_claude_falls_back_to_help_levels():
    cat = am.claude_catalog_from(None, {}, am.help_choices(load("claude-help.txt"), "--effort"))
    assert cat["effortSource"] == "claude --help"
    assert cat["models"] == ["opus", "sonnet", "haiku"]
    assert cat["modelEfforts"]["sonnet"] == ["low", "medium", "high", "xhigh", "max"]


def test_pi_levels_follow_pis_own_rule():
    rpc = load("pi-rpc-models.json")["data"]["models"]
    order = am.help_choices(load("pi-help.txt"), "--thinking")
    settings = {"defaultProvider": "magpie", "defaultModel": "group/opus-5-5", "defaultThinkingLevel": "medium", "enabledModels": ["magpie/group/opus-5-5", "magpie/group/gpt-6-sol"]}
    cat = am.pi_catalog_from(rpc, settings, order)
    lv = cat["modelEfforts"]
    assert lv["magpie/group/opus-5-5"] == ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    assert lv["deepseek/deepseek-v4-pro"] == ["off", "high", "max"]  # null-mapped levels dropped
    assert lv["openrouter/openai/gpt-5"] == ["minimal", "low", "medium", "high"]  # off → null, no xhigh/max
    assert lv["openrouter/openai/gpt-5-pro"] == ["high"]
    assert lv["openrouter/anthropic/claude-opus-4.1"] == ["off", "minimal", "low", "medium", "high"]  # no map: no xhigh/max
    assert lv["openrouter/openai/gpt-5.2-chat"] == ["off"]  # not a reasoning model
    assert cat["featured"] == settings["enabledModels"] and cat["models"][0] == "magpie/group/opus-5-5"
    # defaultThinkingLevel clamped the way Pi clamps it: next higher supported, else next lower
    assert cat["modelDefaultEffort"]["magpie/group/opus-5-5"] == "medium"
    assert cat["modelDefaultEffort"]["deepseek/deepseek-v4-pro"] == "high"
    assert cat["modelDefaultEffort"]["openrouter/openai/gpt-5-pro"] == "high"
    assert am.pi_clamp("max", ["minimal", "low", "medium", "high"]) == "high"


def test_pi_falls_back_to_list_models():
    cat = am.pi_catalog_from(None, {}, am.help_choices(load("pi-help.txt"), "--thinking"), [("a/think", True), ("a/plain", False)])
    assert cat["modelEfforts"]["a/think"] == ["off", "minimal", "low", "medium", "high"]
    assert cat["modelEfforts"]["a/plain"] == ["off"]


@pytest.fixture
def recorded_catalog(monkeypatch):
    cat = {
        "pi": am.pi_catalog_from(load("pi-rpc-models.json")["data"]["models"], {}, am.help_choices(load("pi-help.txt"), "--thinking")),
        "claude": am.claude_catalog_from(load("claude-initialize.json"), {}, []),
        "codex": am.codex_catalog_from(load("codex-models_cache.json"), {}),
    }
    for k in cat:
        cat[k] = {"kind": k, "name": agents.NAMES[k], "installed": True, **cat[k]}
    monkeypatch.setattr(agents, "catalog", lambda ttl_s=600: cat)
    return cat


def test_check_effort_refuses_levels_the_model_does_not_take(recorded_catalog):
    agents.check_effort("codex", "gpt-6-astra", "max")
    agents.check_effort("codex", "gpt-6-astra", "")  # CLI default is always allowed
    with pytest.raises(ValueError, match="不支持强度 max"):
        agents.check_effort("codex", "gpt-5.5", "max")
    with pytest.raises(ValueError):
        agents.check_effort("claude", "haiku", "low")
    with pytest.raises(ValueError):
        agents.check_effort("pi", "openrouter/openai/gpt-5-pro", "low")
    agents.check_effort("pi", "openrouter/openai/gpt-5-pro", "high")


def test_bind_api_rejects_an_unsupported_effort(recorded_catalog, tmp_path):
    from server.canvas.project import ProjectStore
    from server.canvas.project_router import create_project_app

    s = ProjectStore(tmp_path / "proj")
    s.init()
    c = TestClient(create_project_app(s.root))
    r = c.put("/api/agent/sessions/s-x", json={"agent": "codex", "model": "gpt-5.5", "effort": "max"})
    assert r.status_code == 400 and "gpt-5.5" in r.json()["error"]
    assert s.read_binding("s-x") is None
    assert c.put("/api/agent/sessions/s-x", json={"agent": "codex", "model": "gpt-6-astra", "effort": "max"}).status_code == 200
