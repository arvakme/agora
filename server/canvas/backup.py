"""Local safety nets outside the project, for what git does not hold or a mistake removes.

- **File versions** (``$AGORA_STATE_DIR/history/<project id>/<instance id>/<file>/<ms>``): before a
  canvas, a threads file or workspace.json is overwritten, its previous bytes are kept — at most one
  version per file every 10 minutes, the newest 50 and none older than 30 days, 200MB per copy of
  the project at most (oldest first). Each version is what the file held *before* a write at that
  time (the current content is the file itself). Versions of a file that no longer exists (a
  deleted canvas) stay 30 days after their newest one; directories of earlier instances go after
  30 days without a write. They survive ``git reset --hard``, ``git checkout -- .agora`` and an
  overwrite in the editor, for people who do not commit often.
- **Daily backups** (``$AGORA_STATE_DIR/backups/<project id>/<instance id>/<ms>.tar.gz``): the
  local-only part of ``.agora/`` — ``sessions/`` (canvas-change records, bindings, trajectory
  snapshots), ``trash/`` and ``local/`` — once a day (server start, then hourly checks), the
  newest 7 kept and 500MB in all at most. When the three directories hold more than 200MB,
  trajectory snapshots are left out of that backup (largest first). ``git clean -fdx`` removes
  all three; ``agora restore`` puts back what is missing — but never a session or a trash item
  that was trashed, restored or deleted for good after the backup was taken (the registry says
  when), so a backup cannot bring back a second copy of a session.

Both live outside the repository on purpose: they must outlast the directory they protect.
Formats: web/docs/project-storage.md §2.
"""

from __future__ import annotations

import os
import tarfile
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from server.canvas.local import Local, state_dir

VERSION_EVERY_S = 600
VERSIONS_KEPT = 50
VERSION_DAYS = 30
HISTORY_MAX_BYTES = 200 * 1024 * 1024
BACKUP_EVERY_S = 24 * 3600
BACKUPS_KEPT = 7
BACKUPS_MAX_BYTES = 500 * 1024 * 1024
BACKUP_SOURCE_MAX = 200 * 1024 * 1024
BACKED_UP = ("sessions", "trash", "local")
DAY_MS = 86400 * 1000


def _session_of(rel: Path) -> str | None:
    """The session a backed-up file belongs to (``sessions/<id>.jsonl|.agent.json``, ``sessions/snapshots/<id>.jsonl``)."""
    parts = rel.parts
    if len(parts) == 2 and parts[0] == "sessions":
        name = parts[1]
        for suf in (".agent.json", ".jsonl"):
            if name.endswith(suf):
                return name.removesuffix(suf)
    if len(parts) == 3 and parts[:2] == ("sessions", "snapshots") and parts[2].endswith(".jsonl"):
        return parts[2].removesuffix(".jsonl")
    return None


def _key(local: Local) -> Path:
    return Path(local.project_id().replace("/", "_")) / (local.instance_id() or "no-instance")


class FileHistory:
    """Earlier versions of the committed files, kept outside the project."""

    def __init__(self, local: Local, *, clock: Callable[[], float] = time.time) -> None:
        self.local = local
        self.clock = clock

    @property
    def dir(self) -> Path:
        return state_dir() / "history" / _key(self.local)

    def _file_dir(self, rel: str) -> Path:
        return self.dir / rel.replace("/", "__")

    def keep(self, rel: str, data: bytes, *, force: bool = False) -> Path | None:
        """Called with a file's bytes just before they are replaced. Returns the kept version, or
        None when one was kept less than 10 minutes ago (``force``: keep it anyway — restoring an
        old version must never lose the one it replaces)."""
        d = self._file_dir(rel)
        now = self.clock()
        have = self._stamps(d)
        if have and now * 1000 - have[-1] < VERSION_EVERY_S * 1000 and not force:
            return None
        d.mkdir(parents=True, exist_ok=True)
        stamp = max(int(now * 1000), (have[-1] + 1) if have else 0)
        path = d / str(stamp)
        path.write_bytes(data)
        have = [*have, stamp]
        cutoff = (now - VERSION_DAYS * 86400) * 1000
        for old in have[: max(0, len(have) - VERSIONS_KEPT)] + [s for s in have if s < cutoff]:
            (d / str(old)).unlink(missing_ok=True)
        self._cap()
        return path

    def _cap(self) -> None:
        """At most HISTORY_MAX_BYTES for this copy of the project: the oldest versions go first."""
        if not self.dir.is_dir():
            return
        files = sorted((int(f.name), f) for d in self.dir.iterdir() if d.is_dir() for f in d.iterdir() if f.name.isdigit())
        total = sum(f.stat().st_size for _, f in files)
        for _, f in files:
            if total <= HISTORY_MAX_BYTES:
                break
            total -= f.stat().st_size
            f.unlink(missing_ok=True)

    def prune(self, existing: set[str]) -> list[str]:
        """Housekeeping (hourly, with the trash sweep): versions of files that no longer exist once
        their newest version is 30 days old, and whole directories of other instances of this
        project with nothing written for 30 days. Returns what went."""
        import shutil

        gone = []
        cutoff = self.clock() * 1000 - VERSION_DAYS * DAY_MS
        if self.dir.is_dir():
            for d in self.dir.iterdir():
                rel = d.name.replace("__", "/")
                stamps = self._stamps(d)
                if d.is_dir() and rel not in existing and (not stamps or stamps[-1] < cutoff):
                    shutil.rmtree(d, ignore_errors=True)
                    gone.append(rel)
        project = self.dir.parent
        for inst in project.iterdir() if project.is_dir() else []:
            if inst == self.dir or not inst.is_dir():
                continue
            newest = max((f.stat().st_mtime for f in inst.rglob("*") if f.is_file()), default=0)
            if newest * 1000 < cutoff:
                shutil.rmtree(inst, ignore_errors=True)
                gone.append(inst.name)
        return gone

    @staticmethod
    def _stamps(d: Path) -> list[int]:
        return sorted(int(p.name) for p in d.glob("*") if p.name.isdigit()) if d.is_dir() else []

    def files(self) -> list[str]:
        return sorted(p.name.replace("__", "/") for p in self.dir.glob("*") if p.is_dir()) if self.dir.is_dir() else []

    def versions(self, rel: str) -> list[dict[str, Any]]:
        d = self._file_dir(rel)
        return [{"at": s, "size": (d / str(s)).stat().st_size, "path": str(d / str(s))} for s in reversed(self._stamps(d))]

    def read(self, rel: str, at: int) -> bytes:
        return (self._file_dir(rel) / str(int(at))).read_bytes()


class Backups:
    """Daily tarballs of the local-only part of ``.agora/``."""

    def __init__(self, store, local: Local, *, clock: Callable[[], float] = time.time) -> None:
        self.store = store
        self.local = local
        self.clock = clock

    @property
    def dir(self) -> Path:
        return state_dir() / "backups" / _key(self.local)

    def list(self) -> list[dict[str, Any]]:
        if not self.dir.is_dir():
            return []
        out = [{"at": int(p.name.removesuffix(".tar.gz")), "path": str(p), "size": p.stat().st_size} for p in self.dir.glob("*.tar.gz") if p.name.removesuffix(".tar.gz").isdigit()]
        return sorted(out, key=lambda b: -b["at"])

    def due(self) -> bool:
        last = self.list()
        return not last or self.clock() * 1000 - last[0]["at"] >= BACKUP_EVERY_S * 1000

    def make(self, *, force: bool = False) -> dict[str, Any] | None:
        """Back up ``sessions/``, ``trash/`` and ``local/`` if a day has passed (or ``force``)."""
        if not force and not self.due():
            return None
        files = [f for n in BACKED_UP if (self.store.dir / n).is_dir() for f in sorted((self.store.dir / n).rglob("*")) if f.is_file() and not f.is_symlink()]
        if not files:
            return None
        # Over the source cap: leave the (largest) trajectory snapshots out of this backup.
        skipped: list[str] = []
        total = sum(f.stat().st_size for f in files)
        snaps = sorted((f for f in files if f.parent.name == "snapshots"), key=lambda f: -f.stat().st_size)
        for f in snaps:
            if total <= BACKUP_SOURCE_MAX:
                break
            total -= f.stat().st_size
            skipped.append(str(f.relative_to(self.store.dir)))
        self.dir.mkdir(parents=True, exist_ok=True)
        at = int(self.clock() * 1000)
        path = self.dir / f"{at}.tar.gz"
        tmp = path.with_name(f".{path.name}.tmp")
        with tarfile.open(tmp, "w:gz") as tar:
            for f in files:
                rel = str(f.relative_to(self.store.dir))
                if rel not in skipped:
                    tar.add(f, arcname=rel)
        os.replace(tmp, path)
        kept = self.list()
        size = 0
        for i, b in enumerate(kept):  # newest first: the newest always stays
            size += b["size"]
            if i >= BACKUPS_KEPT or (i > 0 and size > BACKUPS_MAX_BYTES):
                Path(b["path"]).unlink(missing_ok=True)
        return {"at": at, "path": str(path), "size": path.stat().st_size, "skipped": skipped}

    def _later_events(self, since: int) -> tuple[set[str], set[str]]:
        """Sessions and trash items trashed, restored or deleted for good after ``since``."""
        sessions: set[str] = set()
        items: set[str] = set()
        for e in self.local.registry.events(self.local.project_id(), ("trash", "restore", "purge")):
            if (e.get("at") or 0) <= since:
                continue
            if e.get("sessionId"):
                sessions.add(e["sessionId"])
            if e.get("trashId"):
                items.add(e["trashId"])
        return sessions, items

    def restore(self, at: int | None = None, *, overwrite: bool = False, sessions: set[str] | None = None) -> list[str]:
        """Put files from a backup (the newest by default) back into ``.agora/``: only the missing
        ones, unless ``overwrite``. ``sessions``: only these sessions' files (nothing from the trash
        or ``local/``). Never a session that is in the trash now, nor a session or trash item that
        was trashed, restored or deleted for good after the backup — that would make two Agora
        sessions of one native session. Returns what was written (relative to ``.agora/``)."""
        from server.canvas.trash import Trash

        backups = self.list()
        pick = next((b for b in backups if at is None or b["at"] == at), None)
        if pick is None:
            raise FileNotFoundError(f"no backup{'' if at is None else f' at {at}'} in {self.dir}")
        later_sessions, later_items = self._later_events(pick["at"])
        trashed = {m["id"] for m in Trash(self.store).list() if m["kind"] == "session"}
        written = []
        with tarfile.open(pick["path"], "r:gz") as tar:
            for m in tar.getmembers():
                rel = Path(m.name)
                if rel.is_absolute() or ".." in rel.parts or rel.parts[0] not in BACKED_UP or not m.isfile():
                    continue
                sid = _session_of(rel)
                if sid is not None:
                    if (sessions is not None and sid not in sessions) or sid in trashed or sid in later_sessions:
                        continue
                elif sessions is not None:
                    continue
                elif rel.parts[0] == "trash" and (len(rel.parts) < 3 or rel.parts[1] in later_items):
                    continue
                dst = self.store.dir / rel
                if dst.exists() and not overwrite:
                    continue
                src = tar.extractfile(m)
                if src is None:
                    continue
                data = src.read()
                dst.parent.mkdir(parents=True, exist_ok=True)
                self.store._atomic(dst, data)
                written.append(str(rel))
        return written

