"""Codex and Pi that can take words while a turn runs (ST2): one long-lived process per session instead of one per turn.

- Codex: ``codex app-server`` (JSON-RPC lines on stdio). A turn is ``turn/start``, words during it are ``turn/steer``, the stop is
  ``turn/interrupt``, the end is ``turn/completed``; the session is a thread (``thread/start``, ``thread/resume`` for a new process).
- Pi: ``pi --mode rpc``. A turn is a ``prompt`` command, words during it are ``steer``, the stop is ``abort``, the end is
  ``agent_settled``. Its events are the ones ``pi -p --mode json`` prints, so ``PiStream`` maps them.

The CLI keeps writing its own native log, which Agora follows as before; nothing here is a second record. What the host sends a
running turn is the two-way protocol's lines (``Control``: a user message, an interrupt request), translated here.

Life of a process (``ResidentPool``): started by a session's first turn, kept for the next ones, let go after ``idle_s`` without
one (the next turn starts a new process that resumes the thread from the log: nothing is sent again), at most ``max_procs`` at once
(the longest idle one makes room), stopped with everything it started through ``proctree`` when the turn is stopped hard, the
process dies, or the server closes. A marker file per process (``<pid>.json``) lets the next server stop what a dead one left.

When the resident way cannot start (an old CLI without the mode, no binary, no answer), the turn runs the old one-shot way
(``codex exec --json`` / ``pi -p --mode json``) and says why in a ``resident`` event (the session header shows it); a failure
of that kind is remembered for ``retry_s`` so every turn does not pay for a try. ``AGORA_RESIDENT=0`` switches the resident way off."""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import deque
from pathlib import Path
from typing import Any, AsyncIterator

from server.canvas import agents, proctree
from server.canvas.adapters.codex import CodexAppStream, CodexStream
from server.canvas.adapters.pi import PiStream
from server.canvas.runner import STDOUT_LIMIT, RunRequest, now_ms
from server.canvas.turn_clock import TurnClock

IDLE_S = float(os.environ.get("AGORA_RESIDENT_IDLE_S") or 600)
MAX_PROCS = int(os.environ.get("AGORA_RESIDENT_MAX") or 8)
SWEEP_S = 15.0
RETRY_S = 300.0
BOOT_TIMEOUT_S = 30.0
UI_ASKS = ("select", "confirm", "input", "editor")  # Pi extension questions that wait for an answer


class Unavailable(Exception):
    """The resident way cannot be used for this turn: ``why`` is what the header says; ``sticky``: the CLI (not this thread) is the problem."""

    def __init__(self, why: str, sticky: bool = True) -> None:
        super().__init__(why)
        self.why, self.sticky = why, sticky


class Died(Exception):
    """The process ended before the turn did."""


class Proc:
    """One resident CLI process: JSON lines both ways. Every decoded stdout object goes into ``inbox``; ``None`` marks its end."""

    def __init__(self, pool: "ResidentPool", key: str, argv: list[str], env: dict[str, str], cwd: str, spec: Any) -> None:
        self.pool, self.key, self.argv, self.env, self.cwd, self.spec = pool, key, argv, env, cwd, spec
        self.inbox: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self.thread: str | None = None  # the native session this process holds
        self.total: dict[str, Any] | None = None  # Codex: the thread's token total so far
        self.busy = False
        self.last_used = time.monotonic()
        self.proc: asyncio.subprocess.Process | None = None
        self.watch: proctree.Watch | None = None
        self.clock: TurnClock | None = None  # the running turn's: every line the process prints is activity
        self._err: deque[bytes] = deque(maxlen=40)
        self._tasks: list[asyncio.Task] = []
        self._n = 0
        self._eof = False
        self._stopped = False

    # ——— life ———
    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            *self.argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=self.env, cwd=self.cwd, limit=STDOUT_LIMIT, start_new_session=True,
        )
        self.watch = proctree.Watch(self.proc.pid)
        self._tasks = [asyncio.create_task(self._read()), asyncio.create_task(self._drain_err())]
        self.pool.register(self)

    @property
    def pid(self) -> int:
        assert self.proc is not None
        return self.proc.pid

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None and not self._eof and not self._stopped

    async def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        try:
            async for raw in self.proc.stdout:
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                if self.clock is not None:
                    self.clock.touch()
                if isinstance(d, dict):
                    self.inbox.put_nowait(d)
        except Exception:  # a line past the limit, a closed pipe: the same as the end
            pass
        finally:
            self._eof = True
            self.inbox.put_nowait(None)

    async def _drain_err(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        try:
            async for chunk in self.proc.stderr:
                self._err.append(chunk)
                if self.clock is not None:
                    self.clock.touch()
        except Exception:
            pass

    def stderr_tail(self, n: int = 400) -> str:
        return b"".join(self._err).decode("utf-8", "replace").strip()[-n:]

    async def stop(self) -> None:
        """End the process and everything it started (``proctree``), whatever state it is in."""
        if self._stopped:
            return
        self._stopped = True
        self.pool.forget(self)
        for t in self._tasks:
            t.cancel()
        proc = self.proc
        if proc is not None:
            # the tree first, while the CLI is there to find it by (an ended stdin lets a CLI exit before its children are seen)
            await agents.stop_group(proc, self.watch)
            try:
                if proc.stdin is not None and not proc.stdin.is_closing():
                    proc.stdin.close()
            except Exception:
                pass

    # ——— lines ———
    def write(self, obj: dict[str, Any]) -> None:
        assert self.proc is not None and self.proc.stdin is not None
        try:
            self.proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
        except (OSError, RuntimeError):  # the process is gone: the reader says so
            pass

    def next_id(self) -> int:
        self._n += 1
        return self._n

    async def get(self, timeout: float | None = None) -> dict[str, Any] | None:
        m = await asyncio.wait_for(self.inbox.get(), timeout)
        if m is None:
            self.inbox.put_nowait(None)
        return m

    def drain(self) -> None:
        """What arrived between turns is not part of the next one (a request in it is declined so nothing waits)."""
        keep_eof = False
        while not self.inbox.empty():
            m = self.inbox.get_nowait()
            if m is None:
                keep_eof = True
            elif m.get("method") and m.get("id") is not None:
                self.write({"id": m["id"], "error": {"code": -32601, "message": "Agora does not answer this request"}})
        if keep_eof:
            self.inbox.put_nowait(None)


class ResidentPool:
    """The resident processes of one project's sessions (one per session), their idle time and their markers."""

    def __init__(self, dir: Path, *, idle_s: float = IDLE_S, max_procs: int = MAX_PROCS, sweep_s: float = SWEEP_S) -> None:
        self.dir = Path(dir)
        self.idle_s, self.max_procs, self.sweep_s = idle_s, max_procs, sweep_s
        self.procs: dict[str, Proc] = {}
        self._sweeper: asyncio.Task | None = None
        self._locks: dict[str, asyncio.Lock] = {}

    # ——— markers: what a dead server left ———
    def register(self, p: Proc) -> None:
        self.procs[p.key] = p
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            (self.dir / f"{p.pid}.json").write_text(json.dumps({"pid": p.pid, "argv": p.argv, "server": os.getpid(), "key": p.key, "at": now_ms()}))
        except OSError:
            pass

    def forget(self, p: Proc) -> None:
        if self.procs.get(p.key) is p:
            del self.procs[p.key]
        if p.proc is not None:
            try:
                (self.dir / f"{p.proc.pid}.json").unlink(missing_ok=True)
            except OSError:
                pass

    def leftovers(self) -> list[dict[str, Any]]:
        """Processes a server that is gone left running: their markers (removed as they are returned). The caller stops them."""
        out: list[dict[str, Any]] = []
        try:
            files = sorted(self.dir.glob("*.json"))
        except OSError:
            return out
        for f in files:
            try:
                m = json.loads(f.read_text())
                server = int(m.get("server"))
            except (OSError, ValueError, TypeError):
                f.unlink(missing_ok=True)
                continue
            if server == os.getpid() or _pid_alive(server):
                continue  # its server is running (this one, or another on the same project)
            f.unlink(missing_ok=True)
            out.append(m)
        return out

    # ——— getting a process ———
    async def acquire(self, key: str, spec: Any, thread: str | None, boot) -> tuple[Proc, bool]:
        """The idle process of ``key`` when it is alive, started the same way and holds ``thread``; else a new one (``boot`` starts and
        readies it). The second value: the process is new."""
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            p = self.procs.get(key)
            if p is not None and p.alive and not p.busy and p.spec == spec and p.thread == thread and thread is not None:
                p.busy = True
                p.drain()
                return p, False
            if p is not None:
                await p.stop()
            await self._make_room(key)
            self._sweep_soon()
            p = await boot()
            p.busy = True
            return p, True

    def release(self, p: Proc) -> None:
        p.busy = False
        p.last_used = time.monotonic()

    async def _make_room(self, key: str) -> None:
        while len(self.procs) >= self.max_procs:
            idle = [q for q in self.procs.values() if not q.busy and q.key != key]
            if not idle:
                return
            await min(idle, key=lambda q: q.last_used).stop()

    # ——— idle ———
    def _sweep_soon(self) -> None:
        if self._sweeper is None or self._sweeper.done():
            self._sweeper = asyncio.get_running_loop().create_task(self._sweep())

    async def _sweep(self) -> None:
        while True:
            await asyncio.sleep(self.sweep_s)
            now = time.monotonic()
            for p in list(self.procs.values()):
                if not p.busy and (not p.alive or now - p.last_used > self.idle_s):
                    await p.stop()

    async def close_all(self) -> None:
        """Every process ended, with what it started (``agora down``, the server closing)."""
        if self._sweeper is not None:
            self._sweeper.cancel()
        await asyncio.gather(*(p.stop() for p in list(self.procs.values())), return_exceptions=True)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class _Turn:
    """What the words and the stop written during a turn need to know about it."""

    def __init__(self) -> None:
        self.turn_id: str | None = None
        self.ready = asyncio.Event()
        self.interrupting = False


class ResidentBackend(agents._CliBackend):
    """A session's turns in one long-lived process; the one-shot way (``_CliBackend.run``) when it cannot be used."""

    retry_s = RETRY_S
    pool: ResidentPool | None = None
    ResidentMapper: type = agents.StreamMapper  # reads the resident process's lines; ``Mapper`` reads the one-shot way's

    def __init__(self, *a: Any, **kw: Any) -> None:
        super().__init__(*a, **kw)
        self._unavailable: tuple[str, float] | None = None

    def attach_pool(self, pool: ResidentPool) -> None:
        self.pool = pool

    # what a kind supplies
    def resident_argv(self, req: RunRequest) -> list[str]:
        raise NotImplementedError

    async def boot(self, proc: Proc, req: RunRequest) -> None:
        """Ready ``proc`` for ``req``'s session (raise ``Unavailable``)."""
        raise NotImplementedError

    def turn(self, proc: Proc, req: RunRequest, mapper: Any, st: _Turn) -> AsyncIterator[dict[str, Any]]:
        raise NotImplementedError

    def quiet(self, req: RunRequest) -> bool:
        """Turns that never take the resident way, without a word: no pool, switched off, planning, no session, pictures, a fork."""
        return (
            self.pool is None or os.environ.get("AGORA_RESIDENT") == "0" or req.schema is not None or not (req.env or {}).get("AGORA_SESSION")
            or bool(req.images) or bool(req.options.fork_from)
        )

    async def run(self, req: RunRequest) -> AsyncIterator[dict[str, Any]]:
        if self.quiet(req):
            async for ev in super().run(req):
                yield ev
            return
        assert self.pool is not None
        key = (req.env or {})["AGORA_SESSION"]
        if self._unavailable and time.monotonic() < self._unavailable[1]:
            yield {"t": "resident", "ok": False, "why": self._unavailable[0], "at": now_ms()}
            async for ev in super().run(req):
                yield ev
            return
        argv = self.resident_argv(req)
        env = agents.child_env({**(req.env or {}), **(self.env or {})})
        spec = (tuple(argv), tuple(sorted(env.items())))

        async def boot() -> Proc:
            p = Proc(self.pool, key, argv, env, req.cwd or os.getcwd(), spec)  # type: ignore[arg-type]
            try:
                await p.start()
            except OSError as exc:
                raise Unavailable(f"起不来：{exc}") from exc
            try:
                async with asyncio.timeout(BOOT_TIMEOUT_S):
                    await self.boot(p, req)
            except BaseException as exc:
                await asyncio.shield(p.stop())
                if isinstance(exc, (Unavailable, asyncio.CancelledError)):
                    raise
                if isinstance(exc, (TimeoutError, Died)):
                    raise Unavailable(f"{'没有回应' if isinstance(exc, TimeoutError) else '起来就退出了'}：{p.stderr_tail() or exc}") from exc
                raise
            return p

        try:
            proc, fresh = await self.pool.acquire(key, spec, req.options.session, boot)
        except Unavailable as exc:
            if exc.sticky:
                self._unavailable = (exc.why, time.monotonic() + self.retry_s)
            yield {"t": "resident", "ok": False, "why": exc.why, "at": now_ms()}
            async for ev in super().run(req):
                yield ev
            return
        self._unavailable = None
        started = now_ms()
        mapper = self.ResidentMapper(req.options.model or None, proc.thread)
        yield {"t": "resident", "ok": True, "at": started}
        yield {"t": "start", "at": started, "backend": self.name, "model": req.options.model or None, "session": req.options.session}
        if fresh and req.options.session is None and proc.thread:
            yield {"t": "session", "at": now_ms(), "session": proc.thread}
        yield {"t": "spawned", "at": now_ms(), "pid": proc.pid, "argv": [*proc.argv]}
        st = _Turn()
        clock = proc.clock = TurnClock(self.idle_s, self.max_s)
        watcher = asyncio.create_task(proc.watch.run()) if proc.watch else None
        pump = asyncio.create_task(self._pump(proc, req, st)) if req.control is not None else None
        error: str | None = None
        healthy = False
        try:
            try:
                async with clock.guard(agents.log_probe(self.name, lambda: mapper.session or req.options.session, req.cwd)):
                    async for ev in self.turn(proc, req, mapper, st):
                        clock.observe(ev)
                        yield ev
            except TimeoutError:
                error = clock.message()
            except Died:
                error = f"{self.name} 的常驻进程中途退出了：{proc.stderr_tail() or '没有留下说明'}（退出码 {proc.proc.returncode if proc.proc else '?'}）"
            else:
                healthy = mapper.done and proc.alive
                if mapper.error and not getattr(mapper, "interrupted", False):
                    error = mapper.error
                elif not mapper.done:
                    error = f"{self.name} ended without finishing the turn"
        finally:
            proc.clock = None
            if pump is not None:
                pump.cancel()
            if watcher is not None:
                watcher.cancel()
            if healthy:
                self.pool.release(proc)
            else:  # cancelled, timed out, died: what state it is in is unknown, so it does not carry on
                await asyncio.shield(proc.stop())
        yield self.result(mapper, req, started, error)

    # ——— what the host sends a running turn ———
    @staticmethod
    def _control(line: dict[str, Any]) -> tuple[str, str]:
        if line.get("type") == "control_request" and (line.get("request") or {}).get("subtype") == "interrupt":
            return "interrupt", ""
        if line.get("type") == "user":
            c = (line.get("message") or {}).get("content")
            return ("steer", c) if isinstance(c, str) else ("", "")
        return "", ""

    async def _pump(self, proc: Proc, req: RunRequest, st: _Turn) -> None:
        assert req.control is not None
        while True:
            kind, text = self._control(await req.control.queue.get())
            if not kind:
                continue
            await st.ready.wait()
            if kind == "interrupt":
                st.interrupting = True
            self.send_control(proc, st, kind, text)

    def send_control(self, proc: Proc, st: _Turn, kind: str, text: str) -> None:
        raise NotImplementedError


class CodexResidentBackend(ResidentBackend):
    name = "codex"
    default_bin = "codex"
    Mapper = CodexStream
    ResidentMapper = CodexAppStream

    def resident_argv(self, req: RunRequest) -> list[str]:
        return [*self.cmd, "app-server"]

    async def call(self, proc: Proc, method: str, params: dict[str, Any]) -> dict[str, Any]:
        rid = proc.next_id()
        proc.write({"method": method, "id": rid, "params": params})
        while True:
            m = await proc.get()
            if m is None:
                raise Died()
            if m.get("id") == rid and "method" not in m:
                if "error" in m:
                    raise Unavailable(f"{method}：{(m['error'] or {}).get('message') or m['error']}", sticky=method == "initialize")
                return m.get("result") or {}
            if m.get("method") and m.get("id") is not None:
                proc.write({"id": m["id"], "error": {"code": -32601, "message": "Agora does not answer this request"}})
            elif m.get("method") == "thread/tokenUsage/updated":
                proc.total = ((m.get("params") or {}).get("tokenUsage") or {}).get("total") or proc.total

    async def boot(self, proc: Proc, req: RunRequest) -> None:
        o = req.options
        await self.call(proc, "initialize", {"clientInfo": {"name": "agora", "title": "Agora", "version": "0"}})
        proc.write({"method": "initialized", "params": {}})
        # approval "never": like ``codex exec``, nothing waits for a person at a prompt; the sandbox is the user's own config
        params: dict[str, Any] = {"cwd": req.cwd, "approvalPolicy": "never", **({"model": o.model} if o.model else {})}
        if o.session:
            r = await self.call(proc, "thread/resume", {"threadId": o.session, "excludeTurns": True, **params})
        else:
            r = await self.call(proc, "thread/start", params)
        proc.thread = str((r.get("thread") or {}).get("id") or o.session or "") or None
        if not proc.thread:
            raise Unavailable("app-server 没有给出会话 id", sticky=False)

    async def turn(self, proc: Proc, req: RunRequest, mapper: CodexAppStream, st: _Turn) -> AsyncIterator[dict[str, Any]]:
        params: dict[str, Any] = {"threadId": proc.thread, "input": [{"type": "text", "text": req.prompt}]}
        if req.options.effort:
            params["effort"] = req.options.effort
        mapper.baseline(proc.total)
        rid = proc.next_id()
        proc.write({"method": "turn/start", "id": rid, "params": params})
        try:
            while True:
                m = await proc.get()
                if m is None:
                    raise Died()
                method, mid, p = m.get("method"), m.get("id"), m.get("params") or {}
                if method is None and mid is not None:  # a response
                    if mid == rid:
                        if "error" in m:
                            mapper.error, mapper.done = f"codex: {(m['error'] or {}).get('message') or m['error']}", True
                            break
                        st.turn_id = str(((m.get("result") or {}).get("turn") or {}).get("id") or "") or st.turn_id
                        st.ready.set()
                    continue  # (a steer or an interrupt that failed: the turn is what it is)
                if mid is not None:  # the CLI asks the host something (an approval, a form): nobody is there to answer
                    proc.write({"id": mid, "error": {"code": -32601, "message": "Agora does not answer this request"}})
                    continue
                if p.get("threadId") not in (None, proc.thread):
                    continue  # another thread's notification (a sub-agent's)
                if method == "turn/started":
                    st.turn_id = str((p.get("turn") or {}).get("id") or "") or st.turn_id
                    st.ready.set()
                for ev in mapper.feed(m, now_ms()):
                    yield ev
                if mapper.done:
                    break
        finally:
            proc.total = mapper._total or proc.total

    def send_control(self, proc: Proc, st: _Turn, kind: str, text: str) -> None:
        if kind == "interrupt":
            proc.write({"method": "turn/interrupt", "id": proc.next_id(), "params": {"threadId": proc.thread, "turnId": st.turn_id}})
        else:
            proc.write({"method": "turn/steer", "id": proc.next_id(), "params": {"threadId": proc.thread, "expectedTurnId": st.turn_id, "input": [{"type": "text", "text": text}]}})


class PiResidentBackend(ResidentBackend):
    name = "pi"
    default_bin = "pi"
    Mapper = ResidentMapper = PiStream

    def resident_argv(self, req: RunRequest) -> list[str]:
        from server.canvas import adapters

        return adapters.need("pi").rpc_args(self.cmd, req, skill_dir=agents.SKILL_DIR)

    async def boot(self, proc: Proc, req: RunRequest) -> None:
        # a cheap command: an answer proves the mode exists and the process is up (an old Pi exits, saying it has no such mode)
        rid = f"boot-{proc.next_id()}"
        proc.write({"id": rid, "type": "get_state"})
        while True:
            m = await proc.get()
            if m is None:
                raise Died()
            if m.get("type") == "response" and m.get("id") == rid:
                if not m.get("success"):
                    raise Unavailable(f"rpc 模式没有答应：{m.get('error')}")
                break
            self._answer_ui(proc, m)
        proc.thread = req.options.session

    @staticmethod
    def _answer_ui(proc: Proc, m: dict[str, Any]) -> None:
        if m.get("type") == "extension_ui_request" and m.get("method") in UI_ASKS:
            proc.write({"type": "extension_ui_response", "id": m.get("id"), "cancelled": True})  # nobody is at a prompt here

    async def turn(self, proc: Proc, req: RunRequest, mapper: PiStream, st: _Turn) -> AsyncIterator[dict[str, Any]]:
        st.ready.set()  # the words may go as soon as the prompt is out
        rid = f"p-{proc.next_id()}"
        proc.write({"id": rid, "type": "prompt", "message": req.prompt})
        while True:
            m = await proc.get()
            if m is None:
                raise Died()
            t = m.get("type")
            if t == "response":
                if m.get("id") == rid and not m.get("success"):
                    mapper.error, mapper.done = f"pi: {m.get('error') or 'prompt refused'}", True
                    break
                continue
            if t == "extension_ui_request":
                self._answer_ui(proc, m)
                continue
            for ev in mapper.feed(m, now_ms()):
                yield ev
            if mapper.done:
                break
        if st.interrupting:  # the stop the host asked for ends "aborted": not a failure
            mapper.interrupted = True  # type: ignore[attr-defined]
            if (mapper.error or "").startswith("pi: aborted"):
                mapper.error = None

    def send_control(self, proc: Proc, st: _Turn, kind: str, text: str) -> None:
        if kind == "interrupt":
            proc.write({"id": f"i-{proc.next_id()}", "type": "abort"})
        else:
            proc.write({"id": f"s-{proc.next_id()}", "type": "steer", "message": text})


agents.BACKEND_CLASSES["codex"] = CodexResidentBackend
agents.BACKEND_CLASSES["pi"] = PiResidentBackend
