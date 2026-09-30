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
    wide = am.pi_catalog_from(rpc, {"defaultThinkingLevel": "medium"}, order)  # no scope: every available model
    lv = wide["modelEfforts"]
    assert lv["magpie/group/opus-5-5"] == ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    assert lv["deepseek/deepseek-v4-pro"] == ["off", "high", "max"]  # null-mapped levels dropped
    assert lv["openrouter/openai/gpt-5"] == ["minimal", "low", "medium", "high"]  # off → null, no xhigh/max
    assert lv["openrouter/openai/gpt-5-pro"] == ["high"]
    assert lv["openrouter/anthropic/claude-opus-4.1"] == ["off", "minimal", "low", "medium", "high"]  # no map: no xhigh/max
    assert lv["openrouter/openai/gpt-5.2-chat"] == ["off"]  # not a reasoning model
    assert cat["featured"] == settings["enabledModels"] == cat["models"]  # only Pi's own scope
    # defaultThinkingLevel clamped the way Pi clamps it: next higher supported, else next lower
    assert cat["modelDefaultEffort"]["magpie/group/opus-5-5"] == "medium"
    assert wide["modelDefaultEffort"]["deepseek/deepseek-v4-pro"] == "high"
    assert wide["modelDefaultEffort"]["openrouter/openai/gpt-5-pro"] == "high"
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
    monkeypatch.setattr(agents, "catalog", lambda root=None, ttl_s=600: cat)
    return cat


def test_check_binding_refuses_levels_the_model_does_not_take(recorded_catalog):
    agents.check_binding("codex", "gpt-6-astra", "max")
    agents.check_binding("codex", "gpt-6-astra", "")  # CLI default is always allowed
    with pytest.raises(ValueError, match="不支持强度 max"):
        agents.check_binding("codex", "gpt-5.5", "max")
    with pytest.raises(ValueError):
        agents.check_binding("claude", "haiku", "low")
    with pytest.raises(ValueError):
        agents.check_binding("pi", "openrouter/openai/gpt-5-pro", "low")
    agents.check_binding("pi", "openrouter/openai/gpt-5-pro", "high")


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


# ——— Pi's model scope: enabledModels (Pi 0.87.1 model-resolver.js / settings-manager.js) ———
def rpc_models():
    rows = load("pi-rpc-models.json")["data"]["models"]
    batch = {**next(m for m in rows if m["id"] == "anthropic/claude-opus-4.6"), "id": "anthropic/claude-opus-4.6:batch", "name": "Anthropic: Claude Opus 4.6 (batch)"}
    return [*rows, batch]


def pi_cat(settings, **kw):
    return am.pi_catalog_from(rpc_models(), settings, am.help_choices(load("pi-help.txt"), "--thinking"), **kw)


MAGPIE = ["magpie/group/opus-5-5", "magpie/group/fable-5-1", "magpie/group/gpt-6-sol", "magpie/group/gpt-6-astra"]


def test_pi_lists_only_enabled_models_and_starts_on_the_saved_default():
    cat = pi_cat({"defaultProvider": "magpie", "defaultModel": "group/fable-5-1", "enabledModels": MAGPIE}, source="/x/settings.json")
    assert cat["models"] == MAGPIE and cat["allowed"] == MAGPIE and cat["featured"] == MAGPIE
    assert not any(m.startswith(("openrouter/", "deepseek/")) for m in cat["modelEfforts"] if m)
    assert cat["default"] == "magpie/group/fable-5-1"
    assert cat["scope"] == {"kind": "enabledModels", "source": "/x/settings.json", "patterns": MAGPIE}
    assert cat["names"]["magpie/group/opus-5-5"] == "Opus 5.5 · routing group"
    assert cat["providers"]["magpie/group/gpt-6-sol"] == "magpie"
    # a saved default outside the scope: Pi starts on the first scoped model instead
    assert pi_cat({"defaultProvider": "deepseek", "defaultModel": "deepseek-v4-pro", "enabledModels": MAGPIE})["default"] == MAGPIE[0]


def test_pi_scope_patterns_follow_pi_globs_fuzzy_and_thinking_suffixes():
    scope = lambda *p: pi_cat({"enabledModels": list(p)})["models"]  # noqa: E731
    # minimatch: * stays inside one segment, ** crosses; case-insensitive; braces expand
    assert scope("magpie/*") == []
    assert sorted(scope("magpie/**")) == sorted(MAGPIE)
    assert scope("MAGPIE/group/{opus,fable}-*") == ["magpie/group/opus-5-5", "magpie/group/fable-5-1"]
    assert scope("magpie/group/[!og]*") == ["magpie/group/fable-5-1"]
    # globs skip non-interactive variants; naming one exactly keeps it
    assert scope("openrouter/anthropic/*") == ["openrouter/anthropic/claude-opus-4.1", "openrouter/anthropic/claude-opus-4.6"]
    assert scope("openrouter/*") == []  # the id has its own "/": * cannot reach past it
    assert "openrouter/anthropic/claude-opus-4.6:batch" not in scope("openrouter/**")
    assert scope("openrouter/anthropic/claude-opus-4.6:batch") == ["openrouter/anthropic/claude-opus-4.6:batch"]
    # bare ids and fuzzy matches (id or name substring), unmatched patterns ignored, no duplicates
    assert scope("deepseek-v4-pro", "GPT-5 Pro", "no-such-model", "deepseek/deepseek-v4-pro") == ["deepseek/deepseek-v4-pro", "openrouter/openai/gpt-5-pro"]
    # a thinking suffix pins that model's starting level (clamped to what it takes)
    cat = pi_cat({"enabledModels": ["magpie/group/*:high", "deepseek/deepseek-v4-pro:low"], "defaultThinkingLevel": "minimal"})
    assert cat["modelDefaultEffort"]["magpie/group/opus-5-5"] == "high"
    assert cat["modelDefaultEffort"]["deepseek/deepseek-v4-pro"] == "high"  # low → next higher it takes
    # modelThinkingLevels comes before defaultThinkingLevel
    per = pi_cat({"enabledModels": MAGPIE, "defaultThinkingLevel": "low", "modelThinkingLevels": {"magpie/group/gpt-6-sol": "xhigh"}})
    assert per["modelDefaultEffort"]["magpie/group/gpt-6-sol"] == "xhigh" and per["modelDefaultEffort"]["magpie/group/opus-5-5"] == "low"


def test_pi_without_enabled_models_lists_available_models_minus_batch():
    cat = pi_cat({"defaultProvider": "magpie", "defaultModel": "group/opus-5-5"})
    assert cat["scope"]["kind"] == "available"
    assert len(cat["models"]) == len(rpc_models()) - 1 and "openrouter/anthropic/claude-opus-4.6:batch" not in cat["models"]
    assert cat["default"] == "magpie/group/opus-5-5" and cat["featured"] == ["magpie/group/opus-5-5"]
    # a saved default Pi cannot run (no credentials → not available) is not offered
    none = pi_cat({"defaultProvider": "anthropic", "defaultModel": "claude-opus-4-8"})
    assert none["default"] == "" and none["featured"] == [] and "anthropic/claude-opus-4-8" not in none["models"]


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def test_pi_project_settings_override_global_only_when_trusted(tmp_path):
    agent, proj = tmp_path / "agent", tmp_path / "proj"
    write(agent / "settings.json", {"defaultProvider": "magpie", "defaultModel": "group/opus-5-5", "enabledModels": MAGPIE})
    write(proj / ".pi" / "settings.json", {"enabledModels": ["deepseek/*"], "defaultThinkingLevel": "high"})
    # not trusted (no decision, defaultProjectTrust "ask"): the project file is skipped, as in RPC / print mode
    settings, source = am.pi_settings(agent, proj)
    assert settings["enabledModels"] == MAGPIE and source == str(agent / "settings.json")
    # a saved decision for a parent directory applies; the project array replaces the global one
    write(agent / "trust.json", {str(tmp_path.resolve()): True})
    settings, source = am.pi_settings(agent, proj)
    assert settings["enabledModels"] == ["deepseek/*"] and settings["defaultModel"] == "group/opus-5-5"
    assert source == str(proj / ".pi" / "settings.json")
    assert pi_cat(settings, source=source)["models"] == ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]
    # the closest decision wins
    write(agent / "trust.json", {str(tmp_path.resolve()): True, str(proj.resolve()): False})
    assert am.pi_settings(agent, proj)[0]["enabledModels"] == MAGPIE
    # no saved decision but defaultProjectTrust "always"
    (agent / "trust.json").unlink()
    write(agent / "settings.json", {"enabledModels": MAGPIE, "defaultProjectTrust": "always"})
    assert am.pi_settings(agent, proj)[0]["enabledModels"] == ["deepseek/*"]
    # a project that clears the list ([]) turns the scope off: back to every available model
    write(proj / ".pi" / "settings.json", {"enabledModels": []})
    settings, source = am.pi_settings(agent, proj)
    assert source == "" and pi_cat(settings)["scope"]["kind"] == "available"
    # no global file at all
    assert am.pi_settings(tmp_path / "none", None) == ({}, "")


def test_model_refusal_keeps_each_agent_to_its_catalog():
    pi = {"kind": "pi", "name": "Pi", **pi_cat({"enabledModels": MAGPIE}, source="/home/.pi/agent/settings.json")}
    assert am.model_refusal(pi, "magpie/group/gpt-6-sol") is None and am.model_refusal(pi, "") is None
    why = am.model_refusal(pi, "openrouter/openai/gpt-5")
    assert "enabledModels" in why and "/home/.pi/agent/settings.json" in why and "magpie/group/opus-5-5" in why
    wide = {"kind": "pi", "name": "Pi", **pi_cat({})}
    assert "未配置凭据" in am.model_refusal(wide, "anthropic/claude-opus-4-8")
    assert am.model_refusal(wide, "openrouter/anthropic/claude-opus-4.6:batch")
    claude = {"kind": "claude", "name": "Claude Code", **am.claude_catalog_from(load("claude-initialize.json"), {"model": "claude-opus-5-5[1m]"}, [])}
    assert am.model_refusal(claude, "claude-opus-5-5[1m]") is None  # the configured custom name
    assert am.model_refusal(claude, "claude-haiku-4-5-20251001") is None  # what an alias resolves to
    assert "gpt-6" in am.model_refusal(claude, "gpt-6")
    assert claude["names"]["opus"] == "Opus 5.5" and claude["names"]["claude-sonnet-5"] == "Sonnet 5" and claude["featured"][:4] == ["claude-opus-5-5[1m]", "opus", "sonnet", "haiku"]
    assert am.model_refusal({"kind": "claude", **am.claude_catalog_from(None, {}, [])}, "anything") is None  # nothing known
    codex = {"kind": "codex", "name": "Codex", **am.codex_catalog_from(load("codex-models_cache.json"), {})}
    assert am.model_refusal(codex, "gpt-reserve") is None  # hidden, but -m takes it
    assert am.model_refusal(codex, "gpt-9")
    assert codex["names"]["gpt-6-astra"] == "GPT-6-Astra"


def test_bind_api_refuses_a_pi_model_outside_enabled_models(monkeypatch, tmp_path):
    from server.canvas.project import ProjectStore
    from server.canvas.project_router import create_project_app

    cat = {k: {"kind": k, "name": agents.NAMES[k], "installed": True, **v} for k, v in {
        "pi": pi_cat({"enabledModels": MAGPIE}, source="~/.pi/agent/settings.json"),
        "claude": am.claude_catalog_from(load("claude-initialize.json"), {}, []),
        "codex": am.codex_catalog_from(load("codex-models_cache.json"), {}),
    }.items()}
    seen = []
    monkeypatch.setattr(agents, "catalog", lambda root=None, ttl_s=600: (seen.append(root), cat)[1])
    s = ProjectStore(tmp_path / "proj")
    s.init()
    c = TestClient(create_project_app(s.root))
    r = c.put("/api/agent/sessions/s-p", json={"agent": "pi", "model": "openrouter/openai/gpt-5", "effort": ""})
    assert r.status_code == 400 and "enabledModels" in r.json()["error"] and s.read_binding("s-p") is None
    assert seen and seen[-1] == s.root  # the project's own scope (.pi/settings.json) is used
    assert c.put("/api/agent/sessions/s-p", json={"agent": "pi", "model": "magpie/group/gpt-6-sol", "effort": "high"}).status_code == 200
    assert c.put("/api/agent/sessions/s-c", json={"agent": "codex", "model": "gpt-9", "effort": ""}).status_code == 400
    assert c.put("/api/agent/sessions/s-d", json={"agent": "claude", "model": "", "effort": ""}).status_code == 200  # CLI default
