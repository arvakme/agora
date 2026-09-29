"""PR replays: a merged pull request as data the workstation can play (web/docs/pr-replay.md).

``import_pr`` writes ``<project>/.agora/replays/pr-<N>.json`` — the PR's commits in time order and the files
each one touched — from GitHub through ``gh`` (read-only; ``gh`` handles its own login) and, when ``gh`` is
missing or fails, from the squash commit ``… (#N)`` on the project's own git history. It is a replay generated
from commits, not what an agent did at the time. The server side is read-only: ``list_replays`` / ``read_replay``.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

ID_RE = re.compile(r"^pr-[0-9]{1,9}$")
STATUS_OP = {"added": "add", "copied": "add", "modified": "edit", "changed": "edit", "removed": "delete", "renamed": "rename"}
AGENT_KINDS = ("claude", "codex", "pi", "grok", "cursor", "devin", "unknown")
GIT_OP = {"A": "add", "C": "add", "M": "edit", "T": "edit", "D": "delete", "R": "rename"}
REMOTE_RE = re.compile(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")

Run = Callable[[list[str], Path], str]


class ReplayError(Exception):
    """The PR could not be turned into a replay (the message says why, for the person at the terminal)."""


def run_cmd(argv: list[str], cwd: Path) -> str:
    return subprocess.run(argv, cwd=cwd, check=True, capture_output=True, text=True, timeout=120).stdout


def valid_id(id: str) -> bool:
    return bool(ID_RE.match(id or ""))


def replays_dir(project: Path) -> Path:
    return Path(project) / ".agora" / "replays"


# ——— import ———
def repo_of(root: Path, run: Run) -> str | None:
    """``owner/name`` from the origin remote (None when it is not a GitHub remote)."""
    try:
        m = REMOTE_RE.search(run(["git", "-C", str(root), "remote", "get-url", "origin"], root).strip())
    except (OSError, subprocess.SubprocessError):
        return None
    return f"{m.group(1)}/{m.group(2)}" if m else None


def from_github(root: Path, number: int, repo: str | None, run: Run) -> dict[str, Any]:
    repo = repo or repo_of(root, run)
    if not repo:
        raise ReplayError("no GitHub repository: give --repo owner/name")
    pr = json.loads(run(["gh", "pr", "view", str(number), "--repo", repo, "--json", "number,title,author,url,mergedAt,commits,headRefName"], root))
    commits = []
    for c in pr["commits"]:
        info = json.loads(run(["gh", "api", f"repos/{repo}/commits/{c['oid']}"], root))
        if len(info.get("parents") or []) > 1:  # a merge of main into the branch carries other PRs' files
            continue
        files = [{"path": f["filename"], "op": STATUS_OP.get(f.get("status"), "edit"), "additions": int(f.get("additions") or 0), "deletions": int(f.get("deletions") or 0)} for f in info.get("files") or []]
        commits.append({"sha": c["oid"], "title": c.get("messageHeadline") or "", "at": c.get("committedDate") or c.get("authoredDate") or "", "files": files})
    commits.sort(key=lambda c: c["at"])  # stable: same-time commits keep GitHub's order
    who = pr.get("author") or {}
    return {"id": f"pr-{number}", "kind": "pr", "number": number, "title": pr.get("title") or "", "author": who.get("name") or who.get("login") or "", "url": pr.get("url") or "", "mergedAt": pr.get("mergedAt") or "", "source": "github", "branch": pr.get("headRefName") or "", "commits": commits}


def _tokens(out: str) -> list[str]:
    return out.split("\0")


def squash_files(root: Path, sha: str, run: Run) -> list[dict[str, Any]]:
    """Files of one commit with ops and line counts, renames followed (``git show -M -z``)."""
    status = _tokens(run(["git", "-C", str(root), "show", "--format=", "-M", "-z", "--name-status", sha], root))
    ops: list[tuple[str, str]] = []  # (path, op) in git's order
    i = 0
    while i < len(status) and status[i]:
        code = status[i][0]
        if code in ("R", "C"):
            ops.append((status[i + 2], GIT_OP[code]))
            i += 3
        else:
            ops.append((status[i + 1], GIT_OP.get(code, "edit")))
            i += 2
    counts: dict[str, tuple[int, int]] = {}
    nums = _tokens(run(["git", "-C", str(root), "show", "--format=", "-M", "-z", "--numstat", sha], root))
    i = 0
    while i < len(nums) and nums[i]:
        add, dele, path = nums[i].split("\t", 2)
        if path == "":  # a rename: the next two tokens are the old and the new path
            path, i = nums[i + 2], i + 2
        counts[path] = (int(add) if add.isdigit() else 0, int(dele) if dele.isdigit() else 0)  # binary files are "-"
        i += 1
    return [{"path": p, "op": op, "additions": counts.get(p, (0, 0))[0], "deletions": counts.get(p, (0, 0))[1]} for p, op in ops]


def from_squash(root: Path, number: int, repo: str | None, run: Run) -> dict[str, Any]:
    try:
        log = run(["git", "-C", str(root), "log", "-E", f"--grep=\\(#{number}\\)$", "--format=%H%x00%s%x00%an%x00%cI", "-n", "1"], root).strip()
    except (OSError, subprocess.SubprocessError) as e:
        raise ReplayError(f"git history unreadable: {e}") from e
    if not log:
        raise ReplayError(f"PR #{number}: gh could not read it and no commit on this history ends with (#{number})")
    sha, title, author, at = log.split("\0")
    repo = repo or repo_of(root, run)
    return {
        "id": f"pr-{number}", "kind": "pr", "number": number, "title": title, "author": author,
        "url": f"https://github.com/{repo}/pull/{number}" if repo else "", "mergedAt": at, "source": "squash",
        "commits": [{"sha": sha, "title": title, "at": at, "files": squash_files(root, sha, run)}],
    }  # fmt: skip


def import_pr(project: Path | str, number: int, *, repo: str | None = None, agent: str | None = None, run: Run | None = None, home: Path | None = None) -> dict[str, Any]:
    """Write ``pr-<number>.json`` (overwriting) and return its summary ``{id, number, source, commits, files}``."""
    root = Path(project)
    run = run or run_cmd
    if agent is not None and agent not in AGENT_KINDS:
        raise ReplayError(f"--agent is one of {', '.join(AGENT_KINDS)}")
    try:
        data = from_github(root, number, repo, run)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, ReplayError):
        data = from_squash(root, number, repo, run)
    data["agent"] = {"kind": agent, "source": "flag"} if agent else detect_agent(data, home)
    out = replays_dir(root)
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / f".pr-{number}.json.tmp"
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, out / f"pr-{number}.json")
    return {"id": data["id"], "number": number, "source": data["source"], "agent": data["agent"], "commits": len(data["commits"]), "files": sum(len(c["files"]) for c in data["commits"])}


# ——— which agent made it ———
BEFORE_S, AFTER_S = 2 * 3600, 3600  # a session counts when its log overlaps the span from 2 h before the first commit to 1 h after the merge
FIRST_TS = re.compile(rb'"timestamp"\s*:\s*"([^"]+)"')


def _epoch(iso: str) -> float | None:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _began(path: Path, mtime: float) -> float:
    """When the log's first record was written (its own timestamp; the file's mtime when it has none)."""
    try:
        with path.open("rb") as f:
            m = FIRST_TS.search(f.read(8192))
    except OSError:
        return mtime
    return (_epoch(m.group(1).decode()) if m else None) or mtime


def _session_of(kind: str, path: Path, base: Path) -> str:
    """The id the CLI knows the session by (a Claude sub-agent's log belongs to its parent's session)."""
    if kind == "claude":
        rel = path.relative_to(base).parts  # <project dir>/<session>.jsonl | <project dir>/<session>/subagents/agent-x.jsonl
        return rel[1] if len(rel) > 2 else path.stem
    if kind == "codex":
        return path.stem[-36:]
    return path.stem.split("_", 1)[-1]


def detect_agent(data: dict[str, Any], home: Path | None = None) -> dict[str, Any]:
    """Which agent CLI made the PR: the session whose log, written around the PR, mentions its head branch
    (``wt-<branch>`` counts triple: that is the work tree the agent was given). Read-only; nothing found → unknown."""
    none = {"kind": "unknown", "source": "none"}
    branch = data.get("branch") or ""
    times = [t for t in (_epoch(c["at"]) for c in data.get("commits") or []) if t is not None]
    merged = _epoch(data.get("mergedAt") or "")
    if not branch or not times:
        return none
    lo, hi = min(times) - BEFORE_S, (merged if merged is not None else max(times)) + AFTER_S
    word = r"(?<![A-Za-z0-9])%s(?![A-Za-z0-9_])"
    wt = re.compile((word % re.escape("wt-" + branch)).encode())
    plain = re.compile((word % re.escape(branch)).encode())
    home = home or Path.home()
    best: tuple[int, float, str, str] | None = None
    for kind, base in (("claude", home / ".claude" / "projects"), ("codex", home / ".codex" / "sessions"), ("pi", home / ".pi" / "agent" / "sessions")):
        for f in base.rglob("*.jsonl") if base.is_dir() else []:
            try:
                mtime = f.stat().st_mtime
                if mtime < lo or _began(f, mtime) > hi:  # a session that ran on past the merge still counts
                    continue
                blob = f.read_bytes()
            except OSError:
                continue
            score = 3 * len(wt.findall(blob)) + len(plain.findall(blob))
            if score and (best is None or (score, mtime) > best[:2]):
                best = (score, mtime, kind, _session_of(kind, f, base))
    return {"kind": best[2], "source": "session", "session": best[3]} if best else none


# ——— read (the server) ———
def summary(data: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "kind", "number", "title", "author", "mergedAt", "source", "agent")
    return {**{k: data.get(k) for k in keys}, "commits": len(data.get("commits") or []), "files": sum(len(c.get("files") or []) for c in data.get("commits") or [])}


def read_replay(project: Path | str, id: str) -> dict[str, Any] | None:
    if not valid_id(id):
        return None
    try:
        return json.loads((replays_dir(Path(project)) / f"{id}.json").read_text())
    except (OSError, ValueError):
        return None


def list_replays(project: Path | str) -> list[dict[str, Any]]:
    rows = []
    d = replays_dir(Path(project))
    for f in d.glob("pr-*.json") if d.is_dir() else []:
        data = read_replay(project, f.stem)
        if data:
            rows.append(summary(data))
    return sorted(rows, key=lambda r: -(r.get("number") or 0))
