"""``agora replay import-pr <N>… [--repo owner/name]``: turn merged pull requests into replays.

Each PR becomes ``<project>/.agora/replays/pr-<N>.json`` (server/canvas/replays.py, web/docs/pr-replay.md):
from GitHub through ``gh`` when it works, else from the squash commit on the project's history. One summary
line per PR. Exit codes: 0 all imported · 1 some failed (the message says why).
"""

from __future__ import annotations

import sys


def cmd_replay(p, a) -> int:
    from server.canvas import replays

    failed = 0
    for n in a.numbers:
        try:
            r = replays.import_pr(p.root, n, repo=a.repo, agent=a.agent)
        except replays.ReplayError as e:
            print(f"agora: {e}", file=sys.stderr)
            failed += 1
            continue
        print(f"#{n}：{r['commits']} 个提交、{r['files']} 个文件，来源 {r['source']}，agent {r['agent']['kind']} → .agora/replays/{r['id']}.json")
    return 1 if failed else 0


def add_parser(sub) -> None:
    r = sub.add_parser("replay", help="PR replays: import merged pull requests as data the workstation can play")
    r.add_argument("--project", default=None, help="project directory (default: $AGORA_PROJECT or the nearest .agora/)")
    rsub = r.add_subparsers(dest="action", required=True)
    s = rsub.add_parser("import-pr", help="import merged PRs from GitHub (gh, read-only) or their squash commits")
    s.add_argument("numbers", nargs="+", type=int, metavar="N", help="PR numbers")
    s.add_argument("--repo", default=None, help="owner/name (default: read off the origin remote)")
    s.add_argument("--agent", default=None, help="claude|codex|pi|grok|cursor|devin|unknown (default: found from the session logs that name the PR's branch)")
    s.add_argument("--project", default=None, dest="project", help="project directory")
    s.set_defaults(fn=cmd_replay)
