"""How a canvas was built, step by step (web/docs/share-build-replay.md).

Two sources, one timeline:

* **The construction log** (``.agora/buildlog/<canvas>.jsonl``, buildlog.py): every save of the canvas as the
  elements it added, changed and removed, with who made them. From the moment a project has one, this is
  the history: it is replayed forwards from the starting picture, and each record is described in the
  canvas's own words (:func:`_describe`).
* **The sessions**, for what came before the log (a project older than it, ``legacy``) and nothing else.
  ``sessions/<id>.jsonl`` records every change an agent made through the page (``agora canvas
  apply | link | child``) as a *turn* (when, which session) plus a *batch*: the elements the change touched
  as they were **before** it (``None`` = did not exist) and their versions after it. Walking the canvas
  backwards through the batches (put each batch's "before" back) gives the canvas as it was before every
  batch; walking forward again gives what each batch produced. Elements no batch ever touched are the
  person's (or the starter diagram's): they carry ``updated``. A person's edit to something an agent also
  touched shows as a version that does not follow on: a step of theirs, without a picture of how it looked.

The whole of it is told, to the owner and to a guest of a share that allows it: what was drawn, changed,
moved, renamed, deleted and drawn again. A guest's clock is the order and the gaps, not the time of day.

What leaves here is what a guest of the canvas could see anyway: element shapes and text
(``share.guest_elements``: no ``customData`` but the child link), the agent's kind and name, and
sentences written from the canvas's own words. Never a request, a step title, a session id, a code
path, a command or a reply text: those stay in the session files this reads.
"""

from __future__ import annotations

from typing import Any

from server.canvas import buildlog, nested
from server.canvas.adapters import registry
from server.canvas.model_view import bound_text, child_canvas, code_paths, label_of, library_meta
from server.canvas.project import ProjectStore
from server.canvas.share import canvas_titles, guest_elements

FORMAT = "agora-build-timeline"
VERSION = 1
#: A guest never gets more than this many steps or elements from one canvas tree.
MAX_STEPS = 5000
#: Edits by the person this close together (ms) are one step (drawn from the log); the older reading uses a longer gap.
HUMAN_GAP_MS = 10_000
LEGACY_GAP_MS = 30_000
NODE_TYPES = frozenset({"rectangle", "ellipse", "diamond", "frame", "image", "embeddable"})
ARROW_TYPES = frozenset({"arrow", "line"})
#: How many names a sentence lists before it says "…等 n 个".
LISTED = 3

Element = dict[str, Any]


def _alive(e: Element | None) -> bool:
    return e is not None and not e.get("isDeleted")


def _quote(s: str) -> str:
    return f"「{s}」" if s else "一个元素"


class _Scene:
    """Elements by id (all versions ever needed), for labels: a step's own elements first, then the latest."""

    def __init__(self, *layers: dict[str, Element | None]) -> None:
        self.layers = layers
        self._map: dict[str, Element] | None = None

    def get(self, id: str | None) -> Element | None:
        for layer in self.layers:
            e = layer.get(id) if id else None
            if e is not None:
                return e
        return None

    def as_map(self) -> dict[str, Element]:
        if self._map is None:
            out: dict[str, Element] = {}
            for layer in reversed(self.layers):
                out.update({k: v for k, v in layer.items() if v is not None})
            self._map = out
        return self._map


def _label(e: Element, scene: _Scene) -> str:
    return " ".join(label_of(e, scene.as_map()).split())


def _is_node(e: Element) -> bool:
    return e.get("type") in NODE_TYPES and not e.get("containerId")


def _same(a: Element, b: Element, keys: tuple[str, ...]) -> bool:
    return all(a.get(k) == b.get(k) for k in keys)


GEOMETRY = ("x", "y", "width", "height", "angle", "points")
PAINT = ("strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "roundness")


def _agent_name(kind: str) -> str:
    a = registry.get(kind)
    return a.name if a is not None else (kind[:1].upper() + kind[1:] if kind else "AI")


class _Items:
    """The steps of one change: what appeared, where the figure stands to draw it, and what to say."""

    def __init__(self, cid: str, scene: _Scene, children: set[str]) -> None:
        self.cid = cid
        self.scene = scene
        self.children = children
        self.items: list[dict[str, Any]] = []

    def push(self, kind: str, say: str, *, place: str | None, ids: list[str], add: list[Element] = (), change: list[Element] = (), remove: list[str] = (), child: str | None = None, quiet: bool = False) -> None:
        item: dict[str, Any] = {"kind": kind, "say": say, "place": place, "ids": ids, "quiet": quiet}
        if child:
            item["child"] = child
        if add:
            item["add"] = guest_elements(list(add), self.children)
        if change:
            item["change"] = guest_elements(list(change), self.children)
        if remove:
            item["remove"] = list(remove)
        self.items.append(item)


def _describe(cid: str, pre: dict[str, Element | None], post: dict[str, Element | None], order: list[str], scene: _Scene, children: set[str]) -> list[dict[str, Any]]:
    """The items of one change, from the touched elements before (``pre``) and after (``post``)."""
    out = _Items(cid, scene, children)
    by = scene.as_map()
    lib_roots = {library_meta(e)["group"] for e in by.values() if _alive(e) and library_meta(e)}

    def inside_library(e: Element) -> bool:
        return not library_meta(e) and any(g in lib_roots for g in e.get("groupIds") or [])

    added: list[Element] = []
    removed: list[Element] = []
    changed: list[tuple[Element, Element]] = []
    for id in order:
        p, q = pre.get(id), post.get(id)
        if _alive(q) and not _alive(p):
            added.append(q)  # type: ignore[arg-type]
        elif _alive(p) and not _alive(q):
            removed.append(p)  # type: ignore[arg-type]
        elif _alive(p) and _alive(q):
            changed.append((p, q))  # type: ignore[arg-type]
    added_ids = {e["id"] for e in added}

    def with_text(e: Element) -> list[Element]:
        t = bound_text(e, by)
        return [e] + ([t] if t is not None and t["id"] in added_ids else [])

    # nodes drawn (with the text inside them)
    nodes = [e for e in added if _is_node(e) and not inside_library(e)]
    for n in nodes:
        lab = _label(n, scene)
        what = "分区" if n.get("type") == "frame" else "节点"
        lib = library_meta(n)
        say = f"加了「{lab}」" if lib and lab else f"加了{what}{_quote(lab)}" if lab else f"加了一个{what}"
        # a library component is its root plus the shapes grouped with it
        parts = with_text(n) + [e for e in added if inside_library(e) and set(e.get("groupIds") or []) & {library_meta(n).get("group")}] if lib else with_text(n)
        out.push("add-node", say, place=n["id"], ids=[e["id"] for e in parts], add=parts)
    # arrows drawn, one step per node they leave from
    arrows = [e for e in added if e.get("type") in ARROW_TYPES]
    groups: dict[str | None, list[Element]] = {}
    for a in arrows:
        src = ((a.get("startBinding") or {}).get("elementId")) or ((a.get("endBinding") or {}).get("elementId"))
        groups.setdefault(src, []).append(a)
    for src, group in groups.items():
        src_e = scene.get(src)
        names: list[str] = []
        for a in group:
            to = scene.get(((a.get("endBinding") or {}).get("elementId")) if src == (a.get("startBinding") or {}).get("elementId") else (a.get("startBinding") or {}).get("elementId"))
            names.append(_label(to, scene) if to is not None else "")
        listed = [n for n in names if n][:LISTED]
        more = len([n for n in names if n]) - len(listed)
        head = _label(src_e, scene) if src_e is not None else ""
        if head and listed:
            say = f"连了 {head} → " + "、".join(listed) + (f" 等 {len(names)} 处" if more > 0 else "")
            if len(group) == 1:
                t = bound_text(group[0], by)
                if t is not None and t.get("text"):
                    say += f"「{' '.join(str(t['text']).split())}」"
        else:
            say = "画了一条线" if len(group) == 1 else f"画了 {len(group)} 条线"
        parts = [x for a in group for x in with_text(a)]
        out.push("add-arrows", say, place=src if src_e is not None else None, ids=[e["id"] for e in parts], add=parts)
    # anything else drawn: text on its own, freehand, images
    rest = [e for e in added if not _is_node(e) and e.get("type") not in ARROW_TYPES and not e.get("containerId") and not inside_library(e)]
    for e in rest:
        if e.get("type") == "text":
            txt = " ".join(str(e.get("text") or "").split())
            out.push("note", f"写了文字{_quote(txt[:24])}", place=None, ids=[e["id"]], add=[e])
        else:
            out.push("note", "画了一笔", place=None, ids=[e["id"]], add=[e])
    # what an existing element became
    links: list[Element] = []
    for p, q in changed:
        lab = _label(q, scene) or _label(p, scene)
        cp, cq = child_canvas(p), child_canvas(q)
        if cq and cq != cp and cq in children:
            out.push("expand", f"把{_quote(lab)}展开成子图", place=q["id"], ids=[q["id"]], change=[q], child=cq)
        elif q.get("type") == "text" and p.get("text") != q.get("text") and not q.get("containerId"):
            out.push("rename", f"把文字{_quote(str(p.get('text') or '')[:20])}改成{_quote(str(q.get('text') or '')[:20])}", place=None, ids=[q["id"]], change=[q])
        elif q.get("type") == "text" and p.get("text") != q.get("text"):
            owner = scene.get(q.get("containerId"))
            old = " ".join(str(p.get("text") or "").split())
            new = " ".join(str(q.get("text") or "").split())
            place = owner["id"] if owner is not None and _is_node(owner) else None
            out.push("rename", f"把{_quote(old)}改名为{_quote(new)}", place=place, ids=[q["id"]], change=[q])
        elif code_paths(p) != code_paths(q):
            links.append(q)
        elif not _same(p, q, GEOMETRY) and not q.get("containerId"):
            out.push("move", f"挪了{_quote(lab)}", place=q["id"] if _is_node(q) else None, ids=[q["id"]], change=[q])
        elif not _same(p, q, PAINT) and not q.get("containerId"):
            out.push("restyle", f"调整了{_quote(lab)}的样子", place=q["id"] if _is_node(q) else None, ids=[q["id"]], change=[q])
    if links:
        names = [_label(e, scene) for e in links if _label(e, scene)]
        say = f"把{_quote(names[0])}关联到代码" if len(links) == 1 else f"把 {len(links)} 个节点关联到代码"
        out.push("link", say, place=links[0]["id"] if _is_node(links[0]) else None, ids=[e["id"] for e in links], change=links, quiet=True)
    # deletions
    for e in removed:
        if e.get("containerId") or inside_library(e):
            continue
        lab = _label(e, scene)
        say = f"删掉了{_quote(lab)}" if e.get("type") not in ARROW_TYPES else "删掉了一条线"
        out.push("delete", say, place=e["id"] if _is_node(e) else None, ids=[e["id"]], remove=[x["id"] for x in [e, *([bound_text(e, by)] if bound_text(e, by) else [])]])
    return out.items


def _batch_ids(batch: dict[str, Any]) -> list[str]:
    seen: list[str] = []
    for pair in [*(batch.get("after") or []), *(batch.get("before") or [])]:
        if isinstance(pair, list) and pair and isinstance(pair[0], str) and pair[0] not in seen:
            seen.append(pair[0])
    return seen


def _turns_on(store: ProjectStore, cid: str) -> list[dict[str, Any]]:
    """The agent changes recorded for one canvas, oldest first: what changed and who changed it."""
    out: list[dict[str, Any]] = []
    for p in sorted((store.dir / "sessions").glob("*.jsonl")):
        sid = p.name.removesuffix(".jsonl")
        got = store.read_session(sid)
        if got is None:
            continue
        state = got[0]
        binding = store.read_binding(sid) or {}
        for t in (state.get("turns") or {}).values():
            reply = t.get("reply") or {}
            batch = (state.get("batches") or {}).get(reply.get("batchId"))
            if t.get("canvasId") != cid or t.get("status") != "applied" or reply.get("undone") or not isinstance(batch, dict):
                continue
            out.append({"at": int(t.get("startedAt") or 0), "until": int(t.get("endedAt") or t.get("startedAt") or 0), "agent": str(binding.get("agent") or ""), "batch": batch, "turn": str(t.get("id"))})
    out.sort(key=lambda x: (x["at"], x["until"], x["turn"]))
    return out


def _derived_steps(store: ProjectStore, cid: str, children: set[str], current: dict[str, Element], *, skip: set[tuple[str, int]] = frozenset(), until: int | None = None, existed: set[str] | None = None) -> tuple[dict[str, Element], list[dict[str, Any]], dict[str, int]]:
    """The history of a canvas that has no log (or from before it) from the agents' recorded changes: (the elements before the first step, the steps, counts of what was and was not recoverable). ``current``: the canvas as it is now, walked back through every recorded change. For the part before the log began: ``until``: when it did (the person's own steps after it are the log's), ``skip``: element versions the log has (the changes it tells itself), ``existed``: the elements that existed when it began."""
    all_turns = _turns_on(store, cid)
    told = [any((p[0], p[1]) in skip for p in t["batch"].get("after") or [] if isinstance(p, list) and len(p) == 2) for t in all_turns]
    turns = all_turns
    touched = {i for t in turns for i in _batch_ids(t["batch"])}

    # backwards: the elements as each change left them, and as it found them
    state: dict[str, Element | None] = dict(current)
    posts: list[dict[str, Element | None]] = [{}] * len(turns)
    pres: list[dict[str, Element | None]] = [{}] * len(turns)
    for k in range(len(turns) - 1, -1, -1):
        batch = turns[k]["batch"]
        ids = _batch_ids(batch)
        posts[k] = {i: state.get(i) for i in ids}
        before = {pair[0]: pair[1] for pair in batch.get("before") or [] if isinstance(pair, list) and len(pair) == 2}
        for i in ids:
            if i in before:
                snap = before[i]
                if snap is None:
                    state.pop(i, None)
                else:
                    state[i] = snap
        pres[k] = {i: before.get(i) for i in ids}
    start = {i: e for i, e in state.items() if e is not None and (existed is None or i in existed)}

    # the person's own steps: what no change ever touched but that changed after the first one
    first = turns[0]["at"] if turns else 0
    events: list[dict[str, Any]] = []
    quiet_edits = 0
    human_adds: dict[int, list[Element]] = {}
    for i, e in list(start.items()):
        if i in touched or not turns:
            continue
        if int(e.get("updated") or 0) > first and (until is None or int(e["updated"]) < until):
            del start[i]
            human_adds.setdefault(int(e["updated"]), []).append(e)
    # a person's edit to something an agent also touched: a step with no "before" picture
    last_after: dict[str, int] = {}
    for k, t in enumerate(turns):
        for pair in t["batch"].get("before") or []:
            if isinstance(pair, list) and len(pair) == 2 and isinstance(pair[1], dict) and pair[0] in last_after and int(pair[1].get("version") or 0) > last_after[pair[0]] and (until is None or int(pair[1].get("updated") or t["at"]) < until):
                quiet_edits += 1
                events.append({"at": int(pair[1].get("updated") or t["at"]), "kind": "human-quiet", "elements": [pair[1]]})
        for pair in t["batch"].get("after") or []:
            if isinstance(pair, list) and len(pair) == 2 and isinstance(pair[1], int):
                last_after[pair[0]] = pair[1]
    for i, v in last_after.items():
        e = current.get(i)
        if _alive(e) and int(e.get("version") or 0) > v and (until is None or int(e.get("updated") or 0) < until):
            quiet_edits += 1
            events.append({"at": int(e.get("updated") or 0), "kind": "human-quiet", "elements": [e]})
    # cluster the person's additions
    times = sorted(human_adds)
    cluster: list[int] = []
    clusters: list[list[int]] = []
    for at in times:
        if cluster and at - cluster[-1] > LEGACY_GAP_MS:
            clusters.append(cluster)
            cluster = []
        cluster.append(at)
    if cluster:
        clusters.append(cluster)
    for c in clusters:
        events.append({"at": c[0], "until": c[-1], "kind": "human-add", "elements": [e for at in c for e in human_adds[at]]})
    for k, t in enumerate(turns):
        if not told[k]:  # the ones the log tells are walked through above, not told twice
            events.append({"at": t["at"], "until": t["until"], "kind": "agent", "k": k, "agent": t["agent"]})
    events.sort(key=lambda ev: (ev["at"], 0 if ev["kind"] != "human-quiet" else 1))

    # forwards: apply each step to the scene it found, describing what it did
    scene_now: dict[str, Element | None] = dict(start)
    steps: list[dict[str, Any]] = []
    for ev in events:
        if ev["kind"] == "agent":
            k = ev["k"]
            post, pre = posts[k], pres[k]
            items = _describe(cid, pre, post, _batch_ids(turns[k]["batch"]), _Scene(post, pre, scene_now, current), children)
            for i, e in post.items():
                scene_now[i] = e
            actor = _agent_actor(ev["agent"])
        elif ev["kind"] == "human-add":
            els = ev["elements"]
            post = {e["id"]: e for e in els}
            items = _describe(cid, {}, post, [e["id"] for e in els], _Scene(post, scene_now, current), children)
            for i, e in post.items():
                scene_now[i] = e
            actor = {"kind": "you"}
        else:
            e = ev["elements"][0]
            lab = _label(e, _Scene({e["id"]: e}, scene_now, current))
            post = {e["id"]: e}
            scene_now[e["id"]] = e
            out = _Items(cid, _Scene(post, scene_now, current), children)
            out.push("restyle", f"调整了{_quote(lab)}", place=e["id"] if _is_node(e) else None, ids=[e["id"]], change=[e], quiet=True)
            items = out.items
            actor = {"kind": "you"}
        if items:
            steps.append({"at": ev["at"], "until": max(ev.get("until") or ev["at"], ev["at"]), "canvas": cid, "actor": actor, "items": items})
    return start, steps, {"changes": len(turns) - sum(told), "unseenEdits": quiet_edits}


def _agent_actor(kind: str) -> dict[str, Any]:
    return {"kind": "agent", "agent": kind, "name": _agent_name(kind)}


def _maker_events(store: ProjectStore, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The log's saves as makers' changes, oldest first: one per maker per save, the person's neighbouring ones joined (they are one piece of work). What the log filed under the person but the sessions know is an agent's (a batch that came after its save was missed) is the agent's."""
    versions = store._agent_versions()
    out: list[dict[str, Any]] = []
    for rec in records:
        for g in rec.get("g") or []:
            for by, put in _split_by(g, versions):
                ev = {"t": int(rec["t"]), "by": by, "put": {e["id"]: e for e in put}, "del": list(g.get("del") or []) if by == buildlog.YOU else []}
                prev = out[-1] if out else None
                if prev and by == buildlog.YOU and prev["by"] == by and ev["t"] - prev["last"] <= HUMAN_GAP_MS:
                    prev["put"].update(ev["put"])
                    prev["del"] = [i for i in [*prev["del"], *ev["del"]] if i not in prev["put"]]
                    prev["last"] = ev["t"]
                    continue
                ev["last"] = ev["t"]
                out.append(ev)
    return out


def _split_by(g: dict[str, Any], versions: dict[tuple[str, int], str]) -> list[tuple[dict[str, Any], list[Element]]]:
    by, put = g.get("by") or buildlog.YOU, g.get("put") or []
    if by != buildlog.YOU:
        return [(by, put)]
    mine: list[Element] = []
    agents: dict[str, list[Element]] = {}
    made = buildlog.makers(put, versions)
    for e in put:
        a = made[e["id"]]
        (agents.setdefault(a, []) if a else mine).append(e)
    return [*(({"kind": "agent", "agent": a}, els) for a, els in agents.items()), *([(by, mine)] if mine or g.get("del") else [])]


def _logged_steps(store: ProjectStore, cid: str, children: set[str], records: list[dict[str, Any]]) -> tuple[dict[str, Element], list[dict[str, Any]], dict[str, int]]:
    """The history of a canvas from its construction log."""
    start = {e["id"]: e for e in records[0].get("base") or []}
    counts = {"changes": 0, "unseenEdits": 0}
    legacy_steps: list[dict[str, Any]] = []
    if records[0].get("legacy"):
        skip = {(e["id"], int(e.get("version") or 0)) for r in records[1:] for g in r.get("g") or [] for e in g.get("put") or []}
        got = store.read("canvas", cid)
        file_now = {e["id"]: e for e in ((got or ({}, ""))[0].get("elements") or []) if isinstance(e, dict) and "id" in e}
        start, legacy_steps, counts = _derived_steps(store, cid, children, file_now, skip=skip, until=int(records[0]["t"]), existed=set(start))
    final = buildlog.state_of(records)
    scene_now: dict[str, Element | None] = {e['id']: e for e in records[0].get('base') or []}  # what the log found: the legacy steps end here, the logged ones go on from it
    steps = list(legacy_steps)
    for ev in _maker_events(store, records[1:]):
        ids = [*ev["put"], *[i for i in ev["del"] if i not in ev["put"]]]
        pre = {i: scene_now.get(i) for i in ids}
        post: dict[str, Element | None] = {i: ev["put"].get(i) for i in ids}
        items = _describe(cid, pre, post, ids, _Scene(post, pre, scene_now, final), children)
        for i, e in post.items():
            if e is None:
                scene_now.pop(i, None)
            else:
                scene_now[i] = e
        if not items:
            continue
        agent = ev["by"]["kind"] == "agent"
        steps.append({"at": ev["t"], "until": max(ev["last"], ev["t"]), "canvas": cid, "actor": _agent_actor(ev["by"]["agent"]) if agent else {"kind": "you"}, "items": items})
        counts["changes"] += 1 if agent else 0
    return start, steps, counts


def _canvas_steps(store: ProjectStore, cid: str, children: set[str]) -> tuple[list[Element], list[dict[str, Any]], dict[str, int]]:
    """(the elements before the first step, the steps, counts of what was and was not recoverable) of one canvas."""
    records = buildlog.read(store.dir, cid)
    if records and "base" in records[0]:
        start, steps, counts = _logged_steps(store, cid, children, records)
    else:
        got = store.read("canvas", cid)
        current = {e["id"]: e for e in ((got or ({}, ""))[0].get("elements") or []) if isinstance(e, dict) and "id" in e}
        start, steps, counts = _derived_steps(store, cid, children, current)
    counts["yourSteps"] = len([s for s in steps if s["actor"]["kind"] == "you"])
    return guest_elements(_z_order(list(start.values())), children), steps, counts


def _z_order(elements: list[Element]) -> list[Element]:
    """Bottom to top, by Excalidraw's fractional ``index`` (file order when there is none)."""
    return sorted(elements, key=lambda e: (e.get("index") is None, str(e.get("index") or "")))


def build_timeline(store: ProjectStore, root: str, *, relative: bool = False) -> dict[str, Any]:
    """The canvas ``root`` and every canvas below it as a list of steps. ``relative``: times are counted from the first step, not the clock (what a guest gets). Raises ValueError for an unknown canvas."""
    if store.read("canvas", root) is None:
        raise ValueError(f"no canvas {root!r} in this project")
    allowed = nested.reachable(store, root)
    sc = nested.scenes(store)
    index = nested.parent_index(sc)
    titles = canvas_titles(store)
    canvases: dict[str, Any] = {}
    start: dict[str, list[Element]] = {}
    steps: list[dict[str, Any]] = []
    total = {"changes": 0, "yourSteps": 0, "unseenEdits": 0}
    for cid in sorted(allowed):
        if store.read("canvas", cid) is None:
            continue
        s, st, counts = _canvas_steps(store, cid, allowed)
        start[cid] = s
        steps.extend(st)
        for k, v in counts.items():
            total[k] += v
        parent = index.get(cid)
        canvases[cid] = {"title": titles.get(cid) or "", "parent": {"canvas": parent[0], "node": parent[1]} if parent and cid != root else None}
    steps.sort(key=lambda s: (s["at"], s["until"], s["canvas"]))
    if relative and steps:
        t0 = steps[0]["at"]  # the clock time of the work is the owner's business: a guest gets the order and the gaps
        for s in steps:
            s["at"], s["until"] = s["at"] - t0, s["until"] - t0
    dropped = max(0, len(steps) - MAX_STEPS)
    steps = steps[-MAX_STEPS:] if dropped else steps
    for i, s in enumerate(steps):
        s["i"] = i
    return {"format": FORMAT, "version": VERSION, "root": root, "canvases": canvases, "start": start, "steps": steps, "sources": {**total, "steps": len(steps), "dropped": dropped}}


def portable_logs(store: ProjectStore, root: str) -> dict[str, list[dict[str, Any]]]:
    """The construction log of every canvas under ``root`` as it would go in a share bundle: rebuilt from the timeline, so a project older than the log (or one whose log was folded) gives a whole one, in what a guest may see, with times counted from the first step."""
    tl = build_timeline(store, root, relative=True)
    out: dict[str, list[dict[str, Any]]] = {}
    for cid in tl["canvases"]:
        recs: list[dict[str, Any]] = [{"t": 0, "base": tl["start"].get(cid, [])}]
        for st in tl["steps"]:
            if st["canvas"] != cid:
                continue
            put: dict[str, Element] = {}
            gone: list[str] = []
            for it in st["items"]:
                for e in [*(it.get("add") or []), *(it.get("change") or [])]:
                    put[e["id"]] = e
                    gone = [i for i in gone if i != e["id"]]
                for i in it.get("remove") or []:
                    put.pop(i, None)
                    gone.append(i)
            by = {"kind": "you"} if st["actor"]["kind"] == "you" else {"kind": "agent", "agent": st["actor"]["agent"]}
            group = {"by": by, **({"put": list(put.values())} if put else {}), **({"del": gone} if gone else {})}
            if put or gone:
                recs.append({"t": st["at"], "g": [group]})
        out[cid] = recs
    return out
