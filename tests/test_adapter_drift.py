"""Drift detection (notify-only): versions outside the tested range and log records an adapter does
not know are reported with what they would do to the tier — nothing is enforced."""

import json
from pathlib import Path

from server.canvas import adapters
from server.canvas.adapters import drift
from server.canvas.adapters.base import VersionRange

CODEX = adapters.need("codex")


def rollout(home: Path, nid: str, version: str, extra: list[dict]) -> Path:
    p = home / ".codex" / "sessions" / "2026" / "09" / "28" / f"rollout-2026-09-28T00-00-00-{nid}.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    recs = [
        {"type": "session_meta", "payload": {"id": nid, "cwd": "/w", "cli_version": version}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "t1"}},
        *extra,
        {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "t1"}},
    ]
    p.write_text("".join(json.dumps(r) + "\n" for r in recs))
    return p


def test_unknown_record_types_are_surfaced_not_silently_skipped(tmp_path):
    p = rollout(tmp_path, "c-1", "0.157.1", [{"type": "zz_future_record", "payload": {}}, {"type": "world_state", "payload": {"full": True}}, {"type": "event_msg", "payload": {"type": "user_message", "message": "hi"}}])
    got = drift.scan(CODEX, p)
    assert got["unknown"] == {"zz_future_record": 1}  # world_state is ignored on purpose (review P2-4)
    assert got["gaps"] == {"event_msg/user_message": 1}  # known, not projected (pre-0.149 logs)


def test_probe_reports_version_and_unknown_records_notify_only(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    rollout(tmp_path, "c-1", "0.158.0", [{"type": "zz_future_record", "payload": {}}] * 3)
    monkeypatch.setattr(type(CODEX), "installed", lambda self: "/bin/codex")
    r = drift.probe(CODEX, home=tmp_path, version="0.158.0")
    assert r["versionOk"] is False
    assert r["unknown"] == {"zz_future_record": 3} and r["unknownRatio"] > drift.UNKNOWN_RATIO
    d = r["degraded"]
    assert d["from"] == "T1" and d["to"] == "T2" and d["enforced"] is False and not d["trusted"]
    assert "0.158.0" in d["reason"] and "不认识" in d["reason"]
    assert r["byVersion"]["0.158.0"]["unknown"] == {"zz_future_record": 3}
    assert "zz_future_record" in drift.table([r])
    # Nothing is enforced: the registry still says T1.
    assert adapters.implemented_tier(CODEX) == "T1"


def test_trust_untested_is_read_from_agents_toml(tmp_path, monkeypatch):
    (tmp_path / ".agora").mkdir()
    (tmp_path / ".agora" / "agents.toml").write_text("[codex]\ntrust_untested = true\n")
    assert drift.trust(tmp_path) == {"codex": True}
    monkeypatch.setattr(type(CODEX), "installed", lambda self: "/bin/codex")
    monkeypatch.setattr(type(CODEX), "tested", VersionRange(">=0.149,<0.150"))
    r = drift.probe(CODEX, home=tmp_path / "nohome", root=tmp_path, version="0.157.1")
    assert r["degraded"]["trusted"] is True


def test_runtime_observation_counts_unknown_records():
    drift.reset_runtime()
    for rec in ({"type": "session_meta", "payload": {}}, {"type": "zz_future_record", "payload": {}}, {"type": "world_state", "payload": {}}, {"type": "event_msg", "payload": {"type": "exec_command_end"}}):
        drift.observe("codex", rec)
    assert drift.runtime("codex") == {"records": 4, "unknown": {"zz_future_record": 1}, "gaps": {"event_msg/exec_command_end": 1}}
    drift.reset_runtime()


def test_doctor_exit_code_is_1_only_for_untrusted_degradation():
    """Review P2-3."""
    from agora_cli.doctor import doctor_agents_exit

    ok = {"installed": True, "degraded": None, "unknown": {"zz": 1}}
    assert doctor_agents_exit([ok]) == 0  # unknown records below the threshold: a note, not a failure
    deg = {"installed": True, "degraded": {"from": "T1", "to": "T2", "reason": "x", "trusted": False}, "unknown": {}}
    assert doctor_agents_exit([ok, deg]) == 1
    assert doctor_agents_exit([{**deg, "degraded": {**deg["degraded"], "trusted": True}}]) == 0
    assert doctor_agents_exit([{**deg, "installed": False}]) == 0
