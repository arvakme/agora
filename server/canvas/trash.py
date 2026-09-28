"""The trash: deleting a canvas or a session moves its files into ``.agora/trash/`` instead of
removing them, so it can be restored after a reload or a restart, for 30 days.

One directory per deleted item, ``trash/<time>-<kind>-<id>/``, holding the moved files under their
own names plus ``manifest.json``:

    {trashId, kind, id, at, title, entry, place, files: [{rel, name}], linked, sharesEnded, native}

- ``entry`` / ``place``: the workspace.json entry and where its tab was (the page sends them, it
  owns workspace.json); restoring hands them back so the page puts it where it was.
- canvas: ``canvases/<id>.excalidraw`` and ``threads/<id>.json`` (code paths of the progress pointer
  live in the scene, so they come back with it). Its sessions stay where they are.
- session: ``sessions/<id>.jsonl`` / ``.agent.json``, its trajectory snapshot ``sessions/snapshots/<id>.jsonl``
  and ``run/usage/<id>.jsonl``.
  The binding goes with it, so restoring re-follows the same native session — never a new one.
  The native log itself is never touched (``native`` says where it is).

Files are moved with ``os.rename`` under the project's write lock; the manifest is written first
(listing what will move), so a crash half-way leaves an item that restore can still finish.
Nothing here is committed (the directory ignores itself); ``git clean -fdx`` removes it, which is
what the backups outside the project cover. Format: web/docs/project-storage.md §1.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from server.canvas.local import self_ignoring
from server.canvas.project import ID_RE, ProjectStore, check_id, dump_json

TRASH_DIR = "trash"
KEEP_DAYS = 30
KINDS = ("canvas", "session")
TRASH_ID = re.compile(r"^\d{13}-(canvas|session)-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class TrashError(ValueError):
    pass


def _files(kind: str, id: str) -> list[str]:
    """What an item consists of, relative to ``.agora/``."""
    if kind == "canvas":
        return [f"canvases/{id}.excalidraw", f"threads/{id}.json"]
    return [f"sessions/{id}.jsonl", f"sessions/{id}.agent.json", f"sessions/snapshots/{id}.jsonl", f"run/usage/{id}.jsonl"]


class Trash:
    def __init__(self, store: ProjectStore, *, clock: Callable[[], float] = time.time, keep_days: int = KEEP_DAYS) -> None:
        self.store = store
        self.clock = clock
        self.keep_ms = keep_days * 24 * 3600 * 1000
        self.dir = store.dir / TRASH_DIR

    def _now(self) -> int:
        return int(self.clock() * 1000)

    def _item_dir(self, trash_id: str) -> Path:
        if not TRASH_ID.match(trash_id):
            raise TrashError(f"invalid trash id {trash_id!r}")
        return self.dir / trash_id

    def _manifest(self, d: Path) -> dict[str, Any] | None:
        try:
            m = json.loads((d / "manifest.json").read_text())
        except (OSError, ValueError):
            return None
        return m if isinstance(m, dict) and m.get("trashId") == d.name else None

    def _public(self, m: dict[str, Any]) -> dict[str, Any]:
        left = m["at"] + self.keep_ms - self._now()
        return {**m, "expiresAt": m["at"] + self.keep_ms, "daysLeft": max(0, -(-left // (24 * 3600 * 1000)))}

    # ——— read ———
    def list(self) -> list[dict[str, Any]]:
        """Items, newest first, each with ``expiresAt`` / ``daysLeft``."""
        out = []
        for d in self.dir.glob("*") if self.dir.is_dir() else []:
            if d.is_dir() and (m := self._manifest(d)) is not None:
                out.append(self._public(m))
        return sorted(out, key=lambda m: -m["at"])

    def get(self, trash_id: str) -> dict[str, Any]:
        m = self._manifest(self._item_dir(trash_id))
        if m is None:
            raise KeyError(trash_id)
        return self._public(m)

    def find(self, kind: str, id: str) -> dict[str, Any] | None:
        """The newest trashed item for this canvas / session, if any."""
        return next((m for m in self.list() if m["kind"] == kind and m["id"] == id), None)

    # ——— move in ———
    def put(self, kind: str, id: str, *, title: str = "", entry: dict[str, Any] | None = None, place: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
        """Move a canvas (scene + threads) or a session (record, binding, snapshot, usage) into the
        trash. Nothing to move → ``KeyError``."""
        if kind not in KINDS:
            raise TrashError(f"kind must be one of {KINDS}")
        check_id(id)
        rels = [r for r in _files(kind, id) if (self.store.dir / r).exists()]
        if not rels and entry is None:
            raise KeyError(f"{kind} {id}")
        at = self._now()
        trash_id = f"{at}-{kind}-{id}"
        with self.store._locked():
            d = self_ignoring(self.dir, "Deleted canvases and sessions, kept 30 days (local only).") / trash_id
            d.mkdir()
            files = [{"rel": r, "name": r.replace("/", "__")} for r in rels]
            m = {"trashId": trash_id, "kind": kind, "id": id, "at": at, "title": title, "entry": entry, "place": place, "files": files, **extra}
            self.store._atomic(d / "manifest.json", dump_json(m))  # first: a crash below leaves a restorable item
            for f in files:
                os.rename(self.store.dir / f["rel"], d / f["name"])
        return self._public(m)

    # ——— move out ———
    def restore(self, trash_id: str) -> dict[str, Any]:
        """Put the item's files back. An id taken meanwhile (the same canvas id came back through
        git, say) is never overwritten: the item comes back under a free id ``<id>-r<n>``, and the
        manifest's ``entry`` is rewritten to match. Returns the manifest with the final ``id``."""
        d = self._item_dir(trash_id)
        with self.store._locked():
            m = self._manifest(d)
            if m is None:
                raise KeyError(trash_id)
            kind, orig = m["kind"], m["id"]
            here = [f for f in m["files"] if (d / f["name"]).exists()]  # a crash may have left some where they were

            def target(rel: str, id: str) -> Path:
                return self.store.dir / (rel if id == orig else _files(kind, id)[_files(kind, orig).index(rel)])

            new = orig
            n = 1
            while any(target(f["rel"], new).exists() for f in here):
                new = f"{orig}-r{n}"
                n += 1
            for f in here:
                src = d / f["name"]
                dst = target(f["rel"], new)
                dst.parent.mkdir(parents=True, exist_ok=True)
                os.rename(src, dst)
            shutil.rmtree(d)
        entry = m.get("entry")
        if new != orig and isinstance(entry, dict):
            entry = {**entry, "id": f"p-{new}" if kind == "session" else new, **({"sessionId": new} if kind == "session" else {})}
        return {**m, "id": new, "originalId": orig, "entry": entry}

    def purge(self, trash_id: str) -> dict[str, Any]:
        """Delete for good (the native log of a session is not touched)."""
        d = self._item_dir(trash_id)
        with self.store._locked():
            m = self._manifest(d)
            if m is None:
                raise KeyError(trash_id)
            shutil.rmtree(d)
        return m

    def sweep(self) -> list[dict[str, Any]]:
        """Delete items older than the keep period. Returns what went."""
        gone = []
        for m in self.list():
            if self._now() - m["at"] >= self.keep_ms:
                try:
                    gone.append(self.purge(m["trashId"]))
                except KeyError:
                    continue
        return gone


def canvas_sessions(store: ProjectStore, canvas_id: str) -> list[str]:
    """Sessions whose record links them to this canvas."""
    out = []
    for p in sorted((store.dir / "sessions").glob("*.jsonl")):
        sid = p.name.removesuffix(".jsonl")
        if not ID_RE.match(sid):
            continue
        head = (store.read_session(sid) or ({}, ""))[0].get("session") or {}
        if head.get("canvasId") == canvas_id:
            out.append(sid)
    return out
