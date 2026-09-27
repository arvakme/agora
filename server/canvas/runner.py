"""Backend-agnostic execution of the canvas agent's schema-constrained turns.

The seam is ``AgentBackend.run(RunRequest) -> AsyncIterator[event]``. A request says
*what* to run (JSON schema, system prompt, prompt, optional MCP tools) and *how*
(``ExecOptions``: backend, model, effort, session). Every backend emits the same
event stream, each event stamped with the server's epoch-ms ``at``:

- ``start``        {backend, model, session?}
- ``text``         {text}                       narration
- ``tool_use``     {id, name, input}            e.g. search_library
- ``tool_result``  {id, text}
- ``output``       {}                           the structured answer is being written
- ``usage``        {usage}                      per model message (partial, as reported)
- ``result``       {raw, error?, costUsd, durationMs, usage, session?, prompt}  always last

``usage`` is one shape for every backend (see ``Usage``): model name, input / output /
cache-read / cache-write tokens, wall time, cost. ``costUsd``/``durationMs`` stay on the
result for existing callers and mirror ``usage``.

Two kinds of request share the seam:

- schema-constrained planning (``schema`` set): ``ClaudeCliBackend`` (``claude-cli``,
  ``claude -p --json-schema`` in a neutral empty directory). The eval baseline.
- a native session turn (``schema`` None): the user's own coding agent in the project
  directory, resuming the session's native id — ``pi``, ``claude``, ``codex`` in
  ``server/canvas/agents.py``. ``result.raw`` is then the agent's final message text.

Every run validates the structured output against the caller's JSON Schema before the
result goes out — the backend's structural check; referential and freshness checks stay
in the browser (only it holds the current scene).
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, TypedDict

from server.canvas import schemas

DEFAULT_BACKEND = "claude-cli"
DEFAULT_MODEL = "claude-sonnet-5"
# Kept for callers that imported the old name.
MODEL = DEFAULT_MODEL
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# ``ExecOptions.session`` value that starts a persistent session (its id comes back
# on ``start``/``result``); ``None`` is a one-shot run that leaves nothing behind.
NEW_SESSION = "new"
TIMEOUT_S = 240
KILL_GRACE_S = 5
STDOUT_LIMIT = 8 * 1024 * 1024


@dataclass(frozen=True)
class ExecOptions:
    """How to run a turn. Backends map these onto their own knobs."""

    backend: str = DEFAULT_BACKEND
    model: str = DEFAULT_MODEL
    effort: str | None = None
    session: str | None = None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> ExecOptions:
        """``AGORA_CANVAS_{BACKEND,MODEL,EFFORT}`` override the defaults."""
        env = os.environ if env is None else env
        effort = env.get("AGORA_CANVAS_EFFORT") or None
        if effort is not None and effort not in EFFORTS:
            raise ValueError(f"AGORA_CANVAS_EFFORT must be one of {EFFORTS}, got {effort!r}")
        return cls(
            backend=env.get("AGORA_CANVAS_BACKEND") or DEFAULT_BACKEND,
            model=env.get("AGORA_CANVAS_MODEL") or DEFAULT_MODEL,
            effort=effort,
        )


@dataclass(frozen=True)
class RunRequest:
    """What to run: one prompt — schema-constrained (planning) or free (a session turn)."""

    schema: dict[str, Any] | None
    system: str | None
    prompt: str
    mcp_config: dict[str, Any] | None = None
    options: ExecOptions = field(default_factory=ExecOptions)
    # Session turns: where the agent runs (the project root) and extra environment.
    cwd: str | None = None
    env: dict[str, str] | None = None


class Usage(TypedDict):
    model: str | None
    inputTokens: int | None
    outputTokens: int | None
    cacheReadTokens: int | None
    cacheWriteTokens: int | None
    durationMs: int | None
    costUsd: float | None


def empty_usage(model: str | None = None) -> Usage:
    return {
        "model": model,
        "inputTokens": None,
        "outputTokens": None,
        "cacheReadTokens": None,
        "cacheWriteTokens": None,
        "durationMs": None,
        "costUsd": None,
    }


class AgentBackend(Protocol):
    """Runs one ``RunRequest``; yields the event stream above, ending in ``result``."""

    name: str

    def run(self, req: RunRequest) -> AsyncIterator[dict[str, Any]]: ...


def now_ms() -> int:
    return int(time.time() * 1000)


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def claude_message_usage(u: dict[str, Any] | None, model: str | None) -> Usage:
    """Anthropic ``message.usage`` (snake_case) → ``Usage``."""
    out = empty_usage(model)
    if isinstance(u, dict):
        out["inputTokens"] = _int(u.get("input_tokens"))
        out["outputTokens"] = _int(u.get("output_tokens"))
        out["cacheReadTokens"] = _int(u.get("cache_read_input_tokens"))
        out["cacheWriteTokens"] = _int(u.get("cache_creation_input_tokens"))
    return out


def claude_result_usage(final: dict[str, Any] | None, model: str | None, duration_ms: int) -> Usage:
    """The ``result`` line of stream-json → ``Usage`` (totals for the whole run)."""
    out = claude_message_usage((final or {}).get("usage"), model)
    out["durationMs"] = duration_ms
    if final:
        out["costUsd"] = _num(final.get("total_cost_usd"))
        by_model = final.get("modelUsage")
        if isinstance(by_model, dict) and by_model:
            # The model that did the work: the one with the most output tokens.
            out["model"] = max(by_model, key=lambda k: (by_model[k] or {}).get("outputTokens") or 0)
    return out


PLAN_SYSTEM = """You edit an Excalidraw diagram for a comment thread on a collaboration canvas.
Return ONLY typed operations matching the provided JSON schema. Never invent element ids: target ids from the scene.
Coordinates: pixels, x grows right, y grows down, (x, y) is the top-left corner of a node.
Scene format is Excalidraw's element skeleton: nodes {id,type,label,x,y,width,height,frameId?}, arrows {id,start:{id},end:{id},label?,bothEnds?}, frames {id,name,x,y,width,height,children}.
Operations:
- update_text {id,text}: replace a node's label, an arrow's label, or a frame's name.
- move {id,x,y}: set a node's (or frame's) top-left. Bound arrows re-route automatically; moving a frame moves its children.
- resize {id,width,height}: keep top-left.
- add_shape {ref,shape,text,x,y,width?,height?,frameId?}: ref is the new element's id (lowercase, [a-z0-9_-]) and can be used by later add_arrow ops in the same batch. Default size 160x64. frameId puts it inside a frame (the frame grows to fit).
- add_arrow {from,to,text?,bothEnds?,ref?}: straight arrow bound to two nodes (existing ids or refs).
- delete {id}: deleting a node does NOT delete its arrows; delete those arrows explicitly when they should go.
- insert_library_item {ref,item,near:{id,side:"right"|"left"|"above"|"below",gap?} | at:{x,y},label?,width?,frameId?}: place a ready-made component from the built-in asset library. item is an id returned by the search_library tool; ref becomes its id (use it in add_arrow). Components show up in the scene as type "library" nodes.
Asset library (tool search_library): about 6,000 ready-made components (cloud/vendor icons, tech logos, devices, people, UI mockups, UML, Lucide icons).
- Use it when the comment asks for something a picture says better than a box: a named product/technology (Redis, Kafka, AWS Lambda, Kubernetes), a device, a person, an icon, a UI mockup.
- Draw it yourself (add_shape) when the request is a plain box, a text note, a generic step or placeholder (e.g. "a box saying TODO"), or when search finds nothing fitting. Do not insert decorative components nobody asked for.
- Search with 1-3 English keywords; pick the candidate whose name matches best and whose size fits the diagram (prefer ~40-160px; pass width to scale). Never guess item ids.
- Do NOT pass label when the chosen candidate has hasText: true (it already shows its name, e.g. a "kafka" wordmark); add a label only if the user explicitly asks for one or it says something different.
- Leave clear space: place components with near.gap >= 40 and never on top of, or touching, other nodes or a frame's border (the executor also nudges it further along the side if it would be closer than 16px).
Rules: do the smallest set of operations that fulfils the comment; do not touch unrelated elements; keep nodes from overlapping (leave >= 40px gaps); keep existing sizes unless asked.
Optional "note": one short sentence in the comment's language. If the request is impossible, return {"ops": [], "note": "<why>"}."""

ANIM_SYSTEM = """You write algorithm-animation scripts for a collaborative canvas. You never produce frames:
only the initial nodes plus a list of steps; the player interpolates motion between steps.
Output ONLY an object matching the JSON schema.

Coordinates are pixels relative to the animation region's top-left; y grows down. Nodes default to 64x64.
Put array cells in a row: x = index*80, y = 0 (w = h = 64).
Pointers/markers (e.g. "lo", "hi", "mid", "i", "j"): w = 64, h = 32, short labels (≤ 4 chars), x aligned with the cell they point at;
give each marker its own row (y = 84, 124, 164, …) so markers never overlap each other.
Graphs: lay nodes out by level (dy = 120) and list edges; graph nodes normally don't move.
Every node the animation needs must exist in "nodes" from the start (use a label like "" or "队列:" and set_label later).

Each step is a list of primitives that run in parallel:
- swap {a,b}: two nodes exchange positions (animated along arcs).
- move {id,x,y}: move a node to (x,y).
- highlight {ids,color}: color ∈ compare | swap | done | focus | visited | muted.
- unhighlight {ids?}: clear colors of ids, or of every node when ids is omitted (always applied before same-step highlights, so "unhighlight all + highlight x" is the idiom for moving the focus).
- set_label {id,text}: change a node's text.
- caption {text}: the explanation shown in the player for this step (≤1 per step).
Within one step a node may be moved at most once, highlighted at most once, relabeled at most once.
Run the algorithm faithfully on the given input — the script must reflect the real sequence of comparisons/visits.
Give every step a caption in the user's language. Keep ≤ 80 steps; one step per meaningful event (a comparison, a swap, a visit).
Title: short, in the user's language, include the input."""


async def _stop(proc: asyncio.subprocess.Process) -> None:
    """Terminate a still-running child: SIGTERM, then SIGKILL after a short grace.

    Runs during task cancellation (ASGI disconnect), so awaits can raise
    ``CancelledError`` — catch ``BaseException`` so the SIGKILL escalation is
    never skipped; ``kill``/``terminate`` themselves are synchronous.
    """
    if proc.returncode is not None:
        return
    try:
        proc.terminate()
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(asyncio.shield(proc.wait()), KILL_GRACE_S)
        return
    except BaseException:
        pass
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), KILL_GRACE_S)
        except BaseException:
            pass


def build_prompt(ctx: dict[str, Any]) -> str:
    """The prompt the planner sees: thread or chat messages + the frozen scene."""
    anchors = ", ".join(f'{a["id"]} "{a["label"]}"' for a in ctx.get("anchors", []))
    if ctx.get("origin") == "chat":
        head = "Conversation with the user in the canvas room" + (
            f" (the user referenced: {anchors})" if anchors else ""
        )
        head += ". Act on the LAST user message; earlier turns are context and are already applied."
    else:
        head = f"Comment thread (anchored to: {anchors or 'canvas'}):"
    lines = [
        head,
        *(f"- {m['author']}: {m['text']}" for m in ctx.get("messages", [])),
        f"Current selection: {', '.join(ctx.get('selection') or []) or '(none)'}",
        "Scene:",
        json.dumps(ctx.get("scene"), ensure_ascii=False, separators=(",", ":")),
    ]
    return "\n".join(lines)


def library_mcp_config() -> dict[str, Any]:
    """The asset library as an MCP tool (search only) for the planning call."""
    from server.canvas.library_mcp import MODULE

    return {"mcpServers": {"library": {"command": MODULE[0], "args": list(MODULE[1:])}}}


def neutral_workdir() -> str:
    """An empty directory outside any repository for model subprocesses.

    ``claude -p`` folds its working directory into the model context (cwd, git status,
    recent commits, project memory paths). Run from the repo root, that context changed
    answers: the same T1 prompt was misread as "already named Redis" 6/20 times from
    the agora checkout vs 0/20 from an empty directory (2026-09-27). The planner must
    see only the prompt we build.
    """
    return tempfile.mkdtemp(prefix="agora-canvas-run-")


class ClaudeCliBackend:
    """``claude -p --output-format stream-json`` as a subprocess (one process per turn)."""

    name = "claude-cli"

    def __init__(
        self,
        cmd: list[str] | None = None,
        *,
        timeout_s: float = TIMEOUT_S,
        env: dict[str, str] | None = None,
        workdir: str | None = None,
    ) -> None:
        self.cmd = cmd or ["claude"]
        self.timeout_s = timeout_s
        self.env = env
        self._workdir = workdir

    @property
    def workdir(self) -> str:
        if self._workdir is None or not os.path.isdir(self._workdir):
            self._workdir = neutral_workdir()
        return self._workdir

    def args(self, req: RunRequest) -> list[str]:
        o = req.options
        args = [
            *self.cmd,
            "-p",
            "--model",
            o.model,
            "--output-format",
            "stream-json",
            "--verbose",
            "--json-schema",
            json.dumps(req.schema),
            "--system-prompt",
            req.system,
            "--tools",
            "",
        ]
        if o.effort:
            args += ["--effort", o.effort]
        if req.mcp_config:
            args += [
                "--mcp-config",
                json.dumps(req.mcp_config),
                "--allowedTools",
                "mcp__library__search_library",
            ]
        if o.session is None:
            args += ["--no-session-persistence"]
        elif o.session != NEW_SESSION:
            args += ["--resume", o.session]
        args += ["--setting-sources", "", "--strict-mcp-config"]
        return args

    async def run(self, req: RunRequest) -> AsyncIterator[dict[str, Any]]:
        o = req.options
        started = now_ms()
        session: str | None = o.session if o.session not in (None, NEW_SESSION) else None
        model: str | None = o.model
        yield {"t": "start", "at": started, "backend": self.name, "model": o.model, "session": session}

        def finish(raw: Any, final: dict[str, Any] | None, error: str | None = None) -> dict[str, Any]:
            at = now_ms()
            usage = claude_result_usage(final, model, at - started)
            out: dict[str, Any] = {
                "t": "result",
                "at": at,
                "raw": raw,
                "costUsd": usage["costUsd"],
                "durationMs": usage["durationMs"],
                "usage": usage,
                "backend": self.name,
                "session": session,
                "prompt": req.prompt,
            }
            if error:
                out["error"] = error
            return out

        env = {**os.environ, **(self.env or {})}
        try:
            proc = await asyncio.create_subprocess_exec(
                *self.args(req),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=self.workdir,
                # StreamReader's default 64 KiB line limit rejects long
                # stream-json lines (big assistant text, tool results).
                limit=STDOUT_LIMIT,
            )
        except OSError as exc:
            yield finish(None, None, f"spawn: {exc}")
            return

        err_chunks: list[bytes] = []
        final: dict[str, Any] | None = None
        stream_error: str | None = None
        timed_out = False

        async def drain_stderr() -> None:
            assert proc.stderr is not None
            async for chunk in proc.stderr:
                err_chunks.append(chunk)

        stderr_task = asyncio.create_task(drain_stderr())
        try:
            async with asyncio.timeout(self.timeout_s):
                assert proc.stdin is not None and proc.stdout is not None
                try:
                    proc.stdin.write(req.prompt.encode())
                    await proc.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                proc.stdin.close()

                try:
                    async for raw_line in proc.stdout:
                        line = raw_line.decode("utf-8", "replace").strip()
                        if not line:
                            continue
                        try:
                            d = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        at = now_ms()
                        dtype = d.get("type")
                        if dtype == "system" and d.get("subtype") == "init":
                            model = str(d.get("model") or model)
                            if o.session is not None and d.get("session_id"):
                                session = str(d["session_id"])
                        elif dtype == "assistant":
                            msg = d.get("message") or {}
                            for c in msg.get("content") or []:
                                if c.get("type") == "text" and str(c.get("text", "")).strip():
                                    yield {"t": "text", "at": at, "text": str(c["text"])}
                                elif c.get("type") == "tool_use" and c.get("name") == "StructuredOutput":
                                    yield {"t": "output", "at": at}
                                elif c.get("type") == "tool_use":
                                    yield {
                                        "t": "tool_use",
                                        "at": at,
                                        "id": str(c.get("id")),
                                        "name": str(c.get("name")),
                                        "input": c.get("input"),
                                    }
                            if isinstance(msg.get("usage"), dict):
                                yield {"t": "usage", "at": at, "usage": claude_message_usage(msg["usage"], str(msg.get("model") or model))}
                        elif dtype == "user":
                            for c in (d.get("message") or {}).get("content") or []:
                                if c.get("type") != "tool_result":
                                    continue
                                content = c.get("content")
                                if isinstance(content, list):
                                    text = "".join(str(x.get("text", "")) for x in content)
                                else:
                                    text = str(content or "")
                                if not text.startswith("Structured output provided"):
                                    yield {"t": "tool_result", "at": at, "id": str(c.get("tool_use_id")), "text": text}
                        elif dtype == "result":
                            final = d
                            if o.session is not None and d.get("session_id"):
                                session = str(d["session_id"])
                except TimeoutError:
                    raise
                except Exception as exc:
                    # Line-limit overruns, decode failures, broken pipes:
                    # surface as an explicit result error, never a silent end.
                    stream_error = f"stream: {exc}"
                if proc.returncode is None:
                    await proc.wait()
        except TimeoutError:
            timed_out = True
        finally:
            stderr_task.cancel()
            await _stop(proc)

        err = b"".join(err_chunks).decode("utf-8", "replace")
        if timed_out:
            yield finish(None, final, f"timeout after {self.timeout_s}s")
            return
        if stream_error:
            yield finish(None, final, stream_error)
            return
        if proc.returncode != 0:
            yield finish(final, final, f"exit {proc.returncode}: {err[:500]}")
            return
        if final is None:
            yield finish(None, None, f"exit {proc.returncode}: {err[:500]}")
            return
        if final.get("is_error") or "structured_output" not in final or final.get("structured_output") is None:
            detail = f"{final.get('subtype', 'error')} {str(final.get('result') or '')[:300]}".strip()
            yield finish(final.get("structured_output"), final, f"claude: {detail}")
            return
        raw = final["structured_output"]
        schema_errors = schemas.validate(req.schema, raw)
        if schema_errors:
            yield finish(raw, final, f"schema: {'; '.join(schema_errors[:5])}")
            return
        yield finish(raw, final)


# Backend registry: ExecOptions.backend → factory. The native session agents (pi, claude,
# codex) live in agents.py and are registered on first use.
BACKENDS: dict[str, Callable[[], AgentBackend]] = {
    ClaudeCliBackend.name: ClaudeCliBackend,
}


def _register_agents() -> None:
    from server.canvas.agents import BACKEND_CLASSES

    for name, cls in BACKEND_CLASSES.items():
        BACKENDS.setdefault(name, cls)


def make_backend(name: str = DEFAULT_BACKEND) -> AgentBackend:
    _register_agents()
    try:
        return BACKENDS[name]()
    except KeyError:
        raise ValueError(f"unknown canvas backend {name!r}; known: {sorted(BACKENDS)}") from None
