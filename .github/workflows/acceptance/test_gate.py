"""Regressions for the acceptance gate: stale heads, missing or invalid
evidence, the wrong pull request identity, and a success bound to the real head.
"""

from __future__ import annotations

import copy
import unittest

import gate

REPO = "arvakme/agora"
HEAD = "a" * 40
OLD = "b" * 40


def pull(state: str = "open", head_sha: str = HEAD, repo: str = REPO) -> dict:
    return {
        "state": state,
        "base": {"repo": {"full_name": REPO}},
        "head": {"sha": head_sha, "repo": {"full_name": repo}},
    }


def evidence() -> dict:
    return {
        "pr": 26,
        "head_sha": HEAD,
        "moderator": "arvakme: approved for merge",
        "review": {
            "author": "claude-opus-5",
            "reviewer": "kimi-k3",
            "verdict": "approve",
            "summary": "gate rejects stale heads; no admin bypass",
        },
        "verification": [
            {"command": "uv run pytest -m 'not llm' -q", "exit_code": 0, "commit": HEAD}
        ],
        "browser": {"status": "not_applicable", "reason": "CI-only change, no UI"},
    }


class FakeAPI:
    def __init__(self, pull_payload: dict | None = None, error: str | None = None) -> None:
        self._pull = pull_payload or pull()
        self._error = error
        self.published: list[dict] = []

    def get_pull(self, repo: str, number: int) -> dict:
        if self._error:
            raise gate.EvidenceError(self._error)
        return self._pull

    def create_check_run(self, repo: str, payload: dict) -> dict:
        self.published.append(payload)
        return {"id": 1}


class BindToHead(unittest.TestCase):
    def test_stale_head_publishes_nothing(self) -> None:
        api = FakeAPI(pull(head_sha=HEAD))
        stale = evidence() | {"head_sha": OLD}
        for run in stale["verification"]:
            run["commit"] = OLD
        with self.assertRaises(gate.EvidenceError):
            gate.publish(stale, api, REPO)
        self.assertEqual(api.published, [])

    def test_closed_pull_request_publishes_nothing(self) -> None:
        api = FakeAPI(pull(state="closed"))
        with self.assertRaises(gate.EvidenceError):
            gate.publish(evidence(), api, REPO)
        self.assertEqual(api.published, [])

    def test_foreign_head_repository_publishes_nothing(self) -> None:
        api = FakeAPI(pull(repo="someone/fork"))
        with self.assertRaises(gate.EvidenceError):
            gate.publish(evidence(), api, REPO)
        self.assertEqual(api.published, [])

    def test_unreadable_pull_request_publishes_nothing(self) -> None:
        api = FakeAPI(error="pull request is not readable: 404")
        with self.assertRaises(gate.EvidenceError):
            gate.publish(evidence(), api, REPO)
        self.assertEqual(api.published, [])

    def test_malformed_identity_is_rejected(self) -> None:
        for broken in ({"pr": 0}, {"pr": "26"}, {"head_sha": "abc"}, {"head_sha": HEAD.upper()}):
            with self.subTest(broken=broken):
                with self.assertRaises(gate.EvidenceError):
                    gate.bind_to_head(evidence() | broken, FakeAPI(), REPO)


class ParseEvidence(unittest.TestCase):
    def test_empty_and_malformed_input_is_rejected(self) -> None:
        for raw in ("", "   ", "{", "[]", '"text"'):
            with self.subTest(raw=raw):
                with self.assertRaises(gate.EvidenceError):
                    gate.parse_evidence(raw)

    def test_valid_json_object_is_returned(self) -> None:
        self.assertEqual(gate.parse_evidence('{"pr": 26}'), {"pr": 26})


class ReviewProblems(unittest.TestCase):
    def assert_rejected(self, mutate: dict, fragment: str) -> None:
        payload = copy.deepcopy(evidence())
        payload.update(mutate)
        problems = gate.review_problems(payload, HEAD)
        self.assertTrue(any(fragment in problem for problem in problems), problems)

    def test_complete_evidence_has_no_problems(self) -> None:
        self.assertEqual(gate.review_problems(evidence(), HEAD), [])

    def test_missing_sections_are_rejected(self) -> None:
        self.assert_rejected({"review": None}, "review is missing")
        self.assert_rejected({"browser": None}, "browser is missing")
        self.assert_rejected({"verification": []}, "at least one command run")
        self.assert_rejected({"moderator": "  "}, "moderator is empty")

    def test_self_review_is_rejected(self) -> None:
        self.assert_rejected(
            {"review": evidence()["review"] | {"reviewer": "claude-opus-5"}},
            "is the author",
        )

    def test_non_approving_review_is_rejected(self) -> None:
        self.assert_rejected(
            {"review": evidence()["review"] | {"verdict": "changes_requested"}}, "not 'approve'"
        )

    def test_failed_or_stale_verification_is_rejected(self) -> None:
        self.assert_rejected(
            {"verification": [{"command": "pytest", "exit_code": 1, "commit": HEAD}]}, "not 0"
        )
        self.assert_rejected(
            {"verification": [{"command": "pytest", "exit_code": 0, "commit": OLD}]},
            "not the head",
        )
        self.assert_rejected(
            {"verification": [{"command": "", "exit_code": 0, "commit": HEAD}]}, "command is empty"
        )

    def test_browser_exception_needs_a_reason_and_passes_need_the_head(self) -> None:
        self.assert_rejected({"browser": {"status": "not_applicable"}}, "browser.reason is empty")
        self.assert_rejected({"browser": {"status": "skipped", "reason": "later"}}, "browser.status")
        self.assert_rejected(
            {"browser": {"status": "passed", "reason": "dogfood", "commit": OLD}},
            "browser.commit",
        )


class Publish(unittest.TestCase):
    def test_success_binds_the_real_head(self) -> None:
        api = FakeAPI()
        self.assertTrue(gate.publish(evidence(), api, REPO, "https://example/run"))
        (payload,) = api.published
        self.assertEqual(payload["head_sha"], HEAD)
        self.assertEqual(payload["name"], gate.CHECK_NAME)
        self.assertEqual(payload["conclusion"], "success")
        self.assertEqual(payload["status"], "completed")
        self.assertIn("kimi-k3", payload["output"]["summary"])
        self.assertEqual(payload["details_url"], "https://example/run")

    def test_bad_evidence_publishes_a_failure_on_the_head(self) -> None:
        api = FakeAPI()
        broken = evidence()
        broken["review"]["verdict"] = "changes_requested"
        self.assertFalse(gate.publish(broken, api, REPO))
        (payload,) = api.published
        self.assertEqual(payload["conclusion"], "failure")
        self.assertEqual(payload["head_sha"], HEAD)
        self.assertIn("not 'approve'", payload["output"]["summary"])


if __name__ == "__main__":
    unittest.main()
