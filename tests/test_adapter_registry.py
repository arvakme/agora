"""The adapter registry: tiers computed from capabilities, and ``GET /api/agent/adapters``."""

from fastapi.testclient import TestClient

from server.canvas import adapters, agents
from server.canvas.adapters import registry
from server.canvas.adapters.base import Adapter, VersionRange, parse_version
from server.canvas.project import AGENT_KINDS, ProjectStore
from server.canvas.project_router import create_project_app


def test_session_agents_are_the_t1_adapters():
    assert adapters.session_kinds() == agents.KINDS == AGENT_KINDS
    assert AGENT_KINDS[:3] == ("pi", "claude", "codex") and "grok" in AGENT_KINDS  # Grok became a session agent (T1) on 2026-09-29
    for k in AGENT_KINDS:
        assert adapters.implemented_tier(adapters.need(k)) == "T1"


def test_observed_clis_are_registered_but_never_session_agents():
    """Grok, Cursor and Devin were observed (T2) by the user's decision of 2026-09-28 and became session agents (T1) on
    2026-09-29: every registered CLI is a session agent now, in the order the picker shows them."""
    assert [a["kind"] for a in registry.adapter_infos(with_versions=False)] == ["pi", "claude", "codex", "grok", "cursor", "devin"]
    assert "cursor" in adapters.session_kinds() and adapters.implemented_tier(adapters.need("cursor")) == "T1"


def test_tier_follows_capabilities_and_max_tier():
    class Bare(Adapter):
        kind = "bare"

    class Observed(Adapter):
        kind, max_tier = "obs", "T2"
        known_types = frozenset()

        def locate(self, native_id, root=None, home=None, hint=None): ...
        def sessions_for(self, roots, home=None): ...
        def project(self, rec, st): ...
        def record_type(self, rec): ...
        def classify(self, name, args, root=None): ...

    class Capped(Observed):
        kind = "capped"
        assigns_id, can_fork_headless, survives_move = "cli", False, True

        def headless_args(self, cmd, req, *, log_exists=False): ...
        def interactive_argv(self, native_id, model, effort, *, new=False, has_log=False): ...
        def catalog(self, env, root): ...

    assert registry.implemented_tier(Bare()) == "T0"
    assert registry.implemented_tier(Observed()) == "T2"
    # Implements everything a session agent needs, but the user decided it is observed only.
    assert registry.implemented_tier(Capped()) == "T2"
    Capped.max_tier = "T1"
    assert registry.implemented_tier(Capped()) == "T1"


def test_version_ranges():
    r = VersionRange(">=0.153,<0.158")
    assert parse_version("codex-cli 0.157.1") == (0, 157, 1)
    assert r.contains("codex-cli 0.157.1") is True
    assert r.contains("0.158.0") is False and r.contains("0.152.9") is False
    assert r.contains(None) is None and r.contains("unknown") is None
    assert VersionRange("").contains("1.2.3") is True
    assert r.label() == "0.153–<0.158"


def test_adapters_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(agents, "catalog", lambda root=None, ttl_s=600: {k: {"kind": k, "default": "m"} for k in agents.KINDS})
    s = ProjectStore(tmp_path / "p")
    s.init()
    c = TestClient(create_project_app(s.root))
    got = c.get("/api/agent/adapters?versions=0&catalog=1").json()
    by = {a["kind"]: a for a in got}
    assert [a["kind"] for a in got if a["tier"] == "T1"][:3] == ["pi", "claude", "codex"] and by["grok"]["tier"] == "T1"
    assert by["codex"]["caps"]["forkHeadless"] is False and by["codex"]["deleteCommand"] == "codex delete {id}"
    assert by["claude"]["logDir"] == "~/.claude/projects/" and by["claude"]["catalog"] == {"kind": "claude", "default": "m"}
    assert "version" not in by["pi"]
    for a in got:
        assert set(a) >= {"kind", "name", "tier", "maxTier", "installed", "tested", "caps", "icon", "logDir", "deleteCommand"}
