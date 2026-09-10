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
    """The commit cannot be signed off, so no status is published."""


def _gh(args: list[str], run) -> str:
    completed = run(["gh", *args], capture_output=True, text=True)
    if completed.returncode != 0:
        raise SignoffError(f"gh {' '.join(args)} failed ({completed.returncode}): {completed.stderr.strip()}")
    return completed.stdout


def sign_off(pr: int, expected_sha: str, evidence: str, run=subprocess.run) -> None:
    """Publish `acceptance` on expected_sha, or raise without publishing."""
    if not SHA_RE.match(expected_sha):
        raise SignoffError("--sha must be the full 40-hex commit that was reviewed")
    if not evidence.startswith("https://"):
        raise SignoffError("--evidence must be an https link to the evidence comment")
    pull = json.loads(_gh(
        ["pr", "view", str(pr), "--repo", REPO, "--json", "state,headRefOid"], run
    ))
    if pull["state"] != "OPEN":
        raise SignoffError(f"pull request #{pr} is {pull['state']}, not open")
    if pull["headRefOid"] != expected_sha:
        raise SignoffError(
            f"#{pr} head is {pull['headRefOid']}, not the reviewed {expected_sha}; review the new head"
        )
    _gh([
        "api", f"repos/{REPO}/statuses/{expected_sha}", "-X", "POST",
        "-f", "state=success",
        "-f", f"context={CONTEXT}",
        "-f", f"target_url={evidence}",
        "-f", f"description={DESCRIPTION}",
    ], run)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--sha", required=True, help="the full SHA that was reviewed")
    parser.add_argument("--evidence", required=True, help="link to the PR comment holding the evidence")
    args = parser.parse_args(argv)
    try:
        sign_off(args.pr, args.sha, args.evidence)
    except SignoffError as exc:
        print(f"not signed off: {exc}", file=sys.stderr)
        return 1
    print(f"{CONTEXT} published on {args.sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
