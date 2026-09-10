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
ARGV = ["--pr", "26", "--sha", REVIEWED, "--evidence", EVIDENCE]


class FakeGh:
    """Answers `gh pr view` from a canned pull request, records every call."""

    def __init__(self, state: str = "OPEN", head: str = REVIEWED, status_rc: int = 0) -> None:
        self._pull = f'{{"state": "{state}", "headRefOid": "{head}"}}'
        self._status_rc = status_rc
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], **kwargs: object) -> subprocess.CompletedProcess:
        self.calls.append(argv)
        if argv[1] == "pr":
            return subprocess.CompletedProcess(argv, 0, self._pull, "")
        return subprocess.CompletedProcess(argv, self._status_rc, "", "HTTP 502")

    @property
    def status_calls(self) -> list[list[str]]:
        return [call for call in self.calls if call[1] == "api"]


@pytest.fixture
def gh(monkeypatch: pytest.MonkeyPatch):
    def install(fake: FakeGh) -> FakeGh:
        monkeypatch.setattr(acceptance.subprocess, "run", fake)
        return fake

    return install


def test_signoff_publishes_on_the_reviewed_sha(gh, capsys: pytest.CaptureFixture) -> None:
    fake = gh(FakeGh())

    assert acceptance.main(ARGV) == 0

    (published,) = fake.status_calls
    assert f"repos/arvakme/agora/statuses/{REVIEWED}" in published
    assert "context=acceptance" in published
    assert "state=success" in published
    assert f"target_url={EVIDENCE}" in published
    assert "acceptance published" in capsys.readouterr().out


def test_a_push_after_the_review_is_refused_without_publishing(gh, capsys) -> None:
    fake = gh(FakeGh(head=PUSHED_SINCE))

    assert acceptance.main(ARGV) == 1

    assert fake.status_calls == []
    captured = capsys.readouterr()
    assert "not the reviewed" in captured.err
    assert captured.out == ""


def test_closed_pull_request_is_refused_without_publishing(gh, capsys) -> None:
    fake = gh(FakeGh(state="MERGED"))

    assert acceptance.main(ARGV) == 1

    assert fake.status_calls == []
    assert "not open" in capsys.readouterr().err


def test_a_rejected_status_call_reports_an_unconfirmed_sign_off(gh, capsys) -> None:
    fake = gh(FakeGh(status_rc=1))

    assert acceptance.main(ARGV) == 1

    (attempted,) = fake.status_calls
    assert f"repos/arvakme/agora/statuses/{REVIEWED}" in attempted
    captured = capsys.readouterr()
    assert "could not be confirmed" in captured.err
    assert f"commits/{REVIEWED}/status" in captured.err
    assert captured.out == ""
