#!/usr/bin/env python3
"""Record a CLI's fixture for the adapter contract tests (web/docs/cli-adapters.md §6).

    uv run python scripts/record_agent_fixture.py <claude|codex|grok|cursor|devin> [--dry-run] [--keep-native]

Runs the CLI once, headless, with its cheapest model, in a fresh ``/tmp/agora-record-<kind>-*``
git directory, on a fixed prompt: Claude, Codex, Grok have ONE sub-agent write ``hello.txt``
(``hi``), then run ``ls``; Cursor and Devin (observed workers) read ``alpha.txt`` with their read
tool and ``beta.txt`` with ``cat``, then write ``gamma.txt``. Then it

1. copies the native logs it created (the session, its sub-agents; Devin: its rows of sessions.db,
   read-only, with the schema) and the headless stream into ``tests/fixtures/agents/<kind>/<version>/``,
   sanitized: the temp directory becomes ``/work/project``, the home directory ``/home/user``,
   signatures are dropped, private context the CLI copies in (rules, skills, memories) is redacted;
2. writes ``meta.json``: command, date, model, CLI version, the native id, what the contract test
   may expect (the files written and read, a shell command, sub-agents — taken from the recorded
   log itself), and ``expected_unknown`` — the record types the adapter does not know yet (drift,
   reviewed by a person before committing);
3. deletes every native session the run created (the CLI's own delete command when it has one:
   ``codex delete``, ``grok sessions delete``, ``devin rm``; Cursor: its folders for the temp
   directory), and puts back, byte for byte, any trust entry the CLI added to its config for the
   temp directory;
4. removes the temp directory.

It spends real money (a few cents). Never schedule it without the user's consent (off by default).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from server.canvas import adapters  # noqa: E402
from server.canvas.adapters import drift  # noqa: E402
from server.canvas.agents import child_env  # noqa: E402

HOME = Path.home()
FIX = REPO / "tests" / "fixtures" / "agents"
SANE_CWD = "/work/project"
SANE_HOME = "/home/user"

PROMPTS = {
    "claude": "Use the Agent tool exactly once: ask a general-purpose sub-agent to create the file hello.txt containing the single word hi in the current directory. When it has finished, run the shell command `ls` yourself with the Bash tool. Then reply with one word: done.",
    "codex": "Do not read or use any skill, smx-team or Seedmux. Call your built-in collaboration tool spawn_agent exactly once to start one worker sub-agent whose task is: create the file hello.txt containing the single word hi in the current directory. Then call wait_agent until it has finished. Then run `ls` yourself. Reply with one word: done.",
    "grok": "Use spawn_subagent exactly once (a general sub-agent, not read-only) and have it create the file hello.txt containing the single word hi in the current directory; wait for its result. Then run the shell command `ls` once yourself. Reply with one word: done.",
}
# Observed workers (Cursor, Devin): what the workstation view shows of them is which files they read and write.
READ_WRITE = "Read the file alpha.txt with your file-reading tool. Then read beta.txt by running the shell command `cat beta.txt`. Then create the file gamma.txt containing the two words you read, separated by one space. Do not change any other file. Reply with one word: done."
PROMPTS.update({"cursor": READ_WRITE, "devin": READ_WRITE})
SETUP = {"cursor": {"alpha.txt": "alpha\n", "beta.txt": "beta\n"}, "devin": {"alpha.txt": "alpha\n", "beta.txt": "beta\n"}}
MODELS = {"claude": "haiku", "codex": "gpt-5.6-luna", "grok": "grok-4.7-build-fast", "cursor": "gpt-5.3-codex-low", "devin": "swe-2-medium"}


def argv(kind: str, prompt: str, model: str) -> list[str]:
    if kind == "claude":
        return ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", model, "--permission-mode", "acceptEdits", "--allowedTools", "Agent", "Write", "Bash(ls)", "Bash(ls:*)", "--", prompt]
    if kind == "codex":
        return ["codex", "exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-m", model, "-c", 'model_reasoning_effort="low"', prompt]
    if kind == "grok":
        return ["grok", "-p", prompt, "-m", model, "--output-format", "streaming-json", "--always-approve"]
    if kind == "cursor":
        return ["cursor-agent", "-p", "--output-format", "stream-json", "--trust", "--force", "--model", model, prompt]
    if kind == "devin":  # print mode has no structured output; the session is read from sessions.db
        return ["devin", "-p", "--model", model, "--permission-mode", "dangerous", "--respect-workspace-trust", "false", "--", prompt]
    raise SystemExit(f"no recipe for {kind!r} (droid: log in first, see web/docs/cli-adapters.md)")


# ——— config trust entries: snapshot, then put back byte for byte ———
# Only the config files these CLIs write a trust entry or run state into, held in memory and never
# written anywhere else. Never credential files (~/.codex/auth.json, ~/.grok/auth.json, Claude's
# keychain / .credentials.json, ~/.config/devin/credentials.toml, tokens): they are not read, copied
# or snapshotted by this script.
TRUST_FILES = [
    HOME / ".claude.json",
    HOME / ".codex" / "config.toml",
    HOME / ".grok" / "trusted_folders.toml",
    HOME / ".cursor" / "cli-config.json",
    HOME / ".cursor" / "agent-cli-state.json",
    HOME / ".config" / "devin" / "config.json",
    HOME / ".local" / "share" / "devin" / "cli" / "trusted_workspaces.json",
]
CREDENTIALS = ("auth.json", ".credentials.json", "credentials.toml", "token")
assert not any(any(c in p.name for c in CREDENTIALS) for p in TRUST_FILES)


def snapshot() -> dict[Path, bytes | None]:
    return {p: (p.read_bytes() if p.exists() else None) for p in TRUST_FILES}


def restore(before: dict[Path, bytes | None], cwds: list[str]) -> list[str]:
    """Undo what the run added for ``cwds`` in each config. A file nobody else touched meanwhile
    gets its old bytes back; one another process also changed only loses our entries."""
    notes = []
    for p, old in before.items():
        now = p.read_bytes() if p.exists() else None
        if now == old:
            continue
        if old is None:
            notes.append(f"{p}: created by the run — left in place (not ours to delete)")
            continue
        text = now.decode("utf-8", "replace") if now else ""
        if not any(c in text for c in cwds):
            keys = _changed_keys(old, now)
            notes.append(f"{p}: changed during the run with no entry for the temp dir{f' (keys: {keys})' if keys else ''} — left as is")
            continue
        if p.suffix == ".json":
            try:
                cur, prev = json.loads(text), json.loads(old)
            except ValueError:
                notes.append(f"{p}: not JSON any more — left as is")
                continue
            cur = _without(cur, cwds)  # Claude: projects.<dir>; Devin: trusted_paths[]
            if cur == prev:
                p.write_bytes(old)
                notes.append(f"{p}: removed the temp dir's entry — restored byte-identical")
            else:
                p.write_text(json.dumps(cur, indent=2, ensure_ascii=False) + "\n")
                notes.append(f"{p}: removed the temp dir's entry; other keys changed concurrently, so not byte-identical")
        elif now is not None and now.startswith(old) and all(any(c in h for c in cwds) for h in re.findall(r"^\[.*\]$", now[len(old):].decode("utf-8", "replace"), re.M)) and re.search(r"^\[", now[len(old):].decode("utf-8", "replace"), re.M):
            p.write_bytes(old)  # the CLI only appended its trust table for the temp dir
            notes.append(f"{p}: removed the appended trust entry for the temp dir — restored byte-identical")
        else:
            lines = text.splitlines(keepends=True)
            keep, skip = [], False
            for line in lines:
                if line.startswith("[") and any(c in line for c in cwds):
                    skip = True
                    continue
                if skip and line.startswith("["):
                    skip = False
                if not skip and not any(c in line for c in cwds):
                    keep.append(line)
            new = "".join(keep).encode()
            if new == old:
                p.write_bytes(old)
                notes.append(f"{p}: removed the temp dir's entry — restored byte-identical")
            else:
                notes.append(f"{p}: has an entry for the temp dir and other changes — NOT touched, fix by hand")
    return notes


def _changed_keys(old: bytes, now: bytes | None) -> str:
    """The top-level keys whose values differ, for a JSON config (names only, never values)."""
    try:
        a, b = json.loads(old), json.loads(now or b"{}")
    except ValueError:
        return ""
    return ", ".join(sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))) if isinstance(a, dict) and isinstance(b, dict) else ""


def stop_leftovers(cwds: list[str]) -> list[str]:
    """Processes the run left behind in its temp directory (cursor-agent keeps a ``worker-server``
    and a language server running after ``-p``): terminated. Only processes whose working
    directory is the temp dir — ours by construction."""
    try:
        out = subprocess.run(["lsof", "-a", "-d", "cwd", "-F", "pn"], capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        return ["lsof failed: leftover processes not checked"]
    done, pid = [], None
    for line in out.splitlines():
        if line.startswith("p"):
            pid = int(line[1:])
        elif line.startswith("n") and pid and pid != os.getpid() and any(line[1:] == c or line[1:].startswith(c.rstrip("/") + "/") for c in cwds):
            try:
                os.kill(pid, 15)
                done.append(f"terminated pid {pid} (cwd in the temp dir)")
            except OSError as e:
                done.append(f"pid {pid}: {e}")
    return done


def _without(v, cwds: list[str]):
    """``v`` without the keys / list items that are one of ``cwds`` (or a path inside one)."""
    ours = lambda x: isinstance(x, str) and any(x == c or x.startswith(c.rstrip("/") + "/") for c in cwds)  # noqa: E731
    if isinstance(v, dict):
        return {k: _without(x, cwds) for k, x in v.items() if not ours(k)}
    if isinstance(v, list):
        return [_without(x, cwds) for x in v if not ours(x)]
    return v


# ——— sanitizing ———
def sanitizer(cwds: list[str]):
    import urllib.parse

    pairs = []
    for c in sorted(set(cwds), key=len, reverse=True):
        pairs += [(c, SANE_CWD), (urllib.parse.quote(c, safe=""), urllib.parse.quote(SANE_CWD, safe="")), ("".join(ch if ch.isalnum() else "-" for ch in c), "".join(ch if ch.isalnum() else "-" for ch in SANE_CWD))]
        pairs.append((re.sub(r"[^a-zA-Z0-9]+", "-", c).strip("-"), re.sub(r"[^a-zA-Z0-9]+", "-", SANE_CWD).strip("-")))  # Cursor's folder
    pairs.append((str(HOME), SANE_HOME))
    tmp_re = re.compile(r"(?:/private)?/tmp/agora-record-[a-z]+-[a-z0-9_]+|-private-tmp-agora-record-[a-z]+-[a-z0-9_]+|%2F(?:private%2F)?tmp%2Fagora-record-[a-z]+-[a-z0-9_]+")
    sane = {"/": SANE_CWD, "-": "".join(ch if ch.isalnum() else "-" for ch in SANE_CWD), "%": urllib.parse.quote(SANE_CWD, safe="")}

    def clean(obj):
        if isinstance(obj, dict):  # keys too: Codex FileChange ``changes`` is keyed by path
            return {clean(k): clean(v) for k, v in obj.items() if k not in ("signature", "encrypted_content")}
        if isinstance(obj, list):
            return [clean(v) for v in obj]
        if isinstance(obj, str):
            for a, b in pairs:
                obj = obj.replace(a, b)
            return tmp_re.sub(lambda m: sane[m.group(0)[0]], obj)
        return obj

    return clean


REDACTED = "<redacted: private context>"
KEEP_INIT = ("type", "subtype", "session_id", "model", "cwd", "permissionMode", "apiKeySource", "claude_code_version")


def scrub(kind: str, rec: dict) -> dict | None:
    """Drop what a CLI copies into its log from the user's own setup — instructions (CLAUDE.md /
    AGENTS.md), memories, skill and MCP listings, session context, hook commands — but keep every
    record's type, so the fixture still shows the adapter the whole record vocabulary."""
    t = rec.get("type")
    if kind == "claude":
        if t == "attachment":
            att = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
            keep = ("parentUuid", "isSidechain", "agentId", "type", "uuid", "timestamp", "userType", "entrypoint", "cwd", "sessionId", "version", "gitBranch")
            return {k: rec[k] for k in keep if k in rec} | {"attachment": {"type": att.get("type"), "content": REDACTED}}
        if t == "system" and rec.get("subtype") == "init":
            return {k: rec[k] for k in KEEP_INIT if k in rec}
        if t == "system" and rec.get("subtype") in ("stop_hook_summary", "hook_started", "hook_response"):
            return {k: v for k, v in rec.items() if k in ("type", "subtype", "uuid", "parentUuid", "timestamp", "sessionId", "session_id", "isSidechain", "hook_name")}
        if "rendered" in rec:
            rec = {k: v for k, v in rec.items() if k != "rendered"}
    if kind == "codex":
        p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        if t == "session_meta":
            return {**rec, "payload": {k: p[k] for k in ("id", "timestamp", "cwd", "originator", "cli_version", "source", "model_provider", "agent_nickname", "agent_role") if k in p}}
        if t == "world_state":
            return {**rec, "payload": {"full": p.get("full"), "state": REDACTED}}
        if t == "turn_context":
            return {**rec, "payload": {k: v for k, v in p.items() if k not in ("user_instructions", "developer_instructions", "base_instructions", "instructions")}}
        if t == "response_item" and p.get("type") == "message" and p.get("role") in ("developer", "system"):
            return {**rec, "payload": {**p, "content": [{"type": "input_text", "text": REDACTED}]}}
        if t == "response_item" and p.get("type") == "message" and p.get("role") == "user":
            txt = json.dumps(p.get("content"))
            if "<environment_context>" in txt or "AGENTS.md" in txt or "<user_instructions>" in txt:
                return {**rec, "payload": {**p, "content": [{"type": "input_text", "text": REDACTED}]}}
    if kind == "grok":
        if t == "available_commands":  # the user's installed skills, tools and commands
            return {"type": "available_commands", "tools": [REDACTED], "commands": [REDACTED]}
        if "chat_format_version" in rec and "info" in rec:  # summary.json
            return {k: rec[k] for k in ("info", "created_at", "updated_at", "last_active_at", "chat_format_version", "session_kind", "current_model_id", "reasoning_effort", "num_messages") if k in rec}
        u = ((rec.get("params") or {}).get("update")) if isinstance(rec.get("params"), dict) else None
        if isinstance(u, dict) and u.get("sessionUpdate") == "hook_execution":
            return {**rec, "params": {**rec["params"], "update": {"sessionUpdate": "hook_execution", "event_name": u.get("event_name")}}}
    if kind == "cursor":
        from server.canvas.adapters.cursor import prompt_of

        if rec.get("role") == "user" and prompt_of(rec) is None:  # a context block the CLI adds (sub-agent types, tool catalogs)
            return {"role": "user", "message": {"content": [{"type": "text", "text": f"<context>{REDACTED}</context>"}]}}
        if t == "system" and rec.get("subtype") == "init":  # stream-json
            return {k: rec[k] for k in ("type", "subtype", "cwd", "session_id", "model", "permissionMode", "apiKeySource") if k in rec}
    if kind == "devin" and isinstance(rec.get("chat_message"), dict):  # one message_nodes row
        m = rec["chat_message"]
        md = m.get("metadata") if isinstance(m.get("metadata"), dict) else {}
        typed = m.get("role") == "user" and md.get("is_user_input") is True
        if m.get("role") == "system" or (m.get("role") == "user" and not typed):  # rules, skills, workspace context
            ext = md.get("extensions") if isinstance(md.get("extensions"), dict) else {}
            m = {**m, "content": REDACTED, "metadata": {**md, "extensions": {k: REDACTED for k in ext}}}
        return {**rec, "chat_message": m}
    return rec


PRIVATE = [str(HOME), os.environ.get("USER", "\0"), "kazelis"]


def leak_check(folder: Path) -> list[str]:
    """Strings that must never end up in a committed fixture."""
    bad = []
    for f in folder.rglob("*"):
        if f.is_file():
            text = f.read_text(errors="replace")
            bad += [f"{f.relative_to(folder)}: {w}" for w in PRIVATE if w and w in text]
    return bad


def copy_jsonl(src: Path, dst: Path, clean, kind: str = "") -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    out = []
    for line in src.read_text(errors="replace").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        rec = scrub(kind, rec) if isinstance(rec, dict) else rec
        if rec is not None:
            out.append(json.dumps(clean(rec), ensure_ascii=False))
    dst.write_text("\n".join(out) + "\n")


def rescrub(folder: Path, kind: str) -> None:
    """Apply ``scrub`` to an already recorded fixture folder (in place)."""
    clean = sanitizer([])
    for f in folder.rglob("*.jsonl"):
        copy_jsonl(f, f.with_suffix(".tmp"), clean, kind)
        f.with_suffix(".tmp").replace(f)
    for f in folder.rglob("summary.json"):
        f.write_text(json.dumps(clean(scrub(kind, json.loads(f.read_text()))), ensure_ascii=False, indent=1))


# ——— per CLI: find what the run created, copy it, delete it ———
def claude_collect(cwd: str, since: float, stream: list[dict]) -> tuple[str, list[Path]]:
    sid = next((d.get("session_id") for d in stream if d.get("type") == "system" and d.get("session_id")), None)
    a = adapters.need("claude")
    look = a.locate(sid, cwd) if sid else None
    if not look or not look.path:
        raise SystemExit(f"claude: no session log for {sid}")
    # The project folder is unique to the temp dir; session-env and the task-output folder are the run's own.
    created = [look.path.parent, HOME / ".claude" / "session-env" / sid]
    created += [Path(p) for p in glob.glob(f"/private/tmp/claude-{os.getuid()}/{look.path.parent.name}")]
    return sid, created


def codex_collect(cwd: str, since: float, stream: list[dict]) -> tuple[str, list[Path]]:
    sid = next((d.get("thread_id") for d in stream if d.get("type") == "thread.started"), None)
    a = adapters.need("codex")
    look = a.locate(sid)
    if not look.path:
        raise SystemExit(f"codex: no rollout for {sid}")
    return sid, [look.path]


def grok_collect(cwd: str, since: float, stream: list[dict]) -> tuple[str, list[Path]]:
    sid = next((d.get("sessionId") for d in stream if d.get("type") == "end" and d.get("sessionId")), None)
    a = adapters.need("grok")
    look = a.locate(sid)
    if not look.path:
        raise SystemExit(f"grok: no session for {sid}")
    # The folder for the temp cwd (it also gets a prompt_history.jsonl) is the run's own.
    return sid, [look.path.parent, look.path.parent.parent]


def cursor_collect(cwd: str, since: float, stream: list[dict]) -> tuple[str, list[Path]]:
    import hashlib

    from server.canvas.adapters.cursor import data_dir, slug

    sid = next((d.get("session_id") for d in stream if d.get("session_id")), None)
    look = adapters.need("cursor").locate(sid, os.path.realpath(cwd)) if sid else None
    # The workspace folder and the chat store are the temp dir's own (never read: store.db is Cursor's).
    dirs = {cwd, os.path.realpath(cwd)}
    created = [data_dir() / "projects" / slug(c) for c in dirs] + [data_dir() / "chats" / hashlib.md5(c.encode()).hexdigest() for c in dirs]
    return (sid if look is not None and look.path is not None else None), created


RUN_PID: int | None = None  # the CLI process of this run (Devin names its diagnostic log after it)


def devin_collect(cwd: str, since: float, stream: list[dict]) -> tuple[str, list[Path]]:
    from server.canvas.adapters.devin import _query, db_path

    db = db_path()
    rows = _query(db, "select id from sessions where working_directory in (?, ?) and created_at >= ? order by created_at", (cwd, os.path.realpath(cwd), int(since) - 5))
    sid = rows[-1][0] if rows else None
    cli = db.parent
    created = [cli / "transcripts" / f"{sid}.json", cli / "session_locks" / f"{sid}.lock"] if sid else []
    created += [Path(p) for p in glob.glob(str(cli / "logs" / f"*_{RUN_PID}.log*"))] if RUN_PID else []
    return sid, created


def devin_logs(sid: str | None, cwds: list[str], since: float) -> list[str]:
    """Devin's diagnostic logs (``logs/devin_<time>_<pid>.log``) written by this run and by ``devin rm``:
    removed when they name the session or the temp dir; any other log written meanwhile is kept and listed."""
    from server.canvas.adapters.devin import db_path

    done = []
    for f in sorted((db_path().parent / "logs").glob("devin_*.log")):
        try:
            if f.stat().st_mtime < since:
                continue
            text = f.read_text(errors="replace")
        except OSError:
            continue
        if (sid and sid in text) or any(c in text for c in cwds):
            f.unlink()
            done.append(f"rm {f}")
        else:
            done.append(f"kept {f.name}: written during the run, names neither the session nor the temp dir")
    return done


def devin_export(sid: str, dest: Path, clean) -> None:
    """The session's rows of sessions.db (read-only) as ``schema.sql``, ``session.json``, ``log.jsonl``."""
    import sqlite3
    import urllib.parse

    from server.canvas.adapters.devin import db_path

    db = db_path()
    con = sqlite3.connect(f"file:{urllib.parse.quote(str(db))}?mode=ro", uri=True, timeout=5)
    try:
        schema = [sql for (sql,) in con.execute("select sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by rowid")]
        versions = con.execute("select version, name from refinery_schema_history order by version").fetchall()
        cols = [c[1] for c in con.execute("pragma table_info(sessions)")]
        row = dict(zip(cols, con.execute("select * from sessions where id = ?", (sid,)).fetchone()))
        nodes = con.execute("select row_id, node_id, parent_node_id, chat_message, created_at, metadata from message_nodes where session_id = ? order by row_id", (sid,)).fetchall()
    finally:
        con.close()
    (dest / "schema.sql").write_text(";\n".join(schema) + ";\n")
    row = {**row, "cogs_json": REDACTED if row.get("cogs_json") else row.get("cogs_json")}  # the CLI's system prompt and the user's permission rules
    (dest / "session.json").write_text(json.dumps(clean({"row": row, "schema_versions": versions}), ensure_ascii=False, indent=1) + "\n")
    recs = [scrub("devin", {"row_id": r, "node_id": n, "parent_node_id": p, "created_at": c, "metadata": json.loads(md) if md else None, "chat_message": json.loads(cm)}) for r, n, p, cm, c, md in nodes]
    (dest / "log.jsonl").write_text("".join(json.dumps(clean(x), ensure_ascii=False) + "\n" for x in recs))


def tools_of(ad, path: Path, root: str) -> list[dict]:
    """The tool items of the recorded session, as the run timeline projects them."""
    from server.canvas.adapters import runs as runs_mod

    return [i["tool"] for i in runs_mod.timeline(ad.kind, path, root)["items"] if i["kind"] == "tool"]


def main() -> int:
    global RUN_PID
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=sorted(PROMPTS))
    ap.add_argument("--model", default=None)
    ap.add_argument("--dry-run", action="store_true", help="print the command, run nothing")
    ap.add_argument("--keep-native", metavar="MANIFEST", default=None, help="keep the native sessions for now (e.g. to look at them in Agora) and write what to delete to MANIFEST")
    ap.add_argument("--rescrub", metavar="FOLDER", default=None, help="apply the privacy scrub to an existing fixture folder")
    ap.add_argument("--cleanup", metavar="MANIFEST", default=None, help="delete the native sessions a --keep-native run left, from its manifest")
    ap.add_argument("--out", default=str(FIX))
    a = ap.parse_args()
    if a.rescrub:
        rescrub(Path(a.rescrub), a.kind)
        print(json.dumps({"rescrubbed": a.rescrub, "leaks": leak_check(Path(a.rescrub))}, ensure_ascii=False))
        return 0
    if a.cleanup:
        m = json.loads(Path(a.cleanup).read_text())
        print(json.dumps(delete_native(m["kind"], m.get("native_id"), [Path(x) for x in m["created"]], m.get("children") or []), ensure_ascii=False, indent=2))
        return 0
    kind, model = a.kind, a.model or MODELS[a.kind]
    ad = adapters.need(kind)
    version = ad.version(child_env()) or "unknown"
    cmd = argv(kind, PROMPTS[kind], model)
    if a.dry_run:
        print(json.dumps({"kind": kind, "version": version, "argv": cmd}, ensure_ascii=False))
        return 0
    tmp = Path(tempfile.mkdtemp(prefix=f"agora-record-{kind}-", dir="/tmp"))
    real = os.path.realpath(tmp)
    cwds = sorted({str(tmp), real})
    subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
    for name, text in SETUP.get(kind, {}).items():
        (tmp / name).write_text(text)
    before = snapshot()
    started = time.time()
    report: dict = {"kind": kind, "version": version, "model": model, "tmp": str(tmp), "argv": cmd[:-1] + ["<prompt>"] if kind != "grok" else cmd}
    created: list[Path] = []
    try:
        proc = subprocess.Popen(cmd, cwd=tmp, env=child_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, stdin=subprocess.DEVNULL)
        RUN_PID = report["pid"] = proc.pid
        try:
            out, err = proc.communicate(timeout=900)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
        report["exit"] = proc.returncode
        report["stderr_tail"] = (err or "")[-600:]
        stream = []
        for line in out.splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, dict):
                stream.append(d)
        report["hello"] = (tmp / "hello.txt").read_text().strip() if (tmp / "hello.txt").exists() else None
        report["gamma"] = (tmp / "gamma.txt").read_text().strip() if (tmp / "gamma.txt").exists() else None
        if not stream:
            report["stdout_tail"] = out[-600:]
        sid, created = {"claude": claude_collect, "codex": codex_collect, "grok": grok_collect, "cursor": cursor_collect, "devin": devin_collect}[kind](str(tmp), started, stream)
        report["native_id"] = sid
        if not sid:
            raise SystemExit(f"{kind}: the run left no session to record (see stderr_tail)")
        clean = sanitizer(cwds)
        dest = Path(a.out) / kind / version
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        if stream:
            (dest / "stream.jsonl").write_text("".join(json.dumps(clean(x), ensure_ascii=False) + "\n" for x in (scrub(kind, d) for d in stream) if x is not None))
        report["usage"] = next((d.get("usage") for d in reversed(stream) if d.get("type") in ("result", "end") and d.get("usage")), None)
        from server.canvas.adapters.base import NativeRef

        look = ad.locate(sid, real)
        kids = ad.children(NativeRef(kind, sid, look.path, real)) if hasattr(ad, "children") else []
        report["children"] = [k.native_id for k in kids]
        if kind == "claude":
            copy_jsonl(look.path, dest / "log.jsonl", clean, kind)
            sub = look.path.parent / look.path.stem / "subagents"
            for f in sorted(sub.glob("agent-*")) if sub.is_dir() else []:
                if f.suffix == ".jsonl":
                    copy_jsonl(f, dest / "subagents" / f.name, clean, kind)
                else:
                    (dest / "subagents").mkdir(parents=True, exist_ok=True)
                    (dest / "subagents" / f.name).write_text(json.dumps(clean(json.loads(f.read_text())), ensure_ascii=False))
        elif kind == "codex":
            copy_jsonl(look.path, dest / "log.jsonl", clean, kind)
            for k in kids:
                if k.path:
                    copy_jsonl(k.path, dest / "children" / f"{k.native_id}.jsonl", clean, kind)
                    created.append(k.path)
        elif kind == "grok":
            sdir = look.path.parent
            copy_jsonl(look.path, dest / "updates.jsonl", clean, kind)
            if (sdir / "summary.json").exists():
                (dest / "summary.json").write_text(json.dumps(clean(scrub(kind, json.loads((sdir / "summary.json").read_text()))), ensure_ascii=False, indent=1))
            for mf in sdir.glob("subagents/*/meta.json"):
                o = dest / "subagents" / mf.parent.name / "meta.json"
                o.parent.mkdir(parents=True, exist_ok=True)
                o.write_text(json.dumps(clean(json.loads(mf.read_text())), ensure_ascii=False))
            for k in kids:
                if k.path:
                    copy_jsonl(k.path, dest / "children" / k.native_id / "updates.jsonl", clean, kind)
                    created.append(k.path.parent)
        elif kind == "cursor":
            copy_jsonl(look.path, dest / "log.jsonl", clean, kind)
            for k in kids:
                copy_jsonl(k.path, dest / "subagents" / f"{k.native_id}.jsonl", clean, kind)
        elif kind == "devin":
            devin_export(sid, dest, clean)
            report["usage"] = json.loads((dest / "session.json").read_text())["row"].get("metadata")  # credits; SWE-2 is free
        unknown = drift.scan(ad, look.path)["unknown"]  # the native log, before it is deleted
        if kind in SETUP:  # what the recording shows, from the recorded log itself
            tools = tools_of(ad, look.path, real)
            wrote = {f["path"] for t in tools for f in t.get("files") or []}
            shells = {"cursor": ("Shell", "Bash", "run_terminal_cmd"), "devin": ("exec",)}[kind]
            expected = {"files": [f for f in ("gamma.txt",) if f in wrote and report["gamma"]], "reads": sorted({r for t in tools for r in t.get("reads") or []} & set(SETUP[kind])), "commands": int(any(t.get("name") in shells for t in tools)), "subagents": len(kids)}
        else:
            expected = {"files": ["hello.txt"] if report["hello"] else [], "commands": 1, "subagents": len(kids)}
        meta = {
            "kind": kind,
            "cli_version": version,
            "log_format": ad.log_format(look.path),
            "recorded": date.today().isoformat(),
            "model": model,
            "command": report["argv"],
            "prompt": PROMPTS[kind],
            "cwd": SANE_CWD,
            "native_id": sid,
            "expected": expected,
            "expected_unknown": sorted(unknown),
            "note": "Recorded by scripts/record_agent_fixture.py; paths sanitized (/work/project, /home/user), signatures dropped. The native sessions were deleted after copying.",
        }
        (dest / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
        leaks = leak_check(dest)
        if leaks:
            shutil.rmtree(dest)
            raise SystemExit("private strings in the fixture, not written: " + "; ".join(leaks[:5]))
        report["fixture"] = str(dest)
        report["expected_unknown"] = meta["expected_unknown"]
    finally:
        # Native sessions this run created (never anything else).
        if a.keep_native:
            Path(a.keep_native).write_text(json.dumps({"kind": kind, "native_id": report.get("native_id"), "children": report.get("children") or [], "created": [str(p) for p in created]}, indent=2))
            report["kept"] = a.keep_native
        else:
            report["deleted"] = delete_native(kind, report.get("native_id"), created, report.get("children") or [])
            if kind == "devin":
                report["deleted"] += devin_logs(report.get("native_id"), cwds, started)
        report["config"] = restore(before, cwds)
        report["leftovers"] = stop_leftovers(cwds)
        shutil.rmtree(tmp, ignore_errors=True)
        report["tmp_removed"] = not tmp.exists()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("fixture") else 1


def delete_native(kind: str, sid: str | None, created: list[Path], children: list[str]) -> list[str]:
    done = []
    if kind == "codex" and sid:
        for tid in [*children, sid]:  # children first: deleting the parent removes their index rows too
            r = subprocess.run(["codex", "delete", "--force", tid], capture_output=True, text=True, env=child_env(), timeout=60, stdin=subprocess.DEVNULL)
            done.append(f"codex delete --force {tid}: exit {r.returncode}")
    if kind == "grok" and sid:
        for tid in [sid, *children]:
            r = subprocess.run(["grok", "sessions", "delete", tid], capture_output=True, text=True, env=child_env(), timeout=60, input="y\n")
            done.append(f"grok sessions delete {tid}: exit {r.returncode}")
    if kind == "devin" and sid:
        r = subprocess.run(["devin", "rm", "--force", sid], capture_output=True, text=True, env=child_env(), timeout=60, stdin=subprocess.DEVNULL)
        done.append(f"devin rm --force {sid}: exit {r.returncode}")
    for p in created:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
            done.append(f"rm -r {p}")
        elif p.exists():
            p.unlink()
            done.append(f"rm {p}")
    return done


if __name__ == "__main__":
    sys.exit(main())
