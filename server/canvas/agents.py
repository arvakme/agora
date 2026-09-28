"""The three native coding agents a session can be bound to: Pi, Claude Code, Codex.

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
import glob
import json
import os
import shutil
import signal
import subprocess
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from server.canvas import agent_models
from server.canvas.runner import (
    KILL_GRACE_S,
    STDOUT_LIMIT,
    RunRequest,
    Usage,
    _int,
    _num,
    claude_message_usage,
    claude_result_usage,
    empty_usage,
    now_ms,
)

REPO = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO / "skills" / "agora-canvas"
AGENT_BIN = REPO / "bin"

KINDS = ("pi", "claude", "codex")
NAMES = {"pi": "Pi", "claude": "Claude Code", "codex": "Codex"}
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


def text_of(content: Any) -> str:
    """Plain text of a message ``content`` (string, or blocks with ``text``)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text", "Text"))


# ——— usage mapping ———
def pi_usage(u: dict[str, Any] | None, model: str | None) -> Usage:
    out = empty_usage(model)
    if isinstance(u, dict):
        out["inputTokens"] = _int(u.get("input"))
        out["outputTokens"] = _int(u.get("output"))
        out["cacheReadTokens"] = _int(u.get("cacheRead"))
        out["cacheWriteTokens"] = _int(u.get("cacheWrite"))
        cost = u.get("cost")
        out["costUsd"] = _num(cost.get("total")) if isinstance(cost, dict) else None
    return out


def codex_usage(u: dict[str, Any] | None, model: str | None) -> Usage:
    out = empty_usage(model)
    if isinstance(u, dict):
        cached = _int(u.get("cached_input_tokens"))
        inp = _int(u.get("input_tokens"))
        # Codex counts cached tokens inside input_tokens; report the uncached part like the others.
        out["inputTokens"] = inp - cached if inp is not None and cached is not None else inp
        out["outputTokens"] = _int(u.get("output_tokens"))
        out["cacheReadTokens"] = cached
        out["cacheWriteTokens"] = _int(u.get("cache_write_input_tokens"))
    return out


def add_usage(total: Usage, part: Usage) -> Usage:
    out = dict(total)
    for k in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"):
        if part[k] is not None:
            out[k] = (out[k] or 0) + part[k]
    if part["costUsd"] is not None:
        out["costUsd"] = (out["costUsd"] or 0.0) + part["costUsd"]
    out["model"] = part["model"] or out["model"]
    return out  # type: ignore[return-value]


# ——— stream mappers: one CLI's stdout JSONL → runner events ———
class StreamMapper:
    """Stateful: ``feed`` one decoded stdout record, get events; ``final`` sums it up."""

    def __init__(self, model: str | None, session: str | None) -> None:
        self.model = model
        self.session = session
        self.text: str = ""  # last assistant message text
        self.error: str | None = None
        self.usage: Usage = empty_usage(model)
        self.done = False

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:  # pragma: no cover - interface
        raise NotImplementedError

    def final_usage(self, duration_ms: int) -> Usage:
        u = dict(self.usage)
        u["durationMs"] = duration_ms
        u["model"] = u["model"] or self.model
        return u  # type: ignore[return-value]


class ClaudeStream(StreamMapper):
    """``claude -p --output-format stream-json --verbose``."""

    def __init__(self, model: str | None, session: str | None) -> None:
        super().__init__(model, session)
        self.result: dict[str, Any] | None = None

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        t = d.get("type")
        if t == "system" and d.get("subtype") == "init":
            self.model = str(d.get("model") or self.model or "") or None
            self.session = str(d.get("session_id") or self.session or "") or None
        elif t == "assistant":
            msg = d.get("message") or {}
            texts = []
            for c in msg.get("content") or []:
                if c.get("type") == "text" and str(c.get("text", "")).strip():
                    texts.append(str(c["text"]))
                    out.append({"t": "text", "at": at, "text": str(c["text"])})
                elif c.get("type") == "tool_use":
                    out.append({"t": "tool_use", "at": at, "id": str(c.get("id")), "name": str(c.get("name")), "input": c.get("input")})
            if texts:
                self.text = "".join(texts)
            if isinstance(msg.get("usage"), dict):
                out.append({"t": "usage", "at": at, "usage": claude_message_usage(msg["usage"], str(msg.get("model") or self.model))})
        elif t == "user":
            for c in (d.get("message") or {}).get("content") or []:
                if isinstance(c, dict) and c.get("type") == "tool_result":
                    out.append({"t": "tool_result", "at": at, "id": str(c.get("tool_use_id")), "text": text_of(c.get("content")) or str(c.get("content") or ""), "isError": bool(c.get("is_error"))})
        elif t == "result":
            self.result = d
            self.done = True
            self.session = str(d.get("session_id") or self.session or "") or None
            if d.get("is_error"):
                self.error = f"claude: {d.get('subtype', 'error')} {str(d.get('result') or '')[:300]}".strip()
            elif isinstance(d.get("result"), str) and d["result"].strip():
                self.text = d["result"]
        return out

    def final_usage(self, duration_ms: int) -> Usage:
        if self.result is None:
            return super().final_usage(duration_ms)
        return claude_result_usage(self.result, self.model, duration_ms)


class PiStream(StreamMapper):
    """``pi -p --mode json`` (docs/json.md in the Pi package)."""

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        t = d.get("type")
        if t == "session":
            self.session = str(d.get("id") or self.session or "") or None
        elif t == "message_end":
            m = d.get("message") or {}
            if m.get("role") != "assistant":
                return out
            model = f"{m['provider']}/{m['model']}" if m.get("provider") and m.get("model") else self.model
            self.model = model
            text = ""
            for c in m.get("content") or []:
                if c.get("type") == "text" and str(c.get("text", "")).strip():
                    text += str(c["text"])
                    out.append({"t": "text", "at": at, "text": str(c["text"])})
                elif c.get("type") == "toolCall":
                    out.append({"t": "tool_use", "at": at, "id": str(c.get("id")), "name": str(c.get("name")), "input": c.get("arguments")})
            if text:
                self.text = text
            if isinstance(m.get("usage"), dict):
                u = pi_usage(m["usage"], model)
                self.usage = add_usage(self.usage, u)
                out.append({"t": "usage", "at": at, "usage": u})
            if m.get("stopReason") in ("error", "aborted"):
                self.error = f"pi: {m.get('stopReason')} {str(m.get('errorMessage') or '')[:300]}".strip()
            elif m.get("stopReason") == "stop":
                self.error = None  # a retried turn that ends well clears an earlier failure
        elif t == "tool_execution_end":
            res = d.get("result") or {}
            out.append({"t": "tool_result", "at": at, "id": str(d.get("toolCallId")), "text": text_of(res.get("content")), "isError": bool(d.get("isError"))})
        elif t == "agent_settled":
            self.done = True
        elif t == "auto_retry_end" and d.get("success") is False:
            self.error = f"pi: {d.get('finalError') or 'retries exhausted'}"
        return out


class CodexStream(StreamMapper):
    """``codex exec --json``: thread.started / item.* / turn.completed."""

    def feed(self, d: dict[str, Any], at: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        t = d.get("type")
        if t == "thread.started":
            self.session = str(d.get("thread_id") or self.session or "") or None
        elif t in ("item.started", "item.completed"):
            item = d.get("item") or {}
            kind = item.get("type")
            iid = str(item.get("id"))
            if kind == "agent_message" and t == "item.completed":
                text = str(item.get("text") or "")
                if text.strip():
                    self.text = text
                    out.append({"t": "text", "at": at, "text": text})
            elif kind == "command_execution":
                if t == "item.started":
                    out.append({"t": "tool_use", "at": at, "id": iid, "name": "shell", "input": {"command": item.get("command")}})
                else:
                    code = item.get("exit_code")
                    out.append({"t": "tool_result", "at": at, "id": iid, "text": str(item.get("aggregated_output") or ""), "isError": code not in (0, None)})
            elif kind in ("mcp_tool_call", "file_change", "web_search") and t == "item.completed":
                name = str(item.get("tool") or kind)
                out.append({"t": "tool_use", "at": at, "id": iid, "name": name, "input": item.get("arguments") or item.get("changes") or item.get("query")})
                out.append({"t": "tool_result", "at": at, "id": iid, "text": str(item.get("status") or ""), "isError": item.get("status") == "failed"})
        elif t == "turn.completed":
            u = codex_usage(d.get("usage"), self.model)
            self.usage = add_usage(self.usage, u)
            out.append({"t": "usage", "at": at, "usage": u})
            self.done = True
        elif t == "turn.failed":
            self.error = f"codex: {((d.get('error') or {}).get('message') or 'turn failed')[:300]}"
            self.done = True
        elif t == "error":
            self.error = f"codex: {str(d.get('message') or 'error')[:300]}"
        return out


# ——— session logs (the CLIs' own transcripts) ———
# Where each CLI keeps a session's log, and which copy is the one it will resume:
# - Claude Code: ~/.claude/projects/<cwd, every non-alphanumeric → "-">/<id>.jsonl. `--resume <id>`
#   finds the id in any project directory but prefers the current directory's copy.
# - Pi: ~/.pi/agent/sessions/--<cwd without the leading "/", "/" "\" ":" → "-">--/<time>_<id>.jsonl.
#   `--session-id <id>` only looks in the current directory's folder and silently starts a new,
#   empty session with that id when it is not there.
# - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, independent of the cwd.
# A copy outside the current root is still followed when it is the only one (Claude resumes it
# globally); several copies are reported instead of picking one.
@dataclass(frozen=True)
class LogLookup:
    """Where a native session's log is: ``found`` (``path`` is the one to follow), ``missing``,
    ``ambiguous`` (several copies, none clearly the current one) or ``elsewhere`` (Pi: only in
    another directory's folder, so ``--session-id`` would start a new session)."""

    state: str
    path: Path | None = None
    candidates: tuple[Path, ...] = ()


def claude_dir_name(root: Path | str) -> str:
    return "".join(c if c.isalnum() and c.isascii() else "-" for c in str(root))


def pi_dir_name(root: Path | str) -> str:
    s = str(root)
    s = s[1:] if s[:1] in ("/", "\\") else s
    return "--" + "".join("-" if c in "/\\:" else c for c in s) + "--"


def _pi_sessions(home: Path) -> Path:
    return Path(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or home / ".pi" / "agent" / "sessions")


def locate_log(kind: str, native_id: str | None, root: Path | str | None = None, home: Path | None = None) -> LogLookup:
    """Find a native session's log, preferring the copy that belongs to ``root`` (the project)."""
    if not native_id:
        return LogLookup("missing")
    home = home or Path.home()
    if kind == "claude":
        hits = sorted(Path(p) for p in glob.glob(str(home / ".claude" / "projects" / "*" / f"{glob.escape(native_id)}.jsonl")))
        mine = [p for p in hits if root is not None and p.parent.name == claude_dir_name(root)]
        if mine:
            return LogLookup("found", mine[0], tuple(hits))
        if len(hits) == 1:
            return LogLookup("found", hits[0], tuple(hits))
        return LogLookup("ambiguous" if hits else "missing", None, tuple(hits))
    if kind == "pi":
        hits = sorted(Path(p) for p in glob.glob(str(_pi_sessions(home) / "*" / f"*_{glob.escape(native_id)}.jsonl")))
        if root is None:  # no project to prefer: only an unambiguous copy counts
            return LogLookup("found", hits[0], tuple(hits)) if len(hits) == 1 else LogLookup("ambiguous" if hits else "missing", None, tuple(hits))
        mine = [p for p in hits if p.parent.name == pi_dir_name(root)]
        if len(mine) == 1:
            return LogLookup("found", mine[0], tuple(hits))
        if mine:
            return LogLookup("ambiguous", None, tuple(hits))
        return LogLookup("elsewhere" if hits else "missing", None, tuple(hits))
    if kind == "codex":
        base = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions"
        hits = sorted(Path(p) for p in glob.glob(str(base / "*" / "*" / "*" / f"rollout-*-{glob.escape(native_id)}.jsonl")))
        return LogLookup("found", hits[-1], tuple(hits)) if hits else LogLookup("missing")
    raise ValueError(f"unknown agent {kind!r}")


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
        why = "可能被 Claude Code 的 30 天自动清理删掉了，或者这个项目是从别的机器拿来的。" if kind == "claude" else "日志可能被删除或移走了，或者这个项目是从别的机器拿来的。"
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


def codex_rollouts_since(cwd: Path, since: float, home: Path | None = None) -> list[tuple[str, Path]]:
    """Interactive Codex rollouts for ``cwd`` created at/after ``since`` → [(thread id, path)], oldest first."""
    home = home or Path.home()
    root = Path(os.environ.get("CODEX_HOME") or home / ".codex") / "sessions"
    out = []
    for p in glob.glob(str(root / "*" / "*" / "*" / "rollout-*.jsonl")):
        try:
            if os.path.getmtime(p) < since - 2:
                continue
            with open(p, "rb") as fh:
                meta = json.loads(fh.readline() or b"{}")
        except (OSError, json.JSONDecodeError):
            continue
        pl = meta.get("payload") or {}
        if meta.get("type") != "session_meta" or not pl.get("id"):
            continue
        if Path(str(pl.get("cwd") or "")).resolve() != cwd.resolve():
            continue
        out.append((os.path.getctime(p), str(pl["id"]), Path(p)))
    return [(i, p) for _, i, p in sorted(out)]


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

    def args(self, req: RunRequest) -> list[str]:  # pragma: no cover - interface
        raise NotImplementedError

    def stdin(self, req: RunRequest) -> bytes | None:
        return req.prompt.encode()

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

    def args(self, req: RunRequest) -> list[str]:
        o = req.options
        args = [*self.cmd, "-p", "--output-format", "stream-json", "--verbose"]
        if o.session:
            # Only a session that never ran is created with --session-id; any other is resumed,
            # and a missing log then fails loudly in the CLI ("No conversation found") instead of
            # starting a new, empty conversation under the same id.
            exists = claude_log(o.session, root=req.cwd) is not None
            args += ["--session-id", o.session] if o.new_session and not exists else ["--resume", o.session]
        if o.model:
            args += ["--model", o.model]
        if o.effort:
            args += ["--effort", o.effort]
        # The canvas skill runs `agora canvas …` through Bash; allow exactly that.
        args += ["--allowedTools", "Bash(agora canvas *)", "Bash(agora canvas:*)"]
        return args


class PiBackend(_CliBackend):
    name = "pi"
    default_bin = "pi"
    Mapper = PiStream

    def args(self, req: RunRequest) -> list[str]:
        o = req.options
        args = [*self.cmd, "-p", "--mode", "json"]
        if o.session:
            args += ["--session-id", o.session]
        if o.model:
            args += ["--model", o.model]
        if o.effort:
            args += ["--thinking", o.effort]
        if SKILL_DIR.is_dir():
            args += ["--skill", str(SKILL_DIR)]
        return [*args, "--", req.prompt]

    def stdin(self, req: RunRequest) -> bytes | None:
        return None  # the prompt is the last argument


class CodexBackend(_CliBackend):
    name = "codex"
    default_bin = "codex"
    Mapper = CodexStream

    def args(self, req: RunRequest) -> list[str]:
        o = req.options
        args = [*self.cmd, "exec"]
        if o.session:
            args += ["resume", o.session]
        args += ["--json", "--skip-git-repo-check"]
        if o.model:
            args += ["-m", o.model]
        if o.effort:
            args += ["-c", f"model_reasoning_effort={json.dumps(o.effort)}"]
        return [*args, "-"]


BACKEND_CLASSES: dict[str, type[_CliBackend]] = {"claude": ClaudeCodeBackend, "pi": PiBackend, "codex": CodexBackend}


# ——— interactive resume (terminal pane) ———
def interactive_argv(kind: str, native_id: str | None, model: str | None, effort: str | None, *, new: bool = False, root: Path | str | None = None) -> list[str]:
    """The CLI's interactive command that continues ``native_id`` (or starts it when ``new``: the
    session never ran). Callers check the log first (``check_native``); Pi has no resume-only
    flag, so for Pi that check is the only guard against a silent new session."""
    if kind == "claude":
        args = ["claude"]
        if native_id:
            args += ["--session-id", native_id] if new and not claude_log(native_id, root=root) else ["--resume", native_id]
        if model:
            args += ["--model", model]
        if effort:
            args += ["--effort", effort]
        return args
    if kind == "pi":
        args = ["pi"]
        if native_id:
            args += ["--session-id", native_id]
        if model:
            # --models pins Ctrl+P cycling to the session's model.
            args += ["--model", model, "--models", model]
        if effort:
            args += ["--thinking", effort]
        if SKILL_DIR.is_dir():
            args += ["--skill", str(SKILL_DIR)]
        return args
    if kind == "codex":
        args = ["codex", "resume", native_id] if native_id else ["codex"]
        if model:
            args += ["-m", model]
        if effort:
            args += ["-c", f"model_reasoning_effort={json.dumps(effort)}"]
        return args
    raise ValueError(f"unknown agent {kind!r}")


# Where each CLI looks for project skills: Claude Code .claude/skills, Codex .agents/skills.
# Pi gets `--skill <dir>` on every launch instead: it loads a project's .agents/skills only
# after the person trusts the project (print mode skips untrusted ones silently).
SKILL_DIRS = {"claude": ".claude/skills", "codex": ".agents/skills"}


# ——— project skill install ———
def install_skill(root: Path, agents: list[str], copy: bool = False) -> list[dict[str, str]]:
    """Link (or copy) skills/agora-canvas into the project dirs the chosen CLIs read.

    Never touches user-global config. Links are listed in .git/info/exclude so they do not
    show up as untracked files."""
    import shutil

    done: list[dict[str, str]] = []
    if "pi" in agents:
        done.append({"path": str(SKILL_DIR), "state": "pi loads it with --skill on every launch", "for": "pi"})
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
_catalog_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def catalog(ttl_s: float = 600) -> dict[str, Any]:
    """Agents Agora can bind a session to, their models and each model's effort levels (cached).

    Every list is read from the CLI or its own model catalog (agent_models.py)."""
    out = {}
    for kind in KINDS:
        hit = _catalog_cache.get(kind)
        if hit is None or time.time() - hit[0] > ttl_s:
            hit = (time.time(), agent_models.SOURCES[kind](child_env()))
            _catalog_cache[kind] = hit
        out[kind] = {
            "kind": kind,
            "name": NAMES[kind],
            "installed": shutil.which({"pi": "pi", "claude": "claude", "codex": "codex"}[kind]) is not None,
            **hit[1],
        }
    return out


def check_effort(kind: str, model: str, effort: str) -> None:
    """Refuse an effort level the chosen model does not take (ValueError → 400)."""
    if not effort or kind not in KINDS:
        return
    entry = catalog()[kind]
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
    "check_effort",
    "check_native",
    "child_env",
    "find_log",
    "interactive_argv",
    "locate_log",
]
