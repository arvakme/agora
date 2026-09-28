"""What only this machine knows about a project: which copy of it this is, where it has lived,
and the registry of sessions kept outside every project.

- **Instance** (``.agora/local/instance.json``, never committed): ``{instanceId, projectId, root,
  dev, ino, createdAt}``. ``config.toml``'s ``project.id`` says "the same project" (every clone
  shares it); the instance id says "this copy on this machine". Machine-scoped names (the tmux
  socket, the share tunnel, the server lock) use it instead of a hash of the path, so they
  survive a move and differ between copies.
- **Registry** (``$AGORA_STATE_DIR/registry.jsonl``, default ``~/.local/state/agora``): one
  append-only file for every project on the machine, one event per line (``instance``, ``root``,
  ``copy``, ``bind``, ``rebind``, ``trash``, ``restore``, ``purge``, ``import``). Ids, paths and
  titles only — never conversation text. It survives ``git clean -fdx`` and a deleted or moved
  repository, so it is what finds a session's native log again.
- **Reconcile** (``agora up``, server start): compare where the project is with where its
  instance record says it was. Moved → keep the id, record the new root, move Pi's logs along
  (``agents.migrate_pi_log``). Copied (``cp -r``: the old path still has the same instance) → a
  new id for this copy, and every session brought along is marked as a copy (read-only here
  until forked, ``copies.json``). No record (new clone, another machine, ``git clean -fdx``) →
  reuse the id this path had in the registry, else a new one.

Format and semantics: web/docs/project-storage.md §1 and web/docs/agent-sessions.md §1.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

LOCAL_DIR = "local"


def now_ms() -> int:
    return int(time.time() * 1000)


def state_dir() -> Path:
    """Machine-local Agora state outside every project (survives ``git clean -fdx``)."""
    return Path(os.environ.get("AGORA_STATE_DIR") or Path.home() / ".local" / "state" / "agora")


def self_ignoring(d: Path, why: str) -> Path:
    """A directory under ``.agora/`` that carries its own ``.gitignore`` (``*``), so it stays out of
    git even in projects whose ``.agora/.gitignore`` predates it."""
    d.mkdir(parents=True, exist_ok=True)
    gi = d / ".gitignore"
    if not gi.exists():
        gi.write_text(f"# {why}\n*\n")
    return d


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def legacy_socket(root: Path | str) -> str:
    """The tmux socket name builds before instance ids used (a hash of the path)."""
    return f"agora-{hashlib.sha1(str(root).encode()).hexdigest()[:10]}"


def socket_name(instance_id: str) -> str:
    return f"agora-{instance_id.replace('-', '')[:10]}"


# ——— registry ———
class Registry:
    """``registry.jsonl``: append under a lock, read tolerantly (a torn or foreign line is skipped)."""

    def __init__(self, root: Path | None = None) -> None:
        self.dir = root or state_dir()
        self.path = self.dir / "registry.jsonl"

    def append(self, t: str, **fields: Any) -> dict[str, Any]:
        rec = {"t": t, "at": fields.pop("at", None) or now_ms(), **{k: v for k, v in fields.items() if v is not None}}
        line = (json.dumps(rec, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
        self.dir.mkdir(parents=True, exist_ok=True)
        with open(self.dir / "registry.lock", "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                try:
                    os.write(fd, line)
                    os.fsync(fd)
                finally:
                    os.close(fd)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
        return rec

    def events(self, project_id: str | None = None, t: str | tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        try:
            raw = self.path.read_bytes()
        except OSError:
            return []
        kinds = (t,) if isinstance(t, str) else t
        out = []
        for line in raw.splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if not isinstance(rec, dict) or not isinstance(rec.get("t"), str):
                continue
            if project_id is not None and rec.get("projectId") != project_id:
                continue
            if kinds is not None and rec["t"] not in kinds:
                continue
            out.append(rec)
        return out

    def roots(self, project_id: str, instance_id: str | None = None) -> list[str]:
        """Every root this project (or one instance of it) has been seen at, oldest first."""
        seen: list[str] = []
        for e in self.events(project_id):
            if instance_id is not None and e.get("instanceId") != instance_id:
                continue
            for r in (e.get("from"), e.get("root")):
                if isinstance(r, str) and r and r not in seen:
                    seen.append(r)
        return seen

    def instance_at(self, project_id: str, root: str) -> str | None:
        """The instance whose latest known root is ``root`` (``git clean -fdx`` removed its record)."""
        last: dict[str, str] = {}
        for e in self.events(project_id, ("instance", "root", "copy")):
            if e.get("instanceId") and e.get("root"):
                last[e["instanceId"]] = e["root"]
        hits = [i for i, r in last.items() if r == root]
        return hits[-1] if hits else None

    def binds(self, project_id: str) -> dict[str, dict[str, Any]]:
        """Latest ``bind`` / ``rebind`` / ``import`` per Agora session id (later events win)."""
        out: dict[str, dict[str, Any]] = {}
        for e in self.events(project_id, ("bind", "rebind", "import")):
            sid = e.get("sessionId")
            if isinstance(sid, str) and e.get("agent"):
                out[sid] = {**out.get(sid, {}), **e}
        return out

    def by_native(self) -> dict[str, dict[str, Any]]:
        """Latest bind event per native id, across every project on the machine."""
        out: dict[str, dict[str, Any]] = {}
        for e in self.events(None, ("bind", "rebind", "import")):
            if isinstance(e.get("nativeId"), str) and e["nativeId"]:
                out[e["nativeId"]] = e
        return out


# ——— this copy of the project ———
class Local:
    """``.agora/local/`` of one project: the instance record, copies, the pending notice."""

    def __init__(self, store, registry: Registry | None = None) -> None:
        self.store = store
        self.registry = registry or Registry()
        self.dir = store.dir / LOCAL_DIR

    def _ensure(self) -> Path:
        return self_ignoring(self.dir, "Machine-local Agora state (instance id, copies, layout): never committed.")

    # ——— instance ———
    def instance(self) -> dict[str, Any] | None:
        d = _read_json(self.dir / "instance.json")
        return d if isinstance(d, dict) and d.get("instanceId") else None

    def instance_id(self) -> str:
        return (self.instance() or {}).get("instanceId") or ""

    def socket(self) -> str:
        iid = self.instance_id()
        return socket_name(iid) if iid else legacy_socket(self.store.root)

    def _write_instance(self, d: dict[str, Any]) -> None:
        self._ensure()
        _atomic_json(self.dir / "instance.json", d)

    def project_id(self) -> str:
        return str(self.store.info()["id"])

    def _ident(self) -> tuple[int, int] | None:
        try:
            st = os.stat(self.store.root)
        except OSError:
            return None
        return st.st_dev, st.st_ino

    def reconcile(self, *, migrate: bool = True, alive=None) -> dict[str, Any]:
        """Settle which copy this is; see the module docstring. Idempotent. Returns the change
        (``kind``: same / new / fresh / reattached / moved / copied), also kept in ``instance.json``
        as ``change`` until the page acknowledges it. ``alive(sid)``: whether a terminal pane still
        holds a session (a Pi log in use is not moved)."""
        root = str(self.store.root)
        pid = self.project_id()
        ident = self._ident()
        cur = self.instance()
        base = {"projectId": pid, "root": root, "dev": ident[0] if ident else None, "ino": ident[1] if ident else None}
        if cur is None:
            reused = self.registry.instance_at(pid, root)
            iid = reused or str(uuid.uuid4())
            ws = self.store.read_workspace_quiet()
            had_sessions = any(d.get("kind") == "session" for d in (ws or {}).get("docs") or [] if isinstance(d, dict))
            kind = "reattached" if reused else ("fresh" if had_sessions else "new")
            change = {"kind": kind, "at": now_ms()}
            self._write_instance({**base, "instanceId": iid, "createdAt": now_ms(), **({"change": change} if kind != "new" else {})})
            self.registry.append("instance", projectId=pid, instanceId=iid, root=root, reused=bool(reused) or None)
            return change
        iid = cur["instanceId"]
        if cur.get("root") == root:
            if ident and (cur.get("dev"), cur.get("ino")) != ident:
                self._write_instance({**cur, **base})  # same path, a new directory there: follow it
            return {"kind": "same"}
        old = str(cur.get("root") or "")
        other = _read_json(Path(old) / ".agora" / LOCAL_DIR / "instance.json") if old else None
        if old and Path(old).is_dir() and isinstance(other, dict) and other.get("instanceId") == iid and other.get("root") == old:
            return self._copied(cur, base, old)
        return self._moved(cur, base, old, migrate=migrate, alive=alive)

    def _copied(self, cur: dict[str, Any], base: dict[str, Any], old: str) -> dict[str, Any]:
        """``cp -r``: the original is still at ``old`` with the same instance. This copy gets its own
        id; the sessions it brought along stay read-only here until forked (never two copies
        resuming one native session)."""
        iid = str(uuid.uuid4())
        sids = sorted(self.store.bindings())
        at = now_ms()
        copies = {sid: {"from": old, "fromInstance": cur["instanceId"], "at": at} for sid in sids}
        self._ensure()
        _atomic_json(self.dir / "copies.json", {**self.copies(), **copies})
        change = {"kind": "copied", "from": old, "at": at, "sessions": sids}
        self._write_instance({**base, "instanceId": iid, "createdAt": at, "copiedFrom": {"root": old, "instanceId": cur["instanceId"]}, "change": change})
        self.registry.append("copy", projectId=base["projectId"], instanceId=iid, root=base["root"], fromInstance=cur["instanceId"], **{"from": old})
        return change

    def _moved(self, cur: dict[str, Any], base: dict[str, Any], old: str, *, migrate: bool, alive) -> dict[str, Any]:
        from server.canvas import agents

        migrated: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        for sid, b in sorted(self.store.bindings().items()) if migrate else []:
            if b.get("agent") != "pi" or not b.get("nativeId") or not old:
                continue
            look = agents.locate_log("pi", b["nativeId"], self.store.root)
            if look.state == "found":
                continue
            src = next((p for p in look.candidates if p.parent.name == agents.pi_dir_name(old)), None)
            if src is None:
                continue
            if alive is not None and alive(sid):
                failed.append({"sessionId": sid, "nativeId": b["nativeId"], "error": "终端里还开着这个会话：关掉终端后重新 `agora up`"})
                continue
            try:
                dst = agents.migrate_pi_log(src, self.store.root)
            except (OSError, ValueError) as e:
                # Moving failed: the next message forks the old log instead (a new native id, full history).
                self.store.set_fork(sid, b["nativeId"], str(src), reason="move-failed")
                failed.append({"sessionId": sid, "nativeId": b["nativeId"], "error": str(e), "fallback": "fork"})
                continue
            self.store.set_log(sid, str(dst))
            migrated.append({"sessionId": sid, "nativeId": b["nativeId"], "path": str(dst)})
            self.registry.append("rebind", projectId=base["projectId"], instanceId=cur["instanceId"], root=base["root"], sessionId=sid, agent="pi", nativeId=b["nativeId"], logPath=str(dst), reason="moved")
        change = {"kind": "moved", "from": old, "at": now_ms(), "migrated": migrated, "failed": failed}
        self._write_instance({**cur, **base, "change": change})
        self.registry.append("root", projectId=base["projectId"], instanceId=cur["instanceId"], root=base["root"], **{"from": old})
        return change

    def change(self) -> dict[str, Any] | None:
        """The move / copy / fresh-clone notice the page has not acknowledged yet."""
        return (self.instance() or {}).get("change")

    def ack(self) -> None:
        cur = self.instance()
        if cur and cur.get("change"):
            self._write_instance({k: v for k, v in cur.items() if k != "change"})

    # ——— sessions brought along by a copy ———
    def copies(self) -> dict[str, dict[str, Any]]:
        d = _read_json(self.dir / "copies.json")
        return d if isinstance(d, dict) else {}

    def drop_copy(self, sid: str) -> None:
        cur = self.copies()
        if sid in cur:
            cur.pop(sid)
            _atomic_json(self.dir / "copies.json", cur)

    # ——— names on this machine ———
    def historical_roots(self) -> list[str]:
        iid = self.instance_id()
        roots = self.registry.roots(self.project_id(), iid or None) if iid else []
        return [r for r in roots if r] or [str(self.store.root)]

    def legacy_sockets(self) -> list[str]:
        """Path-hash sockets older builds used for any root this instance has had."""
        return sorted({legacy_socket(r) for r in [*self.historical_roots(), str(self.store.root)]})

    # ——— registry shortcuts ———
    def note(self, t: str, **fields: Any) -> dict[str, Any] | None:
        try:
            return self.registry.append(t, projectId=self.project_id(), instanceId=self.instance_id() or None, root=str(self.store.root), **fields)
        except OSError:
            return None  # the registry is a backstop; a read-only state dir must not break the project


# ——— sessions listed in workspace.json that have no binding on this machine ———
def session_origins(store, local: Local) -> dict[str, dict[str, Any]]:
    """Why a listed session cannot simply be resumed here, per session id:

    - ``copy``: brought along by ``cp -r``; bound here, read-only until forked (``copies.json``);
    - ``recoverable``: the registry has its binding for this path (``.agora/sessions/`` was lost,
      e.g. ``git clean -fdx``): the binding can be restored as it was;
    - ``other-copy``: another copy of the project on this machine owns it (a second clone or
      worktree): it can be forked here;
    - ``foreign``: made on another machine (workspace.json says which agent, the registry knows
      nothing): shown read-only, no agent picker.

    Sessions with neither a binding nor any recorded agent (old workspace files) are left out:
    they still get the agent picker."""
    from server.canvas import agents

    ws = store.read_workspace_quiet() or {}
    bindings = store.bindings()
    out: dict[str, dict[str, Any]] = {}
    binds: dict[str, dict[str, Any]] | None = None
    for d in ws.get("docs") or []:
        if not isinstance(d, dict) or d.get("kind") != "session":
            continue
        sid = d.get("sessionId")
        if not isinstance(sid, str) or sid in bindings:
            continue
        if binds is None:
            binds = local.registry.binds(local.project_id())
        rec = binds.get(sid)
        listed = {k: d.get(k) for k in ("agent", "model", "effort", "nativeId", "canvasId", "topic") if d.get(k)}
        if rec is None:
            if listed.get("agent"):
                out[sid] = {"state": "foreign", **listed}
            continue
        src = {**listed, **{k: rec[k] for k in ("agent", "model", "effort", "nativeId", "started", "canvasId", "topic", "root") if rec.get(k) is not None}}
        other = rec.get("root")
        if other and other != str(store.root) and (Path(other) / ".agora" / "sessions" / f"{sid}.agent.json").exists():
            out[sid] = {"state": "other-copy", **src}
            continue
        look = agents.locate_log(src["agent"], src.get("nativeId"), store.root) if src.get("nativeId") else None
        out[sid] = {"state": "recoverable", **src, "log": look.state if look else None}
    for sid, c in local.copies().items():
        if sid in bindings:
            out[sid] = {"state": "copy", **c}
    return out
