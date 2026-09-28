"""Recorded CLI output, one folder per CLI and version (web/docs/cli-adapters.md §6).

``tests/fixtures/agents/<kind>/<version>/`` holds ``log.jsonl`` (the CLI's own session log, or
``updates.jsonl`` and friends for CLIs that keep a folder per session), ``stream.jsonl`` (its
headless output) and ``meta.json`` (what was recorded, when, with which CLI version, and which
record types the adapter is expected not to know: ``expected_unknown``). Older versions stay:
the adapters must still read sessions an older CLI wrote on the user's machine."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).parent / "fixtures" / "agents"


def versions(kind: str) -> list[Path]:
    """Every recorded version of ``kind`` (folders), oldest name first."""
    d = ROOT / kind
    return sorted(p for p in d.iterdir() if p.is_dir()) if d.is_dir() else []


def fixture(kind: str, name: str = "log.jsonl", version: str = "unversioned") -> Path:
    return ROOT / kind / version / name


def legacy(name: str) -> Path:
    """The pre-versioning names (``claude-log.jsonl``, ``pi-stream.jsonl``…) → their new place."""
    kind, _, rest = name.partition("-")
    return fixture(kind, rest)


def meta(folder: Path) -> dict:
    p = folder / "meta.json"
    return json.loads(p.read_text()) if p.exists() else {}


def all_fixtures() -> list[tuple[str, Path]]:
    """(kind, version folder) for every recorded fixture."""
    return [(k.name, v) for k in sorted(ROOT.iterdir()) if k.is_dir() for v in versions(k.name)]
