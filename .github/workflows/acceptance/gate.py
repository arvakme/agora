"""Publish the trusted acceptance check for a pull request.

The check is created against the pull request's *current* head SHA, so a new
commit leaves the required check absent and the pull request unmergeable until
the review and hands-on evidence are re-submitted for that commit.

This module verifies the submitted evidence; it never runs QA itself and never
invents a result. It runs only from the default branch, so untrusted pull
request code never sees the repository token.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

CHECK_NAME = "acceptance"
API_ROOT = "https://api.github.com"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
BROWSER_STATUSES = ("passed", "not_applicable")


class EvidenceError(Exception):
    """The submitted evidence cannot be bound to a live pull request head."""


class GitHubAPI:
    def __init__(self, token: str, root: str = API_ROOT) -> None:
        self._token = token
        self._root = root

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        body = None if payload is None else json.dumps(payload).encode()
        request = urllib.request.Request(f"{self._root}{path}", data=body, method=method)
        request.add_header("Authorization", f"Bearer {self._token}")
        request.add_header("Accept", "application/vnd.github+json")
        request.add_header("X-GitHub-Api-Version", "2022-11-28")
        if body is not None:
            request.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"{}")

    def get_pull(self, repo: str, number: int) -> dict:
        try:
            return self._request("GET", f"/repos/{repo}/pulls/{number}")
        except urllib.error.HTTPError as exc:
            raise EvidenceError(f"pull request {repo}#{number} is not readable: {exc.code}") from exc

    def create_check_run(self, repo: str, payload: dict) -> dict:
        return self._request("POST", f"/repos/{repo}/check-runs", payload)


def parse_evidence(raw: str) -> dict:
    if not raw or not raw.strip():
        raise EvidenceError("evidence is empty")
    try:
        evidence = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"evidence is not valid JSON: {exc}") from exc
    if not isinstance(evidence, dict):
        raise EvidenceError("evidence must be a JSON object")
    return evidence


def _claimed_identity(evidence: dict) -> tuple[int, str]:
    number = evidence.get("pr")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        raise EvidenceError("evidence.pr must be a positive pull request number")
    head_sha = evidence.get("head_sha")
    if not isinstance(head_sha, str) or not SHA_RE.match(head_sha):
        raise EvidenceError("evidence.head_sha must be a full lowercase 40-hex commit sha")
    return number, head_sha


def bind_to_head(evidence: dict, api: GitHubAPI, repo: str) -> str:
    """Return the pull request head SHA the check may be published against.

    Raises when the pull request is closed, lives in another repository, or has
    already moved past the commit the evidence describes. Nothing is published
    in those cases, so the required check stays absent and merging stays blocked.
    """
    number, claimed_sha = _claimed_identity(evidence)
    pull = api.get_pull(repo, number)
    if pull.get("state") != "open":
        raise EvidenceError(f"pull request #{number} is {pull.get('state')}, not open")
    base_repo = (pull.get("base") or {}).get("repo") or {}
    head = pull.get("head") or {}
    head_repo = head.get("repo") or {}
    if base_repo.get("full_name") != repo or head_repo.get("full_name") != repo:
        raise EvidenceError(f"pull request #{number} does not belong to {repo}")
    actual_sha = head.get("sha")
    if actual_sha != claimed_sha:
        raise EvidenceError(
            f"evidence describes {claimed_sha}, but #{number} head is now {actual_sha}"
        )
    return actual_sha


def _check_review(evidence: dict, problems: list[str]) -> None:
    review = evidence.get("review")
    if not isinstance(review, dict):
        problems.append("review is missing")
        return
    author = str(review.get("author") or "").strip()
    reviewer = str(review.get("reviewer") or "").strip()
    if not author or not reviewer:
        problems.append("review.author and review.reviewer are both required")
    elif author == reviewer:
        problems.append("review.reviewer is the author; an independent review is required")
    if review.get("verdict") != "approve":
        problems.append(f"review.verdict is {review.get('verdict')!r}, not 'approve'")
    if not str(review.get("summary") or "").strip():
        problems.append("review.summary is empty")


def _check_verification(evidence: dict, head_sha: str, problems: list[str]) -> None:
    runs = evidence.get("verification")
    if not isinstance(runs, list) or not runs:
        problems.append("verification must list at least one command run")
        return
    for index, run in enumerate(runs):
        label = f"verification[{index}]"
        if not isinstance(run, dict):
            problems.append(f"{label} is not an object")
            continue
        if not str(run.get("command") or "").strip():
            problems.append(f"{label}.command is empty")
        if run.get("exit_code") != 0:
            problems.append(f"{label}.exit_code is {run.get('exit_code')!r}, not 0")
        if run.get("commit") != head_sha:
            problems.append(f"{label}.commit is {run.get('commit')!r}, not the head {head_sha}")


def _check_browser(evidence: dict, head_sha: str, problems: list[str]) -> None:
    browser = evidence.get("browser")
    if not isinstance(browser, dict):
        problems.append("browser is missing; record a hands-on result or a not_applicable reason")
        return
    status = browser.get("status")
    if status not in BROWSER_STATUSES:
        problems.append(f"browser.status is {status!r}, not one of {BROWSER_STATUSES}")
        return
    if not str(browser.get("reason") or "").strip():
        problems.append("browser.reason is empty")
    if status == "passed" and browser.get("commit") != head_sha:
        problems.append(f"browser.commit is {browser.get('commit')!r}, not the head {head_sha}")


def review_problems(evidence: dict, head_sha: str) -> list[str]:
    """List every reason the evidence fails to accept this commit."""
    problems: list[str] = []
    if not str(evidence.get("moderator") or "").strip():
        problems.append("moderator is empty; the final adjudication must be recorded")
    _check_review(evidence, problems)
    _check_verification(evidence, head_sha, problems)
    _check_browser(evidence, head_sha, problems)
    return problems


def _summary(evidence: dict, head_sha: str, problems: list[str]) -> str:
    lines = [f"Commit: `{head_sha}`", ""]
    if problems:
        lines.append("Rejected:")
        lines.extend(f"- {problem}" for problem in problems)
        return "\n".join(lines)
    review = evidence["review"]
    browser = evidence["browser"]
    lines.append(f"Moderator: {evidence['moderator']}")
    lines.append(f"Review: {review['reviewer']} reviewed {review['author']} — {review['summary']}")
    lines.append("")
    lines.append("Verification:")
    lines.extend(
        f"- `{run['command']}` exited {run['exit_code']}" for run in evidence["verification"]
    )
    lines.append("")
    lines.append(f"Browser: {browser['status']} — {browser['reason']}")
    return "\n".join(lines)


def publish(evidence: dict, api: GitHubAPI, repo: str, details_url: str | None = None) -> bool:
    """Bind the evidence to the live head and publish the acceptance check.

    Returns True when the check was published as a success.
    """
    head_sha = bind_to_head(evidence, api, repo)
    problems = review_problems(evidence, head_sha)
    conclusion = "failure" if problems else "success"
    payload = {
        "name": CHECK_NAME,
        "head_sha": head_sha,
        "status": "completed",
        "conclusion": conclusion,
        "output": {
            "title": "Evidence rejected" if problems else "Accepted for this commit",
            "summary": _summary(evidence, head_sha, problems),
        },
    }
    if details_url:
        payload["details_url"] = details_url
    api.create_check_run(repo, payload)
    return not problems


def main() -> int:
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not repo or not token:
        print("GITHUB_REPOSITORY and GITHUB_TOKEN are required", file=sys.stderr)
        return 2
    server = os.environ.get("GITHUB_SERVER_URL", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    details_url = f"{server}/{repo}/actions/runs/{run_id}" if server and run_id else None
    try:
        evidence = parse_evidence(os.environ.get("ACCEPTANCE_EVIDENCE", ""))
        accepted = publish(evidence, GitHubAPI(token), repo, details_url)
    except EvidenceError as exc:
        print(f"no check published: {exc}", file=sys.stderr)
        return 1
    if not accepted:
        print("acceptance check published as failure", file=sys.stderr)
        return 1
    print("acceptance check published as success")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
