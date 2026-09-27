"""``agora`` — one project, one local Agora server.

    agora init   [--project P]          create P/.agora/ (idempotent)
    agora up     [--project P] [--dev]  init + start (or reuse) this project's server
    agora open   [--project P] [--dev]  up, then open the browser
    agora status [--project P]
    agora down   [--project P]          stop it (and this project's terminal panes)
    agora serve  --project P --port N   (internal) run the server in the foreground
    agora canvas list|read|search|apply|anim|schema   the agora-canvas skill's commands
    agora skill install [--agent all|claude|pi|codex]  link the skill into the project
    agora share create [--canvas C] [--for 1d] | list | revoke <id>|--all   share a canvas (web/docs/sharing.md)

P defaults to the current directory. The live server is recorded in P/.agora/run/server.json
(pid, port, url); a second ``up`` for the same project reuses it. Different projects get
different free ports and never share state. ``--dev`` serves the frontend through vite
(hot reload) in front of the project backend instead of the built ``web/dist``.

Run it from anywhere with ``bin/agora`` (wraps ``uv run``), or
``uv run --project <agora repo> python -m agora_cli ...`` with the repo on PYTHONPATH.
"""

from __future__ import annotations

import argparse
import fcntl
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


class Project:
    def __init__(self, root: str | None) -> None:
        from server.canvas.project import ProjectStore

        self.store = ProjectStore(Path(root or os.getcwd()))
        self.root = self.store.root
        self.run = self.store.run_dir
        self.state_file = self.run / "server.json"

    def state(self) -> dict[str, Any] | None:
        try:
            return json.loads(self.state_file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def live(self) -> dict[str, Any] | None:
        """The recorded server if it is really this project's and still answering."""
        st = self.state()
        if not st or not alive(st.get("pid")):
            return None
        h = health(st["port"])
        if not h or h.get("root") != str(self.root) or h.get("pid") != st["pid"]:
            return None
        if st.get("vite") and not (alive(st["vite"]["pid"]) and port_open(st["vite"]["port"], "localhost")):
            return None
        return st


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


def up(p: Project, dev: bool, web_port: int = 0) -> tuple[dict[str, Any], bool]:
    """Start this project's server, or return the one already running. (state, reused)"""
    p.store.init()
    with open(p.run / "up.lock", "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)  # two concurrent `up`s for one project start one server
        st = p.live()
        if st:
            return st, True
        stale = p.state()
        if stale:  # half-dead leftovers from a crash
            stop((stale.get("vite") or {}).get("pid"), 2)
            stop(stale.get("pid"), 2)
            p.state_file.unlink(missing_ok=True)
        return start(p, dev, web_port), False


def cmd_up(p: Project, a) -> int:
    st, reused = up(p, a.dev, a.web_port)
    print(f"{'already running' if reused else 'started'}: {st['url']}  (project {p.root}, pid {st['pid']})")
    if not reused and st["mode"] == "dist" and not (WEB / "dist" / "index.html").exists():
        print("note: web/dist is not built; run `cd web && npm run build` or use `agora up --dev`", file=sys.stderr)
    return 0


def cmd_open(p: Project, a) -> int:
    st, _ = up(p, a.dev, a.web_port)
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

    Terminals(p.root, p.run).kill_server()  # Agora's own tmux server for this project only
    st = p.state()
    if not st:
        print(f"not running (project {p.root})")
        return 0
    stop((st.get("vite") or {}).get("pid"))
    stop(st.get("pid"))
    p.state_file.unlink(missing_ok=True)
    ports = [st["port"], *([st["vite"]["port"]] if st.get("vite") else [])]
    busy = [x for x in ports if port_open(x) or port_open(x, "localhost")]
    print(f"stopped (ports {', '.join(map(str, ports))}{' still busy: ' + str(busy) if busy else ' released'})")
    return 1 if busy else 0


def cmd_serve(p: Project, a) -> int:
    import uvicorn

    from server.canvas.project_router import create_project_app

    uvicorn.run(create_project_app(p.root, gateway=True), host=HOST, port=a.port, log_level="info")
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
    from agora_cli.share import add_parser as add_share

    add_share(sub)
    a = ap.parse_args(argv)
    try:
        project = Project(str(find_root(a.project))) if a.cmd in ("canvas", "skill", "share") else Project(a.project)
        return a.fn(project, a)
    except RuntimeError as e:
        print(f"agora: {e}", file=sys.stderr)
        return 2
