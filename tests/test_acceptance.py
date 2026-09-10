"""The moderator sign-off publishes `acceptance` on the reviewed commit only."""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "agora_acceptance", Path(__file__).resolve().parents[1] / ".github" / "acceptance.py"
)
acceptance = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(acceptance)

REVIEWED = "a" * 40
PUSHED_SINCE = "b" * 40
EVIDENCE = "https://github.com/arvakme/agora/pull/26#issuecomment-1"


class FakeGh:
    """Answers `gh pr view` from a canned pull request, records every call."""

    def __init__(self, state: str = "OPEN", head: str = REVIEWED, status_rc: int = 0) -> None:
        self._pull = f'{{"state": "{state}", "headRefOid": "{head}"}}'
        self._status_rc = status_rc
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], **kwargs: object) -> subprocess.CompletedProcess:
        self.calls.append(args)
        if args[1] == "pr":
            return subprocess.CompletedProcess(args, 0, self._pull, "")
        return subprocess.CompletedProcess(args, self._status_rc, "", "forbidden")

    @property
    def published(self) -> list[list[str]]:
        return [call for call in self.calls if call[1] == "api"]


def test_signoff_publishes_on_the_reviewed_sha() -> None:
    gh = FakeGh()

    acceptance.sign_off(26, REVIEWED, EVIDENCE, run=gh)

    (published,) = gh.published
    assert f"repos/arvakme/agora/statuses/{REVIEWED}" in published
    assert "context=acceptance" in published
    assert "state=success" in published
    assert f"target_url={EVIDENCE}" in published


def test_a_push_after_the_review_is_refused_without_publishing() -> None:
    gh = FakeGh(head=PUSHED_SINCE)

    with pytest.raises(acceptance.SignoffError, match="not the reviewed"):
        acceptance.sign_off(26, REVIEWED, EVIDENCE, run=gh)

    assert gh.published == []


def test_closed_pull_request_is_refused_without_publishing() -> None:
    gh = FakeGh(state="MERGED")

    with pytest.raises(acceptance.SignoffError, match="not open"):
        acceptance.sign_off(26, REVIEWED, EVIDENCE, run=gh)

    assert gh.published == []


def test_a_rejected_status_call_exits_non_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    gh = FakeGh(status_rc=1)
    monkeypatch.setattr(acceptance.subprocess, "run", gh)

    exit_code = acceptance.main(["--pr", "26", "--sha", REVIEWED, "--evidence", EVIDENCE])

    assert exit_code == 1
