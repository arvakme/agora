"""Codex rollout discovery helpers."""

from __future__ import annotations

from pathlib import Path

from host.codex import thread_id_from_rollout


def test_thread_id_from_rollout_filename() -> None:
    path = Path("/tmp/.codex/sessions/2026/03/rollout-thread-abc.jsonl")
    assert thread_id_from_rollout(path) == "thread-abc"
