"""Local safety nets outside the project, for what git does not hold or a mistake removes.

- **File versions** (``$AGORA_STATE_DIR/history/<project id>/<instance id>/<file>/<ms>``): before a
  canvas, a threads file or workspace.json is overwritten, its previous bytes are kept — at most one
  version per file every 10 minutes, the newest 50 and none older than 30 days. They survive
  ``git reset --hard``, ``git checkout -- .agora`` and an overwrite in the editor, for people who
  do not commit often.
- **Daily backups** (``$AGORA_STATE_DIR/backups/<project id>/<instance id>/<ms>.tar.gz``): the
  local-only part of ``.agora/`` — ``sessions/`` (canvas-change records, bindings, trajectory
  snapshots), ``trash/`` and ``local/`` — once a day (server start, then hourly checks), the
  newest 7 kept. ``git clean -fdx`` removes all three; ``agora restore`` puts back what is missing.

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
BACKUP_EVERY_S = 24 * 3600
BACKUPS_KEPT = 7
BACKED_UP = ("sessions", "trash", "local")


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

    def keep(self, rel: str, data: bytes) -> Path | None:
        """Called with a file's bytes just before they are replaced. Returns the kept version, or
        None when one was kept less than 10 minutes ago."""
        d = self._file_dir(rel)
        now = self.clock()
        have = self._stamps(d)
        if have and now * 1000 - have[-1] < VERSION_EVERY_S * 1000:
            return None
        d.mkdir(parents=True, exist_ok=True)
        path = d / str(int(now * 1000))
        path.write_bytes(data)
        cutoff = (now - VERSION_DAYS * 86400) * 1000
        stamps = [*have, int(now * 1000)]
        for old in stamps[: max(0, len(stamps) - VERSIONS_KEPT)] + [s for s in stamps if s < cutoff]:
            (d / str(old)).unlink(missing_ok=True)
        return path

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
        present = [n for n in BACKED_UP if (self.store.dir / n).is_dir()]
        if not present:
            return None
        self.dir.mkdir(parents=True, exist_ok=True)
        at = int(self.clock() * 1000)
        path = self.dir / f"{at}.tar.gz"
        tmp = path.with_name(f".{path.name}.tmp")
        with tarfile.open(tmp, "w:gz") as tar:
            for n in present:
                tar.add(self.store.dir / n, arcname=n)
        os.replace(tmp, path)
        for old in self.list()[BACKUPS_KEPT:]:
            Path(old["path"]).unlink(missing_ok=True)
        return {"at": at, "path": str(path), "size": path.stat().st_size}

    def restore(self, at: int | None = None, *, overwrite: bool = False) -> list[str]:
        """Put files from a backup (the newest by default) back into ``.agora/``: only the missing
        ones, unless ``overwrite``. Returns what was written (relative to ``.agora/``)."""
        backups = self.list()
        pick = next((b for b in backups if at is None or b["at"] == at), None)
        if pick is None:
            raise FileNotFoundError(f"no backup{'' if at is None else f' at {at}'} in {self.dir}")
        written = []
        with tarfile.open(pick["path"], "r:gz") as tar:
            for m in tar.getmembers():
                rel = Path(m.name)
                if rel.is_absolute() or ".." in rel.parts or rel.parts[0] not in BACKED_UP or not m.isfile():
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

