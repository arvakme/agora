"""``agora`` — one project, one local Agora server.

    agora init   [--project P]          create P/.agora/ (idempotent)
    agora up     [--project P] [--dev]  init + start (or reuse) this project's server
    agora open   [--project P] [--dev]  up, then open the browser
    agora status [--project P]
    agora down   [--project P]          stop it (and this project's terminal panes)
    agora serve  --project P --port N   (internal) run the server in the foreground
    agora canvas list|read|search|apply|anim|schema   the agora skill's commands
    agora dispatch --to S|--new A --task-file F | status|wait|interrupt|list   give a task to another session
    agora reply --request R --status done|failed|blocked [-f F]   hand the receipt back (agora_cli/dispatch.py)
    agora skill install [--agent all|claude|pi|codex]  link the skill into the project
    agora share create [--canvas C] [--for 1d] | list | revoke <id>|--all   share a canvas (web/docs/sharing.md)
    agora doctor [--fix] | backup | restore [--from …] | history [<file>]   local safety nets (agora_cli/doctor.py)

P defaults to the current directory. The live server is recorded in P/.agora/run/server.json
(pid, port, url); a second ``up`` for the same project reuses it. Different projects get
different free ports and never share state. The server also holds a lock and a record outside
the project (``$AGORA_STATE_DIR``, default ~/.local/state/agora/servers/<instance id>.{lock,json};
the instance id names this copy of the project, server/canvas/local.py), so losing
``.agora/run/`` (``git clean -fdx``) never leads to a second server for P, and ``agora down``
still finds and stops it. ``up`` first settles whether the project was moved, copied or freshly
cloned since last time (moved Pi logs follow it) and says so. ``--dev`` serves the frontend through vite
(hot reload) in front of the project backend instead of the built ``web/dist``.

Run it from anywhere with ``bin/agora`` (wraps ``uv run``), or
``uv run --project <agora repo> python -m agora_cli ...`` with the repo on PYTHONPATH.
"""

from __future__ import annotations

import argparse
import atexit
import fcntl
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
WEB = REPO / "web"
HOST = "127.0.0.1"


# ——— helpers ———
def free_port(preferred: int = 0) -> int:
    for p in ([preferred] if preferred else []) + [0]:
        with socket.socket() as s:
            try:
                s.bind((HOST, p))
            except OSError:
                continue
            return s.getsockname()[1]
    raise RuntimeError("no free port")


def port_open(port: int, host: str = HOST) -> bool:
    try:
        socket.create_connection((host, port), timeout=0.3).close()
        return True
    except OSError:
        return False


def alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie child of ours still answers kill(0); reap it if so.
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
        return done == 0
    except ChildProcessError:
        return True


def get_json(url: str, timeout: float = 1.0) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


def health(port: int) -> dict[str, Any] | None:
    try:
        return get_json(f"http://{HOST}:{port}/api/project/health")
    except Exception:
        return None


def state_dir() -> Path:
    """Machine-local Agora state outside every project (survives ``git clean -fdx``)."""
    from server.canvas.local import state_dir as sd

    return sd()


class Project:
    def __init__(self, root: str | None) -> None:
        from server.canvas.local import Local
        from server.canvas.project import ProjectStore

        self.store = ProjectStore(Path(root or os.getcwd()))
        self.root = self.store.root
        self.run = self.store.run_dir
        self.state_file = self.run / "server.json"
        self.local = Local(self.store)
        # Builds before instance ids keyed the record by a hash of the path; still honoured.
        self.legacy_record = state_dir() / "servers" / f"{hashlib.sha1(str(self.root).encode()).hexdigest()[:16]}.json"

    @property
    def record(self) -> Path:
        iid = self.local.instance_id()
        return state_dir() / "servers" / f"{iid}.json" if iid else self.legacy_record

    @property
    def lock_file(self) -> Path:
        return self.record.with_suffix(".lock")

    def state(self) -> dict[str, Any] | None:
        try:
            return json.loads(self.state_file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def registered(self) -> dict[str, Any] | None:
        """The server record kept outside the project (written by ``serve`` itself)."""
        for rec in (self.record, self.legacy_record):
            try:
                return json.loads(rec.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                continue
        return None

    def lock_held(self) -> bool:
        """Whether a ``serve`` process for this project holds its lock (it does for its whole life)."""
        for lock in dict.fromkeys((self.lock_file, self.legacy_record.with_suffix(".lock"))):
            try:
                fh = open(lock, "a+")
            except FileNotFoundError:
                continue
            with fh:
                try:
                    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return True
                fcntl.flock(fh, fcntl.LOCK_UN)
        return False

    def serve_pid(self) -> int | None:
        """The ``serve`` process holding this project's lock, even when it no longer answers: its pid
        is written into the lock file (and the record) when it starts."""
        for f in (self.lock_file, self.record, self.legacy_record.with_suffix(".lock"), self.legacy_record):
            try:
                raw = f.read_text().strip()
            except OSError:
                continue
            try:
                pid = int(json.loads(raw)["pid"]) if raw.startswith("{") else int(raw)
            except (ValueError, KeyError, TypeError):
                continue
            if pid and self.is_serve(pid):
                return pid
        return None

    def is_serve(self, pid: int) -> bool:
        """``pid`` is an ``agora_cli serve --project <this root>`` process (checked before stopping it)."""
        if not alive(pid):
            return False
        try:
            cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            return False
        return "agora_cli serve" in cmd and f"--project {self.root}" in cmd

    def reconcile(self) -> dict[str, Any]:
        """Moved, copied or freshly cloned since last time? Settle it before anything is started."""
        from server.canvas.terminal import Terminals

        probe = Terminals(self.root, self.run, socket=self.local.socket(), legacy=self.local.legacy_sockets())
        return self.local.reconcile(alive=probe.alive)

    def answering(self, st: dict[str, Any] | None) -> bool:
        """``st`` names a server that is really this project's and still answering."""
        if not st or not alive(st.get("pid")) or not st.get("port"):
            return False
        h = health(st["port"])
        if not h or h.get("root") != str(self.root) or h.get("pid") != st["pid"] or h.get("gone"):
            return False  # not this project's, or its directory went away under it (it refuses writes)
        if st.get("vite") and not (alive(st["vite"]["pid"]) and port_open(st["vite"]["port"], "localhost")):
            return False
        return True

    def live(self) -> dict[str, Any] | None:
        """The recorded server if it is really this project's and still answering. When
        ``run/server.json`` is gone (``git clean -fdx``) but the server still runs, it is found
        through its record outside the project and ``server.json`` is written back."""
        st = self.state()
        if self.answering(st):
            return st
        reg = self.registered()
        if not self.answering(reg):
            return None
        assert reg is not None
        back = {**(st if st and st.get("pid") == reg["pid"] else {}), **reg}
        try:
            self.run.mkdir(exist_ok=True)
            tmp = self.state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(back, indent=2) + "\n")
            os.replace(tmp, self.state_file)
        except OSError:
            pass
        return back


def spawn(argv: list[str], *, cwd: Path, log: Path, env: dict[str, str]) -> subprocess.Popen:
    fh = open(log, "ab")
    # Own session = own process group, so `down` can stop the whole tree (uv/npx wrappers included).
    return subprocess.Popen(argv, cwd=cwd, stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, start_new_session=True)


def stop(pid: int | None, timeout: float = 8.0) -> None:
    if not pid:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            return
        except PermissionError:
            os.kill(pid, sig)
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not alive(pid):
                return
            time.sleep(0.1)


def wait_until(pred, timeout: float, proc: subprocess.Popen | None = None) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        if proc is not None and proc.poll() is not None:
            return False
        time.sleep(0.15)
    return False


# ——— commands ———
def cmd_init(p: Project, _a) -> int:
    created = p.store.init()
    print(f"{'created' if created else 'exists'}: {p.store.dir}")
    return 0


def start(p: Project, dev: bool, web_port: int = 0) -> dict[str, Any]:
    p.store.init()
    cfg = p.store.config()
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(REPO), os.environ.get("PYTHONPATH")]))}
    log = p.run / "server.log"
    proc = None
    port = 0
    for attempt in range(3):
        port = free_port(int(cfg.get("server", {}).get("port") or 0) if attempt == 0 else 0)
        proc = spawn([sys.executable, "-m", "agora_cli", "serve", "--project", str(p.root), "--port", str(port)], cwd=REPO, log=log, env=env)
        if wait_until(lambda: (h := health(port)) is not None and h.get("pid") == proc.pid, 30, proc):
            break
        stop(proc.pid, 2)
        proc = None
    if proc is None:
        raise RuntimeError(f"server did not start; see {log}")
    state: dict[str, Any] = {
        "pid": proc.pid,
        "port": port,
        "url": f"http://{HOST}:{port}/",
        "root": str(p.root),
        "mode": "dev" if dev else "dist",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "log": str(log),
    }
    if dev:
        vport = web_port or free_port()
        npx = ["mise", "exec", "--", "npx"] if shutil.which("mise") else ["npx"]
        vite = spawn(
            [*npx, "vite", "--port", str(vport), "--strictPort", "--host", "localhost"],
            cwd=WEB,
            log=p.run / "vite.log",
            env={**env, "AGORA_API_ORIGIN": f"http://{HOST}:{port}"},
        )
        if not wait_until(lambda: port_open(vport, "localhost"), 60, vite):
            stop(vite.pid, 2)
            stop(proc.pid)
            raise RuntimeError(f"vite did not start; see {p.run / 'vite.log'}")
        state["vite"] = {"pid": vite.pid, "port": vport}
        # localhost, not 127.0.0.1: the browser origin the old IndexedDB workspace was saved under.
        state["url"] = f"http://localhost:{vport}/"
    tmp = p.state_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n")
    os.replace(tmp, p.state_file)
    return state


def change_note(change: dict[str, Any], root: Path) -> str | None:
    """One paragraph about what ``reconcile`` found (printed by ``up``; the page shows it too)."""
    kind = change.get("kind")
    if kind == "moved":
        lines = [f"项目从 {change.get('from')} 移到了 {root}。Claude Code / Codex 的会话照常续接。"]
        if change.get("migrated"):
            lines.append(f"已把 {len(change['migrated'])} 个 Pi 会话的日志迁到新目录（旧文件留了 .agora-moved.bak）。")
        for f in change.get("failed") or []:
            lines.append(f"Pi 会话 {f['sessionId']} 没迁移：{f['error']}" + ("（下一条消息会分叉继续）" if f.get("fallback") == "fork" else ""))
        return "\n".join(lines)
    if kind == "copied":
        return f"这是 {change.get('from')} 的一份副本：带过来的 {len(change.get('sessions') or [])} 个会话在这里只读，页面上可以「在这里分叉继续」。"
    if kind == "fresh":
        return "这份项目里的会话不是在这台机器上的这个位置建的（新 clone、换机器或 git clean -fdx）：页面上显示为只读卡片；`agora doctor` 会检查本机能找回什么。"
    if kind == "reattached":
        return "这份项目的本机记录（.agora/local）不见了，已按本机注册表认回；`agora doctor` 检查会话绑定。"
    return None


def up(p: Project, dev: bool, web_port: int = 0) -> tuple[dict[str, Any], bool]:
    """Start this project's server, or return the one already running. (state, reused)"""
    p.store.init()
    with open(p.run / "up.lock", "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)  # two concurrent `up`s for one project start one server
        p.change = p.reconcile()
        st = p.live()
        if st:
            return st, True
        reg = p.registered()
        if reg and reg.get("root") != str(p.root) and alive(reg.get("pid")):
            # This copy's server still runs at the path the project was moved away from; it refuses
            # every write there (410) and would hold the lock forever: stop it, start here.
            h = health(reg.get("port") or 0)
            if h is None or h.get("gone"):
                stop(reg.get("pid"))
        if p.lock_held():
            raise RuntimeError(
                f"a server for {p.root} is already running but does not answer (its lock {p.lock_file} is held); "
                f"stop it with `agora down --project {p.root}`"
            )
        stale = p.state()
        if stale:  # half-dead leftovers from a crash
            # Only this project's own serve process (checked by its command line) and its vite are
            # stopped: a `cp -r` of a running project carries the original's server.json along, and
            # that server belongs to the original.
            if p.is_serve(stale.get("pid") or 0):
                stop((stale.get("vite") or {}).get("pid"), 2)
                stop(stale.get("pid"), 2)
            p.state_file.unlink(missing_ok=True)
        return start(p, dev, web_port), False


def cmd_up(p: Project, a) -> int:
    st, reused = up(p, a.dev, a.web_port)
    note = change_note(getattr(p, "change", {}) or {}, p.root)
    if note:
        print(note)
    print(f"{'already running' if reused else 'started'}: {st['url']}  (project {p.root}, pid {st['pid']})")
    if not reused and st["mode"] == "dist" and not (WEB / "dist" / "index.html").exists():
        print("note: web/dist is not built; run `cd web && npm run build` or use `agora up --dev`", file=sys.stderr)
    return 0


def cmd_open(p: Project, a) -> int:
    st, _ = up(p, a.dev, a.web_port)
    note = change_note(getattr(p, "change", {}) or {}, p.root)
    if note:
        print(note)
    print(st["url"])
    if not a.no_browser:
        webbrowser.open(st["url"])
    return 0


def cmd_status(p: Project, _a) -> int:
    st = p.live()
    if not st:
        print(f"not running (project {p.root})")
        return 1
    print(json.dumps(st, indent=2))
    return 0


def cmd_down(p: Project, _a) -> int:
    from server.canvas.terminal import Terminals

    terms = Terminals(p.root, p.run, socket=p.local.socket())
    terms.shutdown()  # Agora's own tmux server for this project
    # …and tmux servers it had under other names: path-hash sockets of older builds, earlier roots.
    for name in terms.kill_other_servers(p.local.legacy_sockets()):
        print(f"stopped tmux server {name}")
    st = p.state()
    reg = p.registered()
    if (not st or not alive(st.get("pid"))) and p.answering(reg):
        st = reg  # run/server.json was lost (git clean -fdx) while the server kept running
    if not st or not alive(st.get("pid")):
        # Nothing answers, but a serve process may still hold the lock (hung, or its directory
        # moved): found by the pid it wrote into its lock, stopped once its command line checks out.
        pid = p.serve_pid()
        if pid is None:
            print(f"not running (project {p.root})")
            return 0
        st = {**(reg if reg and reg.get("pid") == pid else {}), "pid": pid, "port": (reg or {}).get("port") if reg and reg.get("pid") == pid else None}
    stop((st.get("vite") or {}).get("pid"))
    stop(st.get("pid"))
    p.state_file.unlink(missing_ok=True)
    if reg and reg.get("pid") == st.get("pid"):
        p.record.unlink(missing_ok=True)
    ports = [x for x in [st.get("port"), *([st["vite"]["port"]] if st.get("vite") else [])] if x]
    busy = [x for x in ports if port_open(x) or port_open(x, "localhost")]
    print(f"stopped (ports {', '.join(map(str, ports))}{' still busy: ' + str(busy) if busy else ' released'})")
    return 1 if busy else 0


def cmd_serve(p: Project, a) -> int:
    import uvicorn

    from server.canvas import shutdown
    from server.canvas.project_router import create_project_app
    from server.canvas.version import running_version

    # One server per copy of the project: the lock lives outside the project, so deleting
    # .agora/run/ does not release it; the kernel does when this process ends, however it ends.
    p.store.init()
    p.reconcile()
    p.record.parent.mkdir(parents=True, exist_ok=True)
    lock = open(p.lock_file, "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        other = p.registered() or {}
        print(f"agora: a server for {p.root} is already running (pid {other.get('pid', '?')}, port {other.get('port', '?')})", file=sys.stderr)
        return 3
    lock.seek(0)
    lock.truncate()
    lock.write(str(os.getpid()))  # `down` finds a hung server by it, even with run/ and the record gone
    lock.flush()
    record = {
        "pid": os.getpid(),
        "port": a.port,
        "url": f"http://{HOST}:{a.port}/",
        "root": str(p.root),
        "mode": "dist",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        **running_version(),
    }
    tmp = p.record.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n")
    os.replace(tmp, p.record)

    def forget() -> None:
        if (p.registered() or {}).get("pid") == os.getpid():
            p.record.unlink(missing_ok=True)

    atexit.register(forget)
    try:
        # The first SIGTERM ends the pages' event streams from this side (uvicorn would wait for them for ever), a second
        # stops all waiting, and open connections are cancelled after a few seconds: shutdown.py.
        server = shutdown.AgoraServer(uvicorn.Config(create_project_app(p.root, gateway=True), host=HOST, port=a.port, log_level="info", timeout_graceful_shutdown=shutdown.GRACE_S))
        server.run()
    finally:
        forget()
        lock.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="agora", description="One project, one local Agora server (data in <project>/.agora/).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn, help in (
        ("init", cmd_init, "create .agora/ in the project"),
        ("up", cmd_up, "start (or reuse) this project's server"),
        ("open", cmd_open, "up, then open the browser"),
        ("status", cmd_status, "show the running server"),
        ("down", cmd_down, "stop this project's server"),
        ("serve", cmd_serve, "run the server in the foreground (used by up)"),
    ):
        s = sub.add_parser(name, help=help)
        s.add_argument("--project", default=None, help="project directory (default: current directory)")
        s.set_defaults(fn=fn)
        if name in ("up", "open"):
            s.add_argument("--dev", action="store_true", help="serve the frontend through vite (hot reload)")
            s.add_argument(
                "--web-port",
                type=int,
                default=0,
                help="with --dev: vite port (e.g. 5181 to open the old http://localhost:5181 origin once and import its browser data)",
            )
        if name == "open":
            s.add_argument("--no-browser", action="store_true", help="only print the URL")
        if name == "serve":
            s.add_argument("--port", type=int, required=True)
    from agora_cli.canvas import add_parsers, find_root

    add_parsers(sub)
    from agora_cli.dispatch import add_parsers as add_dispatch

    add_dispatch(sub)
    from agora_cli.share import add_parser as add_share

    add_share(sub)
    from agora_cli.doctor import add_parsers as add_doctor

    from agora_cli.fleet import add_parsers as add_fleet

    add_doctor(sub)
    add_fleet(sub)
    a = ap.parse_args(argv)
    try:
        if a.cmd == "dev":  # machine-wide: no project
            return a.fn(None, a)
        project = Project(str(find_root(a.project))) if a.cmd in ("canvas", "skill", "share", "import", "doctor", "backup", "restore", "history", "dispatch", "reply") else Project(a.project)
        return a.fn(project, a)
    except RuntimeError as e:
        print(f"agora: {e}", file=sys.stderr)
        return 2
