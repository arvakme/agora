"""Record the moderator's `acceptance` sign-off on one reviewed commit.

The status is the moderator's endorsement, published by hand from an account
that actually holds repository permission. It claims nothing about the review
or the tests by itself; `--evidence` points at the pull request comment holding
them. A commit status belongs to the SHA it names, so a push that lands after
the checks below leaves the new head without an `acceptance` status and the
pull request unmergeable until it is reviewed and signed off again.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

REPO = "arvakme/agora"
CONTEXT = "acceptance"
DESCRIPTION = "Moderator sign-off; evidence in the linked comment"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class SignoffError(Exception):
    """The sign-off did not complete; the message says how far it got."""


def _gh(args: list[str]) -> str:
    """Run one gh command. The only place this tool touches the outside world."""
    try:
        completed = subprocess.run(["gh", *args], capture_output=True, text=True)
    except OSError as exc:
        raise SignoffError(f"could not run gh: {exc}") from exc
    if completed.returncode != 0:
        raise SignoffError(
            f"`gh {' '.join(args)}` exited {completed.returncode}: {completed.stderr.strip()}"
        )
    return completed.stdout


def _reviewed_head(pr: int, expected_sha: str) -> None:
    """Refuse anything but an open pull request still sitting on expected_sha.

    Every refusal here happens before the status call, so nothing is published.
    """
    if not SHA_RE.match(expected_sha):
        raise SignoffError("--sha must be the full 40-hex commit that was reviewed")
    output = _gh(["pr", "view", str(pr), "--repo", REPO, "--json", "state,headRefOid"])
    try:
        pull = json.loads(output)
        state, head = pull["state"], pull["headRefOid"]
    except (json.JSONDecodeError, KeyError) as exc:
        raise SignoffError(f"could not read pull request #{pr} from gh: {exc}") from exc
    if state != "OPEN":
        raise SignoffError(f"pull request #{pr} is {state}, not open")
    if head != expected_sha:
        raise SignoffError(
            f"#{pr} head is {head}, not the reviewed {expected_sha}; review the new head"
        )


def sign_off(pr: int, expected_sha: str, evidence: str) -> None:
    """Publish `acceptance` on expected_sha after the pre-checks pass."""
    if not evidence.startswith("https://"):
        raise SignoffError("--evidence must be an https link to the evidence comment")
    _reviewed_head(pr, expected_sha)
    try:
        _gh([
            "api", f"repos/{REPO}/statuses/{expected_sha}", "-X", "POST",
            "-f", "state=success",
            "-f", f"context={CONTEXT}",
            "-f", f"target_url={evidence}",
            "-f", f"description={DESCRIPTION}",
        ])
    except SignoffError as exc:
        # The request may have been written before the failure surfaced.
        raise SignoffError(
            f"{exc}; the sign-off could not be confirmed — run "
            f"`gh api repos/{REPO}/commits/{expected_sha}/status` to see whether "
            f"{CONTEXT} already exists before deciding what to do"
        ) from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--sha", required=True, help="the full SHA that was reviewed")
    parser.add_argument("--evidence", required=True, help="link to the PR comment holding the evidence")
    args = parser.parse_args(argv)
    try:
        sign_off(args.pr, args.sha, args.evidence)
    except SignoffError as exc:
        print(f"sign-off failed: {exc}", file=sys.stderr)
        return 1
    print(f"{CONTEXT} published on {args.sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
