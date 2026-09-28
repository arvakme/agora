"""The native coding agents a session can be bound to (tier T1 in the adapter registry,
server/canvas/adapters/): today Pi, Claude Code, Codex. What is specific to each CLI lives in its
adapter; this module keeps the public entry points (forwarding to the adapters) and the headless
runner.

Each is an ``AgentBackend`` (runner.py) for headless turns — the CLI's own print/exec
mode, run in the **project directory** and resuming the session's native id — plus what
the rest of Agora needs to know about that CLI: the interactive resume command for the
terminal pane, where its session log lives, and which models it offers.

Headless commands (checked against each CLI's ``--help``; docs: web/docs/agent-sessions.md):

- Claude Code ``claude -p --output-format stream-json --verbose (--session-id|--resume) <uuid>``
- Pi          ``pi -p --mode json --session-id <uuid> "<prompt>"``
- Codex       ``codex exec --json -`` (new) / ``codex exec resume <id> --json -``

Every backend emits the runner's event stream (``start``/``text``/``tool_use``/
``tool_result``/``usage``/``result``) with one ``Usage`` shape; ``result.raw`` is the
agent's final message text and ``result.session`` the native id (Codex assigns its id on
the first run, the other two use the id Agora picked when the session was created).

This module is also the eval baseline's neighbour, not its replacement: schema-constrained
planning in a neutral empty directory stays ``ClaudeCliBackend`` (``claude-cli``).
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from server.canvas import agent_models
from server.canvas.runner import KILL_GRACE_S, STDOUT_LIMIT, RunRequest, now_ms

# Moved to server/canvas/adapters/ and re-exported here: these names stay the public entry points.
from server.canvas import adapters
from server.canvas.adapters.claude import ClaudeStream
from server.canvas.adapters.claude import dir_name as claude_dir_name
from server.canvas.adapters.codex import CodexStream, codex_home as _codex_home, codex_usage
from server.canvas.adapters.codex import rollouts_since as codex_rollouts_since
from server.canvas.adapters.codex import state_rollout as codex_state_rollout
from server.canvas.adapters.common import LogLookup, StreamMapper, _hinted, add_usage, text_of  # noqa: F401
from server.canvas.adapters.pi import PiStream, pi_usage
from server.canvas.adapters.pi import dir_name as pi_dir_name
from server.canvas.adapters.pi import migrate_log as _migrate_pi_log
from server.canvas.adapters.pi import sessions_dir as _pi_sessions  # noqa: F401


REPO = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO / "skills" / "agora-canvas"
AGENT_BIN = REPO / "bin"

SESSION_TIMEOUT_S = 30 * 60

# Runtime markers of whatever agent or tmux started the Agora server. Inherited, they make a
# child CLI believe it is nested (Claude Code then stops saving its transcript, which is the
# sync channel). User configuration such as CLAUDE_CODE_USE_BEDROCK stays.
_NESTED = (
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CODEX_THREAD_ID",
    "TMUX",
    "TMUX_PANE",
)


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment for an agent CLI: ours minus nesting markers, ``bin/agora`` on PATH."""
    env = {k: v for k, v in os.environ.items() if k not in _NESTED and not k.startswith("CODEX_SANDBOX")}
    env["PATH"] = os.pathsep.join([str(AGENT_BIN), env.get("PATH", "")])
    env.update(extra or {})
    return env


# The session agents (tier T1) and their display names, from the adapter registry.
KINDS = adapters.session_kinds()
NAMES = {k: adapters.need(k).name for k in KINDS}


# ——— session logs (the CLIs' own transcripts) ———
# Where each CLI keeps a session's log, and which copy is the one it will resume, is each
# adapter's ``Locator`` (server/canvas/adapters/<kind>.py). A copy outside the current root is
# still followed when it is the only one (Claude resumes it globally); several copies are
# reported instead of picking one.
def locate_log(kind: str, native_id: str | None, root: Path | str | None = None, home: Path | None = None, hint: str | Path | None = None) -> LogLookup:
    """Find a native session's log. Claude and Pi: the copy under ``root`` (the project) first — it
    is the one the CLI resumes —, then a unique copy anywhere (Claude resumes it globally). Codex:
    the rollout glob, then the path the binding last saw (``hint``), then Codex's own index.
    Several copies with none of them the project's → ``ambiguous`` (never guessed: the CLI might
    resume another one); Pi only under another directory → ``elsewhere``."""
    if not native_id:
        return LogLookup("missing")
    return adapters.need(kind).locate(native_id, root, home or Path.home(), hint)


def migrate_pi_log(src: Path, new_root: Path | str) -> Path:
    """Move a Pi session log to the folder of the project's new root (adapters/pi.py ``migrate_log``)."""
    return _migrate_pi_log(src, new_root)


def new_native_since(kind: str, root: Path | str, since: float, taken: set[str], home: Path | None = None) -> str | None:
    """A native session started in ``root`` at/after ``since`` that no Agora session owns yet: what an
    interactive fork (or Codex's first interactive run) created. Oldest first."""
    return adapters.need(kind).new_since(root, since, taken, home or Path.home())


def claude_log(native_id: str, home: Path | None = None, root: Path | str | None = None) -> Path | None:
    return locate_log("claude", native_id, root, home).path


def pi_log(native_id: str, home: Path | None = None, root: Path | str | None = None) -> Path | None:
    return locate_log("pi", native_id, root, home).path


def codex_log(native_id: str, home: Path | None = None) -> Path | None:
    return locate_log("codex", native_id, None, home).path


def find_log(kind: str, native_id: str | None, root: Path | str | None = None) -> Path | None:
    return locate_log(kind, native_id, root).path if native_id else None


class NativeMissing(RuntimeError):
    """A session that already ran has no usable native log: resuming it would silently start a
    new, empty conversation under the same id (Claude ``--session-id``, Pi ``--session-id``), so
    Agora stops and says what is missing instead."""

    def __init__(self, kind: str, native_id: str, lookup: LogLookup) -> None:
        self.kind, self.native_id, self.lookup = kind, native_id, lookup
        super().__init__(native_problem(kind, native_id, lookup))

    def public(self) -> dict[str, Any]:
        return {"state": self.lookup.state, "blocking": True, "nativeId": self.native_id, "candidates": [str(p) for p in self.lookup.candidates], "message": str(self)}


def duplicates_note(kind: str, native_id: str, lookup: LogLookup) -> dict[str, Any] | None:
    """A found log that has other copies with the same id: which one is followed (not blocking)."""
    if lookup.path is None or len(lookup.candidates) < 2:
        return None
    others = [str(p) for p in lookup.candidates if p != lookup.path]
    return {
        "state": "duplicates",
        "blocking": False,
        "nativeId": native_id,
        "candidates": [str(lookup.path), *others],
        "message": f"{NAMES.get(kind, kind)} 的原生会话 {native_id} 另有 {len(others)} 份同 id 的记录；Agora 跟随的是这个项目目录下的那份（也是 CLI 续接的那份）。",
    }


def native_problem(kind: str, native_id: str, lookup: LogLookup) -> str:
    name = NAMES.get(kind, kind)
    if lookup.state == "missing":
        days = getattr(adapters.get(kind), "prunes_logs_after_days", None)
        why = f"可能被 {name} 的 {days} 天自动清理删掉了，或者这个项目是从别的机器拿来的。" if days else "日志可能被删除或移走了，或者这个项目是从别的机器拿来的。"
        return f"{name} 的原生会话 {native_id} 在这台机器上找不到了。{why}Agora 不会用同一个 id 新开对话。"
    if lookup.state == "ambiguous":
        return f"{name} 的原生会话 {native_id} 找到了 {len(lookup.candidates)} 份记录，Agora 不确定该跟哪一份，先不续接。"
    if lookup.state == "elsewhere":
        return f"{name} 的原生会话 {native_id} 在别的目录下（项目移动过？），在这里续接会新开一个空会话，所以先不续接。"
    return ""


def check_native(kind: str, native_id: str | None, started: bool, root: Path | str | None) -> LogLookup:
    """Resuming a session that already ran needs its log; raise ``NativeMissing`` when it is not usable.
    A session that never ran (``started`` false) may still be created."""
    if not native_id:
        return LogLookup("missing")
    lookup = locate_log(kind, native_id, root)
    if lookup.state != "found" and started:
        raise NativeMissing(kind, native_id, lookup)
    return lookup


# ——— backends ———
async def stop_group(proc: asyncio.subprocess.Process) -> None:
    """Stop a turn that is still running (timeout, "停止", client gone): SIGTERM to its whole
    process group (agent CLIs spawn MCP servers and shells), SIGKILL after a grace. A turn
    that ended on its own is left alone, including anything it deliberately left running."""
    if proc.returncode is not None:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), KILL_GRACE_S)
            return
        except BaseException:
            pass


class _CliBackend:
    """One CLI process per turn, JSONL on stdout, mapped by a ``StreamMapper``."""

    name = ""
    Mapper: type[StreamMapper] = StreamMapper

    def __init__(self, cmd: list[str] | None = None, *, timeout_s: float = SESSION_TIMEOUT_S, env: dict[str, str] | None = None) -> None:
        self.cmd = cmd or [self.default_bin]
        self.timeout_s = timeout_s
        self.env = env

    default_bin = ""

    def args(self, req: RunRequest) -> list[str]:
        """The adapter's ``Headless.headless_args``; whether a session's log exists is asked through
        ``locate_log`` (Claude: create with ``--session-id`` only when it never ran)."""
        return adapters.need(self.name).headless_args(self.cmd, req, log_exists=lambda sid: locate_log(self.name, sid, req.cwd).path is not None, skill_dir=SKILL_DIR)

    def stdin(self, req: RunRequest) -> bytes | None:
        own = getattr(adapters.need(self.name), "headless_stdin", None)
        return own(req) if own is not None else req.prompt.encode()

    async def run(self, req: RunRequest) -> AsyncIterator[dict[str, Any]]:
        o = req.options
        started = now_ms()
        mapper = self.Mapper(o.model or None, o.session)
        yield {"t": "start", "at": started, "backend": self.name, "model": o.model or None, "session": o.session}

        def finish(error: str | None) -> dict[str, Any]:
            at = now_ms()
            usage = mapper.final_usage(at - started)
            out: dict[str, Any] = {
                "t": "result",
                "at": at,
                "raw": mapper.text or None,
                "costUsd": usage["costUsd"],
                "durationMs": usage["durationMs"],
                "usage": usage,
                "backend": self.name,
                "session": mapper.session,
                "prompt": req.prompt,
            }
            if error:
                out["error"] = error
            return out

        data = self.stdin(req)
        try:
            proc = await asyncio.create_subprocess_exec(
                *self.args(req),
                stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=child_env({**(req.env or {}), **(self.env or {})}),
                cwd=req.cwd or os.getcwd(),
                limit=STDOUT_LIMIT,
                start_new_session=True,
            )
        except OSError as exc:
            yield finish(f"spawn: {exc}")
            return

        err_chunks: list[bytes] = []

        async def drain_stderr() -> None:
            assert proc.stderr is not None
            async for chunk in proc.stderr:
                err_chunks.append(chunk)

        stderr_task = asyncio.create_task(drain_stderr())
        timed_out = False
        stream_error: str | None = None
        try:
            async with asyncio.timeout(self.timeout_s):
                if data is not None:
                    assert proc.stdin is not None
                    try:
                        proc.stdin.write(data)
                        await proc.stdin.drain()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    proc.stdin.close()
                assert proc.stdout is not None
                try:
                    async for raw_line in proc.stdout:
                        line = raw_line.decode("utf-8", "replace").strip()
                        if not line:
                            continue
                        try:
                            d = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(d, dict):
                            for ev in mapper.feed(d, now_ms()):
                                yield ev
                except TimeoutError:
                    raise
                except Exception as exc:
                    stream_error = f"stream: {exc}"
                if proc.returncode is None:
                    await proc.wait()
        except TimeoutError:
            timed_out = True
        finally:
            stderr_task.cancel()
            await stop_group(proc)

        err = b"".join(err_chunks).decode("utf-8", "replace").strip()
        if timed_out:
            yield finish(f"timeout after {self.timeout_s}s")
        elif stream_error:
            yield finish(stream_error)
        elif mapper.error:
            yield finish(mapper.error)
        elif proc.returncode != 0:
            yield finish(f"exit {proc.returncode}: {err[-500:]}")
        elif not mapper.done:
            yield finish(f"{self.name} ended without finishing the turn: {err[-300:]}")
        else:
            yield finish(None)


class ClaudeCodeBackend(_CliBackend):
    name = "claude"
    default_bin = "claude"
    Mapper = ClaudeStream


class PiBackend(_CliBackend):
    name = "pi"
    default_bin = "pi"
    Mapper = PiStream


class CodexBackend(_CliBackend):
    name = "codex"
    default_bin = "codex"
    Mapper = CodexStream


BACKEND_CLASSES: dict[str, type[_CliBackend]] = {"claude": ClaudeCodeBackend, "pi": PiBackend, "codex": CodexBackend}


# ——— interactive resume (terminal pane) ———
def interactive_argv(kind: str, native_id: str | None, model: str | None, effort: str | None, *, new: bool = False, root: Path | str | None = None, fork: dict[str, Any] | None = None) -> list[str]:
    """The CLI's interactive command that continues ``native_id`` (or starts it when ``new``: the
    session never ran; or forks ``fork["from"]`` into a new native session). Callers check the log
    first (``check_native``); Pi has no resume-only flag, so for Pi that check is the only guard
    against a silent new session."""
    a = adapters.need(kind)
    if fork:
        return [*a.fork_argv(fork), *interactive_argv(kind, None, model, effort)[1:]]
    return a.interactive_argv(native_id, model, effort, new=new, has_log=lambda: locate_log(kind, native_id, root).path is not None, skill_dir=SKILL_DIR)


# Where each CLI looks for project skills: Claude Code .claude/skills, Codex .agents/skills.
# Pi gets `--skill <dir>` on every launch instead: it loads a project's .agents/skills only
# after the person trusts the project (print mode skips untrusted ones silently).
SKILL_DIRS = {k: a.project_skill_dir for k, a in adapters.ADAPTERS.items() if k in KINDS and a.project_skill_dir}


# ——— project skill install ———
def install_skill(root: Path, agents: list[str], copy: bool = False) -> list[dict[str, str]]:
    """Link (or copy) skills/agora-canvas into the project dirs the chosen CLIs read.

    Never touches user-global config. Links are listed in .git/info/exclude so they do not
    show up as untracked files."""
    import shutil

    done: list[dict[str, str]] = []
    for k in agents:  # a CLI without a project skills folder (Pi) gets `--skill <dir>` on every launch
        a = adapters.get(k)
        if a is not None and k in KINDS and a.project_skill_dir is None:
            done.append({"path": str(SKILL_DIR), "state": f"{k} loads it with --skill on every launch", "for": k})
    rels = sorted({SKILL_DIRS[x] for x in agents if x in SKILL_DIRS})
    for rel in rels:
        target = root / rel / "agora-canvas"
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() and target.resolve() == SKILL_DIR.resolve():
            state = "exists"
        elif target.exists() or target.is_symlink():
            if target.is_symlink() or copy:
                if target.is_symlink():
                    target.unlink()
                else:
                    shutil.rmtree(target)
                state = "replaced"
            else:
                done.append({"path": str(target), "state": "kept (not a link to this Agora; remove it to reinstall)"})
                continue
        else:
            state = "created"
        if not (target.exists() or target.is_symlink()):
            if copy:
                shutil.copytree(SKILL_DIR, target)
            else:
                target.symlink_to(SKILL_DIR)
        done.append({"path": str(target), "state": state, "for": ", ".join(k for k in agents if SKILL_DIRS.get(k) == rel)})
    exclude = root / ".git" / "info" / "exclude"
    if exclude.parent.is_dir():
        lines = exclude.read_text().splitlines() if exclude.exists() else []
        want = [f"/{rel}/agora-canvas" for rel in rels]
        missing = [w for w in want if w not in lines]
        if missing:
            exclude.write_text("\n".join([*lines, "# agora: skill links (agora skill install)", *missing]) + "\n")
    return done


# ——— model catalogs ———
_catalog_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


def catalog(root: Path | None = None, ttl_s: float = 600) -> dict[str, Any]:
    """Agents Agora can bind a session to, their models and each model's effort levels (cached).

    Every list is read from the CLI or its own model catalog (agent_models.py). ``root`` is the
    project: Pi's model scope can come from its ``.pi/settings.json``."""
    out = {}
    for kind in KINDS:
        key = (kind, str(root) if root is not None and adapters.need(kind).catalog_per_project else "")
        hit = _catalog_cache.get(key)
        if hit is None or time.time() - hit[0] > ttl_s:
            hit = (time.time(), adapters.need(kind).catalog(child_env(), root))
            _catalog_cache[key] = hit
        out[kind] = {
            "kind": kind,
            "name": NAMES[kind],
            "installed": adapters.need(kind).installed() is not None,
            **hit[1],
        }
    return out


def check_binding(kind: str, model: str, effort: str, root: Path | None = None) -> None:
    """Refuse a model outside what the agent may run (Pi: its enabledModels scope) or an effort
    level the chosen model does not take (ValueError → 400)."""
    if kind not in KINDS or not (model or effort):
        return
    entry = catalog(root)[kind]
    why = agent_models.model_refusal(entry, model)
    if why:
        raise ValueError(why)
    if not effort:
        return
    allowed = agent_models.efforts_for(entry, model)
    if allowed is None:  # a model the catalog does not list: the CLI's own vocabulary
        allowed = entry.get("efforts") or []
    if effort not in allowed:
        choices = "、".join(allowed) if allowed else "（这个模型没有强度选项）"
        raise ValueError(f"{NAMES[kind]} 的 {model or '默认模型'} 不支持强度 {effort}；可选：{choices}")


__all__ = [
    "BACKEND_CLASSES",
    "KILL_GRACE_S",
    "KINDS",
    "NAMES",
    "ClaudeCodeBackend",
    "CodexBackend",
    "LogLookup",
    "NativeMissing",
    "PiBackend",
    "catalog",
    "check_binding",
    "check_native",
    "child_env",
    "find_log",
    "interactive_argv",
    "locate_log",
    "migrate_pi_log",
    "new_native_since",
]
