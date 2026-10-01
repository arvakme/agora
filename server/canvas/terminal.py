"""Terminal panes for sessions: Agora's own tmux server, one tmux session per Agora session.

Isolation: every copy of a project gets its own tmux server (``tmux -L agora-<instance id>``,
see local.py; builds before instance ids used a hash of the path), config
``.agora/run/tmux.conf`` instead of the user's ``~/.tmux.conf``, so nothing here can
see or touch the user's own tmux sessions. The pane runs the agent CLI directly (no
shell): the tmux session exists exactly as long as the CLI holds the native session.

Input into a pane is a bracketed paste (``paste-buffer -p``) followed by Enter, the same
way a person pasting and pressing Enter would. Enter goes out with ``send-keys -c <client>``
to a writable control-mode client Agora holds itself: tmux 3.7b sends a bare ``send-keys`` through
whichever client is current and refuses it (``client is read-only``) as soon as a read-only
viewer is the latest one attached.

Input right (runtime facts under ``.agora/run/``, meaning of ``native_protocol.SessionGate``):

- ``input-right/<session>.json`` exists → a person took the pane over (``takeover``): automatic
  delivery pauses, the queue stays. It only goes away with ``give_back`` (or when the pane is
  closed or replaced): detaching, a dropped connection or a restart of Agora do not return it.
- A writable client that is not Agora's own pauses delivery for as long as it is attached; it is
  never kicked. A read-only attach (``attach_command(readonly=True)``) takes no input right and
  cannot type.

Liveness: ``panes/<session>.json`` registers the real pane (tmux pane id, CLI pid and its start
time) when the pane is opened; ``state`` compares what tmux reports now with it.
"""

from __future__ import annotations

import hashlib
import json
import os
import select
import shlex
import shutil
import subprocess
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from native_protocol import SessionGate
from server.canvas.agents import _NESTED, child_env, leaked
from server.canvas.terminal_apps import Probe, candidates

CONF = """\
# Agora's tmux server for this project (not the user's ~/.tmux.conf).
set -g mouse on
set -g history-limit 50000
set -sg escape-time 10
set -g default-terminal "tmux-256color"
set -g status-style "bg=#efece6,fg=#3b3a36"
set -g status-left "[Agora] "
set -g status-left-length 20
set -g status-right "#{session_name}  detach: C-b d "
"""
PASTE_END = b"\x1b[201~"
CLIENT_FMT = "#{client_name}|#{client_readonly}|#{client_control_mode}"
# An attach over a local socket answers in milliseconds; this only bounds a server that stopped answering.
HANDSHAKE_S = 10.0

Liveness = Literal["running", "unknown", "gone"]


class TerminalError(RuntimeError):
    pass


class PasteSubmitFailed(TerminalError):
    """The text was pasted into the CLI's input box but Enter did not go through: it sits there unsent.
    Sending it again some other way would run it twice; the caller says it is not known whether it was taken."""


@dataclass(frozen=True)
class Client:
    name: str
    readonly: bool
    control: bool


# ——— pure rules ———
def make_gate(right: dict | None, unmanaged_writers: int) -> SessionGate:
    """The session gate: a recorded takeover pauses (and holds the input right); writable clients
    Agora did not hand out pause too, but only while they are attached."""
    return SessionGate(input_right="human" if right else "host", paused=right is not None, unmanaged_writers=unmanaged_writers)


def gate_hold(gate: SessionGate, *, force: bool = False) -> str | None:
    """Why automatic delivery waits, in words for the page; None when it may go. ``force``: the person
    told Agora to send this one message regardless (the pause, a takeover, a writable window) — only the
    message it was given for; the next one is judged again."""
    if force:
        return None
    if gate.input_right != "host":
        return "终端已被人接管，归还输入权后再投递"
    if gate.paused:
        return "自动投递已暂停"
    if gate.unmanaged_writers:
        return "终端里有可写的窗口连着，关掉它或改成只读后再投递"
    return None


def judge(rec: dict | None, *, dead: bool, pid: int | None, started: str | None) -> Liveness:
    """Is the pane the one Agora registered? ``rec`` is what ``open`` wrote (CLI pid and start
    time), the rest what tmux and ``ps`` report now (``dead``: tmux's ``pane_dead``; ``started``: the
    start time of ``pid``, None when there is no such process). A pane with no registration (opened
    by an older build, or ``.agora/run/`` was lost) is there but unproven: ``unknown``."""
    if dead or pid is None:
        return "gone"
    if rec is None:
        return "unknown"
    if rec.get("pid") != pid or started is None or rec.get("started") != started:
        return "gone"  # another process sits where the registered CLI ran (pid reuse, a replaced pane)
    return "running"


def parse_clients(raw: str) -> list[Client]:
    out = []
    for line in raw.splitlines():
        name, ro, ctl = (line.split("|") + ["", ""])[:3]
        if name:
            out.append(Client(name, ro == "1", ctl == "1"))
    return out


def process_started(pid: int) -> str | None:
    """The start time ``ps`` reports for ``pid`` (with the pid it names one process), None when gone."""
    r = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"})
    out = r.stdout.strip()
    return out if r.returncode == 0 and out else None


def process_tree(pid: int) -> list[int]:
    """``pid`` and every process below it (a CLI's launcher may start the process that holds the files)."""
    r = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True)
    kids: dict[int, list[int]] = {}
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and all(p.isdigit() for p in parts):
            kids.setdefault(int(parts[1]), []).append(int(parts[0]))
    out, todo = [], [pid]
    while todo:
        p = todo.pop()
        if p not in out:
            out.append(p)
            todo += kids.get(p, [])
    return out


def open_files(pids: list[int]) -> list[str]:
    """Absolute paths the processes have open (``/proc/<pid>/fd`` on Linux, ``lsof`` elsewhere)."""
    paths: list[str] = []
    lsof = []
    for pid in pids:
        fd = Path(f"/proc/{pid}/fd")
        if fd.is_dir():
            for entry in fd.iterdir():
                try:
                    target = os.readlink(entry)
                except OSError:
                    continue
                if target.startswith("/"):
                    paths.append(target)
        else:
            lsof.append(str(pid))
    if lsof:
        exe = shutil.which("lsof")
        if exe is None:
            raise TerminalError("lsof is required to see which files a CLI has open on this platform")
        r = subprocess.run([exe, "-nP", "-Fn", "-p", ",".join(lsof)], capture_output=True, text=True)
        paths += [line[1:] for line in r.stdout.splitlines() if line.startswith("n/")]
    return paths


# ——— control client (Agora's own writable client) ———
def _read_block(fd: int, pending: bytearray, deadline: float) -> list[str]:
    """The body of tmux's next ``%begin``/``%end`` reply block. Control mode wraps every reply in
    one and sends notifications outside them, so a whole block is tmux saying it served a command.
    Reads go through the raw descriptor and this caller-owned buffer: a buffered reader would hide
    lines it already consumed from ``select``."""
    body: list[str] = []
    inside = False
    while True:
        while b"\n" in pending:
            line, _, rest = pending.partition(b"\n")
            del pending[:]
            pending.extend(rest)
            text = line.decode(errors="replace").rstrip("\r")
            if text.startswith("%begin"):
                inside, body = True, []
            elif text.startswith("%error"):
                raise TerminalError(f"control client refused a command: {text}")
            elif text.startswith("%end") and inside:
                return body
            elif inside:
                body.append(text)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TerminalError("control client never finished the handshake")
        if not select.select([fd], [], [], remaining)[0]:
            continue
        chunk = os.read(fd, 4096)
        if not chunk:
            raise TerminalError("control client closed before the handshake")
        pending.extend(chunk)


def control_identity(stdin, stdout) -> str:
    """Wait until the control client serves commands (attaching answers with a block of its own),
    then have it name itself: exact where diffing client lists only guesses which one is ours."""
    deadline = time.monotonic() + HANDSHAKE_S
    fd = stdout.fileno()
    pending = bytearray()
    _read_block(fd, pending, deadline)
    try:
        stdin.write(b"display-message -p '#{client_name}'\n")
        stdin.flush()
    except OSError as exc:
        raise TerminalError(f"control client would not take the handshake: {exc}") from exc
    reply = _read_block(fd, pending, deadline)
    name = reply[0].strip() if reply else ""
    if not name:
        raise TerminalError("control client did not name itself")
    return name


def _drain(stream) -> None:
    try:
        while stream.read(4096):
            pass
    except (OSError, ValueError):
        return


class _Control:
    def __init__(self, proc: subprocess.Popen, name: str) -> None:
        self.proc, self.name = proc, name

    def close(self) -> None:
        for f in (self.proc.stdin,):
            try:
                if f:
                    f.close()
            except OSError:
                pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=1)


class Terminals:
    def __init__(self, root: Path, run_dir: Path, tmux: str | None = None, socket: str | None = None, legacy: list[str] | None = None) -> None:
        self.root = root
        self.run_dir = run_dir
        self.tmux = tmux or shutil.which("tmux") or "tmux"
        # The instance's socket (stable across a move); the path hash only when there is no instance.
        self.socket = socket or f"agora-{hashlib.sha1(str(root).encode()).hexdigest()[:10]}"
        self.conf = run_dir / "tmux.conf"
        # Sockets this copy used under other names (path hashes of older builds): a pane still running
        # there after an upgrade holds its session too — seen, pasted into and closed where it is.
        self.legacy = [x for x in legacy or [] if x != self.socket]
        self._others: dict[str, Terminals] = {}
        self._controls: dict[str, _Control] = {}
        self._lock = threading.Lock()

    # ——— plumbing ———
    def _run(self, *args: str, input: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess:
        conf = self.conf
        if not conf.exists():
            if self.run_dir.parent.is_dir():  # never recreate .agora/ for a project that moved away
                self.run_dir.mkdir(exist_ok=True)
                conf.write_text(CONF)
            else:
                conf = Path(os.devnull)
        return subprocess.run(
            [self.tmux, "-L", self.socket, "-f", str(conf), *args],
            input=input,
            capture_output=True,
            timeout=10,
            check=check,
            env=child_env(),
        )

    @staticmethod
    def name(session_id: str) -> str:
        return "agora-" + "".join(c if c.isalnum() or c in "-_" else "_" for c in session_id)

    def pane(self, session_id: str) -> str:
        """Exact-match target for the session's (only) pane: ``=name:`` (``=name`` alone resolves no pane)."""
        return f"={self.name(session_id)}:"

    def attach_command(self, session_id: str, *, readonly: bool = False) -> str:
        """The shell command that attaches to the pane. ``readonly``: a viewer that takes no input
        right and cannot type (tmux drops its keys)."""
        return f"{shlex.quote(self.tmux)} -L {self._where(session_id).socket} attach{' -r' if readonly else ''} -t {self.name(session_id)}"

    def _where(self, session_id: str) -> "Terminals":
        """The tmux server holding this session's pane: this copy's own, else a legacy one where it still runs."""
        if not self.legacy or self._own_has_pane(session_id):
            return self
        for name in self.legacy:
            other = self._others.get(name)
            if other is None:
                other = self._others[name] = Terminals(self.root, self.run_dir, self.tmux, socket=name)
            if other._own_has_pane(session_id):
                return other
        return self

    # ——— state ———
    def state(self, session_id: str) -> Liveness:
        """``running``: the pane and the CLI process Agora registered are there. ``unknown``: a pane
        is there but nothing proves it is that CLI. ``gone``: no pane, the CLI exited, or another
        process took its place. Whether the turn it was in finished is for the native log to say."""
        return self._where(session_id)._own_state(session_id)

    def alive(self, session_id: str) -> bool:
        return self.state(session_id) != "gone"

    def _own_has_pane(self, session_id: str) -> bool:
        """Cheap: tmux has a live pane by this name on this server (which server holds it, not who runs in it)."""
        r = self._run("display-message", "-p", "-t", self.pane(session_id), "#{pane_dead}", check=False)
        return r.returncode == 0 and r.stdout.strip() == b"0"

    def _own_state(self, session_id: str) -> Liveness:
        r = self._run("display-message", "-p", "-t", self.pane(session_id), "#{pane_dead}|#{pane_pid}", check=False)
        if r.returncode != 0:
            return "gone"
        dead, _, pid_s = r.stdout.decode().strip().partition("|")
        pid = int(pid_s) if pid_s.isdigit() else None
        return judge(self._registered(session_id), dead=dead != "0", pid=pid, started=process_started(pid) if pid else None)

    def sessions(self) -> list[str]:
        r = self._run("list-sessions", "-F", "#{session_name}", check=False)
        return r.stdout.decode().split() if r.returncode == 0 else []

    def pane_pid(self, session_id: str) -> int | None:
        r = self._where(session_id)._run("display-message", "-p", "-t", self.pane(session_id), "#{pane_pid}", check=False)
        out = r.stdout.decode().strip()
        return int(out) if r.returncode == 0 and out.isdigit() else None

    def process_files(self, session_id: str) -> list[str]:
        """Files the pane's CLI process (or the processes it started) has open."""
        pid = self.pane_pid(session_id)
        return open_files(process_tree(pid)) if pid else []

    def capture(self, session_id: str, lines: int = 200) -> str:
        r = self._where(session_id)._run("capture-pane", "-p", "-J", "-S", f"-{lines}", "-t", self.pane(session_id), check=False)
        return r.stdout.decode("utf-8", "replace")

    # ——— registration and input right (files under .agora/run/) ———
    def _file(self, kind: str, session_id: str) -> Path:
        return self.run_dir / kind / f"{self.name(session_id)}.json"

    def _read(self, kind: str, session_id: str) -> dict | None:
        try:
            rec = json.loads(self._file(kind, session_id).read_text())
        except (OSError, ValueError):
            return None
        return rec if isinstance(rec, dict) else None

    def _write(self, kind: str, session_id: str, rec: dict) -> None:
        if not self.run_dir.parent.is_dir():  # never recreate .agora/ for a project that moved away
            return
        f = self._file(kind, session_id)
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(rec))
        os.replace(tmp, f)

    def _registered(self, session_id: str) -> dict | None:
        return self._read("panes", session_id)

    def input_right(self, session_id: str) -> dict | None:
        """The recorded takeover (``{"right": "human", "at": …}``), None while the host holds the input right."""
        return self._read("input-right", session_id)

    def takeover(self, session_id: str) -> dict:
        """A person takes the pane over: automatic delivery pauses and stays paused, whatever happens
        to their connection, until ``give_back``. Nothing running is cancelled."""
        rec = self.input_right(session_id) or {"right": "human", "at": time.time()}
        self._write("input-right", session_id, rec)
        return rec

    def give_back(self, session_id: str) -> bool:
        """The person hands the input right back: delivery resumes. Whether it was held."""
        f = self._file("input-right", session_id)
        held = f.exists()
        f.unlink(missing_ok=True)
        return held

    def list_clients(self, session_id: str) -> list[Client]:
        """Clients attached to the pane's session, Agora's own control client left out."""
        w = self._where(session_id)
        r = w._run("list-clients", "-t", f"={self.name(session_id)}", "-F", CLIENT_FMT, check=False)
        own = w._controls.get(self.name(session_id))
        return [c for c in parse_clients(r.stdout.decode()) if own is None or c.name != own.name] if r.returncode == 0 else []

    def clients(self, session_id: str) -> int:
        return len(self.list_clients(session_id))

    def gate(self, session_id: str) -> SessionGate:
        writers = sum(1 for c in self.list_clients(session_id) if not c.readonly)
        return make_gate(self.input_right(session_id), writers)

    # ——— actions ———
    def open(self, session_id: str, argv: list[str], *, cwd: Path, env: dict[str, str]) -> bool:
        """Start the pane unless it already runs. Returns True when it was created."""
        if self.state(session_id) != "gone":
            return False
        name = self.name(session_id)
        self._run("kill-session", "-t", f"={name}", check=False)  # a dead leftover
        self._close_control(name)
        # A tmux server that was started before (by an older build, or by whatever pane restarted Agora)
        # may carry another app's variables in its own environment: take them out of it, and out of the pane.
        stale = sorted({line.lstrip("-").split("=")[0] for line in self._run("show-environment", "-g", check=False).stdout.decode(errors="replace").splitlines() if leaked(line.lstrip("-"))})
        for k in stale:
            self._run("set-environment", "-g", "-u", k, check=False)
        drop = [*_NESTED, *sorted({*stale, *(k for k in os.environ if leaked(k))})]
        # `env -u …` drops nesting markers inherited from whoever started the tmux server.
        wrapped = ["env", *[a for k in drop for a in ("-u", k)], *[f"{k}={v}" for k, v in env.items() if not leaked(k)], *argv]
        r = self._run("new-session", "-d", "-s", name, "-x", "220", "-y", "56", "-c", str(cwd), "--", *wrapped, check=False)
        if r.returncode != 0:
            raise TerminalError(r.stderr.decode(errors="replace").strip() or "tmux new-session failed")
        self._file("input-right", session_id).unlink(missing_ok=True)  # a new CLI starts with the host holding input
        self._register(session_id)
        return True

    def _register(self, session_id: str) -> None:
        r = self._run("display-message", "-p", "-t", self.pane(session_id), "#{pane_id}|#{pane_pid}", check=False)
        pane_id, _, pid_s = r.stdout.decode().strip().partition("|")
        if r.returncode == 0 and pid_s.isdigit():
            self._write("panes", session_id, {"paneId": pane_id, "pid": int(pid_s), "started": process_started(int(pid_s)), "at": time.time()})

    def _control(self, session_id: str) -> str:
        """The name of Agora's own writable client on this pane's session (started on first use)."""
        name = self.name(session_id)
        with self._lock:
            ctl = self._controls.get(name)
            if ctl is not None and ctl.proc.poll() is None and any(c.name == ctl.name for c in parse_clients(self._run("list-clients", "-t", f"={name}", "-F", CLIENT_FMT, check=False).stdout.decode())):
                return ctl.name
            self._close_control(name)
            # ignore-size: it never resizes the window; no-output: tmux does not stream the pane to it.
            proc = subprocess.Popen(
                [self.tmux, "-L", self.socket, "-f", str(self.conf), "-C", "attach-session", "-f", "ignore-size,no-output", "-t", f"={name}"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env=child_env(),
            )
            try:
                cname = control_identity(proc.stdin, proc.stdout)
            except TerminalError:
                _Control(proc, "").close()
                raise
            threading.Thread(target=_drain, args=(proc.stdout,), daemon=True).start()
            self._controls[name] = _Control(proc, cname)
            return cname

    def _close_control(self, name: str) -> None:
        ctl = self._controls.pop(name, None)
        if ctl is not None:
            ctl.close()

    def paste(self, session_id: str, text: str, *, settle_s: float = 0.4) -> None:
        """Bracketed paste of ``text`` into the pane, then Enter (from Agora's own client)."""
        data = text.encode()
        if PASTE_END in data:
            raise TerminalError("text contains a bracketed-paste terminator")
        buf = f"agora-{session_id}"
        w = self._where(session_id)
        client = w._control(session_id)
        try:
            w._run("load-buffer", "-b", buf, "-", input=data)
            w._run("paste-buffer", "-p", "-d", "-b", buf, "-t", self.pane(session_id))
        except subprocess.CalledProcessError as exc:
            raise TerminalError((exc.stderr or b"").decode(errors="replace").strip() or "tmux paste failed") from None
        time.sleep(settle_s)  # a TUI merges keys that arrive while it still takes the paste in
        try:
            w._run("send-keys", "-c", client, "-t", self.pane(session_id), "Enter")
        except subprocess.CalledProcessError as exc:
            raise PasteSubmitFailed((exc.stderr or b"").decode(errors="replace").strip() or "tmux send-keys Enter failed") from None

    def socket_path(self) -> Path:
        """Where tmux puts this server's socket ($TMUX_TMPDIR or /tmp, then tmux-<uid>/<name>)."""
        base = os.environ.get("TMUX_TMPDIR") or "/tmp"
        return Path(os.path.realpath(base)) / f"tmux-{os.getuid()}" / self.socket

    def _drop_dead_socket(self) -> None:
        # tmux can leave the socket file behind when its last session ends or it is killed.
        if self.socket_path().exists() and self._run("list-sessions", check=False).returncode != 0:
            self.socket_path().unlink(missing_ok=True)

    def kill(self, session_id: str) -> None:
        w = self._where(session_id)
        w._close_control(self.name(session_id))
        w._run("kill-session", "-t", f"={self.name(session_id)}", check=False)
        w._drop_dead_socket()
        if w is not self:
            self._run("kill-session", "-t", f"={self.name(session_id)}", check=False)
            self._drop_dead_socket()
        for kind in ("panes", "input-right"):
            self._file(kind, session_id).unlink(missing_ok=True)

    def kill_server(self) -> None:
        """Stop this project's tmux server and remove its socket file."""
        for name in list(self._controls):
            self._close_control(name)
        self._run("kill-server", check=False)
        self._drop_dead_socket()

    def kill_other_servers(self, sockets: list[str]) -> list[str]:
        """Stop tmux servers this project used under other names (the path-hash sockets of older
        builds, the roots it had before a move). Returns the ones that were running."""
        stopped = []
        for name in sockets:
            if name == self.socket:
                continue
            other = Terminals(self.root, self.run_dir, self.tmux, socket=name)
            if other._run("list-sessions", check=False).returncode == 0:
                other.kill_server()
                stopped.append(name)
            else:
                other._drop_dead_socket()
        return stopped

    def shutdown(self) -> None:
        """``agora down``: this project's own tmux server."""
        self.kill_server()

    def launch(self, session_id: str, title: str, *, env: Mapping[str, str] | None = None, probe: Probe | None = None) -> str | None:
        """Open a terminal window attached to the pane (which terminal: terminal_apps.py). Returns its key, None when none opened."""
        attach = self.attach_command(session_id)
        for app, found in candidates(env, probe):
            try:
                # Nothing of this process's own environment but what an agent CLI gets: `open` hands its environment to the app it starts.
                r = subprocess.run(app.argv(found, title, str(self.root), attach), stdin=subprocess.DEVNULL, capture_output=True, timeout=10, start_new_session=True, env=child_env())
            except (OSError, subprocess.TimeoutExpired):
                continue
            if r.returncode == 0:
                return app.key
        return None
