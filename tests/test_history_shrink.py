"""A write that empties a canvas or drops half of it leaves the earlier version in the local
history even inside the history's 10-minute gap (a canvas emptied minutes after an earlier
write had no version to restore)."""

from server.canvas.backup import FileHistory
from server.canvas.local import Local
from server.canvas.project import ProjectStore


def test_a_write_that_empties_or_halves_a_canvas_always_keeps_the_old_version(tmp_path):
    store = ProjectStore(tmp_path / "proj")
    store.init()
    Local(store).reconcile()
    now = [1_800_000_000.0]
    h = FileHistory(Local(store), clock=lambda: now[0])
    store.on_overwrite = h.keep
    four = [{"id": f"e{i}"} for i in range(4)]
    store.write("canvas", "c1", {"elements": four}, base=None)
    store.write("canvas", "c1", {"elements": [*four, {"id": "e4"}]}, base=None, force=True)  # keeps the first version
    kept = len(h.versions("canvases/c1.excalidraw"))
    store.write("canvas", "c1", {"elements": [{"id": "e0"}, {"id": "e1"}, {"id": "e2"}, {"id": "e3"}]}, base=None, force=True)  # small change, inside the 10 minutes: not kept
    assert len(h.versions("canvases/c1.excalidraw")) == kept
    before = (store.dir / "canvases" / "c1.excalidraw").read_bytes()
    store.write("canvas", "c1", {"elements": [{"id": "e0"}]}, base=None, force=True)  # 4 → 1, seconds later
    assert h.read("canvases/c1.excalidraw", h.versions("canvases/c1.excalidraw")[0]["at"]) == before
    before = (store.dir / "canvases" / "c1.excalidraw").read_bytes()
    store.write("canvas", "c1", {"elements": []}, base=None, force=True)  # 1 → 0
    assert h.read("canvases/c1.excalidraw", h.versions("canvases/c1.excalidraw")[0]["at"]) == before
