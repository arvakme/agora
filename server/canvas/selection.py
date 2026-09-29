"""The selection sent with a chat message, kept as a picture.

``<project>/.agora/local/selections/<id>/`` holds ``meta.json`` (the canvas and the selected elements' names and
ids), ``thumb.svg`` (what the page draws under the message: Excalidraw's ``exportToSvg`` of just those elements;
absent when the page could not draw it) and ``selection.png`` (what a CLI that takes images is given; absent when the
page could not make one). The message's
footer names it by ``agora-sel-<id>`` (``agora_msg.py``), so the picture belongs to that message for good: it
survives a reload, a restart and the elements changing later. ``local/`` is per machine and never committed.

Nothing deletes a selection: each is a few tens of KB (svg at most ``SVG_MAX``, png at most ``PNG_MAX``).
"""

from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path
from typing import Any

from server.canvas.project import ProjectStore

SVG_MAX = 1_500_000  # bytes; an svg with big embedded images is refused, the page then sends the words only
PNG_MAX = 3_000_000
ID_RE = re.compile(r"sel-[0-9a-f]{10}")


class Selections:
    def __init__(self, project_dir: Path) -> None:
        self.dir = project_dir / "local" / "selections"

    def _folder(self, id: str) -> Path | None:
        return self.dir / id if ID_RE.fullmatch(id) else None

    def save(self, *, canvas_id: str, elements: list[dict[str, str]], svg: str, png: bytes | None) -> dict[str, Any]:
        if len(svg.encode()) > SVG_MAX or (png is not None and len(png) > PNG_MAX):
            raise ValueError("选区的图太大，没有保存")
        id = f"sel-{secrets.token_hex(5)}"
        folder = self.dir / id
        meta = {"id": id, "canvasId": canvas_id, "elements": elements, "at": int(time.time() * 1000), "hasThumb": bool(svg), "hasImage": png is not None}
        if svg:  # the page could not draw one: the record then is the names only
            ProjectStore._atomic(folder / "thumb.svg", svg.encode())
        if png is not None:
            ProjectStore._atomic(folder / "selection.png", png)
        ProjectStore._atomic(folder / "meta.json", json.dumps(meta, ensure_ascii=False).encode())  # last: a folder without it is not a selection
        return meta

    def read(self, id: str) -> dict[str, Any] | None:
        folder = self._folder(id)
        try:
            return json.loads((folder / "meta.json").read_text()) if folder else None
        except (OSError, ValueError):
            return None

    def svg(self, id: str) -> str | None:
        folder = self._folder(id)
        try:
            return (folder / "thumb.svg").read_text() if folder and self.read(id) and (folder / "thumb.svg").is_file() else None
        except OSError:
            return None

    def png_path(self, id: str) -> Path | None:
        folder = self._folder(id)
        p = folder / "selection.png" if folder else None
        return p if p is not None and p.is_file() and self.read(id) else None
