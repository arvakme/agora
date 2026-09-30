"""The construction log: every save of a canvas, as the elements it added, changed and removed.

``.agora/buildlog/<canvasId>.jsonl`` — one JSON line per record, append-only in spirit, committed with
the canvas (someone who clones the project can replay how it was built). Format and rules:
web/docs/share-build-replay.md §3.

    {"t": ms, "base": [element…], "legacy": bool}      first line: the canvas as the log found it
    {"t": ms, "g": [{"by": {"kind": "agent", "agent": "claude"} | {"kind": "you"},
                     "put": [element…], "del": [id…]}]}   one line per save

* ``base``: the starting picture. The first write of a canvas file *is* its start (the sample diagram,
  an imported canvas, a blank page); a canvas that already existed when the log began (an older
  project) has ``legacy: true`` — how it got there is reconstructed from the sessions, not logged.
* ``put``: elements new or changed since the previous record, whole (an element is a few hundred bytes);
  a deleted element is a ``put`` with ``isDeleted`` (or a ``del`` when it left the file).
* ``by``: who made it. Agent changes are recognised by the (element id, version) the agent's batch
  recorded (``sessions/*.jsonl``); the batch usually reaches the server just after the save, so it is
  filled in then (:func:`attribute_batches`). Everything else is the person's.
* What is never in it: ``customData`` (code paths of the progress pointer, library metadata; only the
  link to a child canvas stays), the session, the request, the reply, the command, any token. ``updated``,
  ``version`` and ``versionNonce`` alone are not a change.

Size: saves less than ``MERGE_MS`` apart by the same maker are one record. When the history (all but the starting picture) is past ``SOFT_BYTES`` the older
records (all but the last ``KEEP_TAIL``) are merged by the same maker within one minute, then within ten;
still too big → they are folded into the starting picture (the history before it is gone, ``folded: true``).
"""

from __future__ import annotations

import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

DIR = "buildlog"
MERGE_MS = 1000
SOFT_BYTES = 1_000_000
KEEP_TAIL = 400
BUCKETS_MS = (60_000, 600_000)
#: A batch that arrives after its save is looked for in the log files touched this recently, this many records deep.
BACKFILL_MS = 10 * 60_000
BACKFILL_DEPTH = 60
#: Changes to an element that are not changes to what it shows.
NOISE = frozenset({"updated", "version", "versionNonce", "index"})

Element = dict[str, Any]
Record = dict[str, Any]
YOU: dict[str, Any] = {"kind": "you"}


def now_ms() -> int:
    return int(time.time() * 1000)


def path_of(store_dir: Path, cid: str) -> Path:
    return store_dir / DIR / f"{cid}.jsonl"


def clean(e: Element) -> Element:
    """An element as the log keeps it: without ``customData`` bar the link to a child canvas."""
    out = {k: v for k, v in e.items() if k != "customData"}
    child = (e.get("customData") or {}).get("childCanvas")
    if isinstance(child, str) and child:
        out["customData"] = {"childCanvas": child}
    return out


def _same(a: Element, b: Element) -> bool:
    return {k: v for k, v in a.items() if k not in NOISE} == {k: v for k, v in b.items() if k not in NOISE}


def _by_id(elements: list[Any]) -> dict[str, Element]:
    return {e["id"]: e for e in elements if isinstance(e, dict) and isinstance(e.get("id"), str)}


def diff(before: dict[str, Element], after: dict[str, Element]) -> tuple[list[Element], list[str]]:
    put = [e for i, e in after.items() if i not in before or not _same(before[i], e)]
    return put, [i for i in before if i not in after]


def apply(state: dict[str, Element], group: dict[str, Any]) -> None:
    for e in group.get("put") or []:
        state[e["id"]] = e
    for i in group.get("del") or []:
        state.pop(i, None)


def parse(raw: bytes | None) -> list[Record]:
    """The records of a log file; a line that is not a record (a torn write, a hand edit) is skipped."""
    out: list[Record] = []
    for line in (raw or b"").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and isinstance(rec.get("t"), int) and ("base" in rec or isinstance(rec.get("g"), list)):
            out.append(rec)
    return out


def dump(records: list[Record]) -> bytes:
    return b"".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")).encode() + b"\n" for r in records)


def read(store_dir: Path, cid: str) -> list[Record]:
    try:
        return parse(path_of(store_dir, cid).read_bytes())
    except OSError:
        return []


def write(store_dir: Path, cid: str, records: list[Record]) -> None:
    """Put a whole log in place (an imported one)."""
    _atomic(path_of(store_dir, cid), dump(records))


def state_of(records: list[Record]) -> dict[str, Element]:
    """The canvas as the log has it after every record."""
    state: dict[str, Element] = {}
    for r in records:
        if "base" in r:
            state = _by_id(r["base"])
        for g in r.get("g") or []:
            apply(state, g)
    return state


def _atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


# ——— writing ———


def _merge_groups(into: dict[str, Any], g: dict[str, Any]) -> None:
    put = _by_id(into.get("put") or [])
    put.update(_by_id(g.get("put") or []))
    dels = [i for i in [*(into.get("del") or []), *(g.get("del") or [])] if i not in put]
    into["put"] = list(put.values())
    into["del"] = list(dict.fromkeys(dels))
    if not into["del"]:
        del into["del"]


def _one_maker(rec: Record) -> dict[str, Any] | None:
    gs = rec.get("g") or []
    return gs[0]["by"] if len(gs) == 1 and "base" not in rec else None


def record_save(store_dir: Path, cid: str, before: bytes | None, after: bytes, *, versions: dict[tuple[str, int], str], now: int | None = None) -> None:
    """Log one save of canvas ``cid`` (``before``/``after``: the canvas file's bytes; ``versions``: which agent made which element version)."""
    now = now_ms() if now is None else now
    try:
        new = _by_id(json.loads(after).get("elements") or [])
    except (ValueError, AttributeError):
        return
    path = path_of(store_dir, cid)
    log = parse(_read_bytes(path))
    if not log:
        # the first write of a file is its start; a file that was already there is a project older than the log
        try:
            old = _by_id(json.loads(before).get("elements") or []) if before else None
        except (ValueError, AttributeError):
            old = None
        first = {"t": now, "base": [clean(e) for e in (old if old is not None else new).values()]}
        if old is not None:
            first["legacy"] = True
        log = [first]
        if old is None:
            _atomic(path, dump(log))
            return
    seen = state_of(log)
    put, gone = diff(seen, {i: clean(e) for i, e in new.items()})
    if not put and not gone:
        if log and not path.exists():
            _atomic(path, dump(log))
        return
    groups: dict[str, dict[str, Any]] = {}
    made = makers(put, versions)
    for e in put:
        by = {"kind": "agent", "agent": made[e["id"]]} if made.get(e["id"]) else YOU
        groups.setdefault(json.dumps(by, sort_keys=True), {"by": by, "put": [], "del": []})["put"].append(e)
    if gone:
        groups.setdefault(json.dumps(YOU, sort_keys=True), {"by": YOU, "put": [], "del": []})["del"] = gone
    rec: Record = {"t": now, "g": [{k: v for k, v in g.items() if v or k == "by"} for g in groups.values()]}
    last = log[-1]
    mine = _one_maker(rec)
    if len(rec["g"]) == 1 and mine == _one_maker(last) and now - int(last["t"]) < MERGE_MS:
        _merge_groups(last["g"][0], rec["g"][0])
        last["t"] = now
    else:
        log.append(rec)
    _atomic(path, dump(compact(log) if _over(log) else log))


def _read_bytes(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def makers(put: list[Element], versions: dict[tuple[str, int], str]) -> dict[str, str | None]:
    """The agent that made each element of a save, by the version its batch recorded; the text inside a shape goes with the shape."""
    made: dict[str, str | None] = {e["id"]: versions.get((e["id"], int(e.get("version") or 0))) for e in put}
    for e in put:
        if not made[e["id"]] and made.get(e.get("containerId") or ""):
            made[e["id"]] = made[e["containerId"]]
    return made


# ——— attribution that arrives late ———


def attribute_batches(store_dir: Path, agent: str, pairs: list[tuple[str, int]], *, now: int | None = None) -> int:
    """A batch of ``agent`` reached the server: the saves it was part of, if they were filed under the person, are the agent's. Returns how many elements moved."""
    now = now_ms() if now is None else now
    wanted = set(pairs)
    moved = 0
    d = store_dir / DIR
    if not wanted or not d.is_dir():
        return 0
    for p in d.glob("*.jsonl"):
        try:
            if now - int(p.stat().st_mtime * 1000) > BACKFILL_MS:
                continue
        except OSError:
            continue
        log = parse(_read_bytes(p))
        changed = 0
        for rec in log[-BACKFILL_DEPTH:]:
            gs = rec.get("g") or []
            mine = next((g for g in gs if g["by"] == YOU), None)
            if mine is None:
                continue
            put = mine.get("put") or []
            versions = {p: agent for p in wanted}
            made = makers(put, versions)
            hit = [e for e in put if made[e["id"]]]
            if not hit:
                continue
            ids = {e["id"] for e in hit}
            mine["put"] = [e for e in mine["put"] if e["id"] not in ids]
            target = {"kind": "agent", "agent": agent}
            theirs = next((g for g in gs if g["by"] == target), None)
            if theirs is None:
                theirs = {"by": target, "put": []}
                gs.insert(0, theirs)
            theirs["put"].extend(hit)
            rec["g"] = [g for g in gs if g.get("put") or g.get("del")]
            changed += len(hit)
        if changed:
            log = [r for r in log if r.get("g") != [] or "base" in r]
            _atomic(p, dump(log))
            moved += changed
    return moved


# ——— size ———


def _over(log: list[Record]) -> bool:
    """The history (everything after the starting picture) is past ``SOFT_BYTES``."""
    return sum(len(dump([r])) for r in log[1:]) > SOFT_BYTES


def compact(log: list[Record]) -> list[Record]:
    """Bring the history of a log under ``SOFT_BYTES`` by the rules in the module doc."""
    head, tail = log[:1], log[1:]
    keep = tail[-KEEP_TAIL:] if len(tail) > KEEP_TAIL else []
    old = tail[: len(tail) - len(keep)]
    if not old:
        return log
    for bucket in BUCKETS_MS:
        old = _bucket(old, bucket)
        out = head + old + keep
        if not _over(out):
            return out
    state = state_of(head + old)
    return [{"t": head[0]["t"], "base": list(state.values()), "folded": True, **({"legacy": True} if head[0].get("legacy") else {})}, *keep]


def _bucket(records: list[Record], ms: int) -> list[Record]:
    out: list[Record] = []
    start = 0
    for rec in records:
        prev = out[-1] if out else None
        if prev is not None and _one_maker(rec) is not None and _one_maker(rec) == _one_maker(prev) and int(rec["t"]) - start < ms:
            _merge_groups(prev["g"][0], rec["g"][0])
            prev["t"] = rec["t"]
            continue
        out.append(rec)
        start = int(rec["t"])
    return out
