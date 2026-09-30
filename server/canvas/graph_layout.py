"""Layered layout of a diagram: upstream on top, downstream below (the direction the ladders run), few
line crossings, the user's own nodes left where they are.

``layout(scene, movable)`` places the ``movable`` nodes and routes their lines; every other node is a
fixed constraint the new ones are put around. It is a pure function of the scene (``graph_geom``),
so the page's executor and the server's fallback executor get the same answer:

1. **Layers.** Break cycles, give every node the longest-path layer, pull pure sources next to their
   first target. A layer that holds fixed nodes takes their real height; the rest are stacked from it.
2. **Order.** Long lines get a stand-in in each layer they pass. The order inside each layer comes
   from barycenter sweeps (down and up) and adjacent swaps, over several deterministic starts, and the
   fewest crossings win. A fixed node keeps its own place; new ones go between and around them.
3. **Coordinates.** Each layer is placed at the barycenter of its neighbours, pushed apart by widths
   and the gap (an isotonic fit), never onto a fixed node.
4. **Lines.** ``graph_route``: spread anchors, straight when clean, otherwise orthogonal around
   nodes and lines, and hops for the crossings that are left.

A fan of four or more new lines out of (or into) one node can meet in a junction dot (``bus``).
"""

from __future__ import annotations

import math
import random
from typing import Any

from .graph_geom import MIN_GAP, arrow_ends, arrow_path, bbox_of, default_path, elements_by_id, rect_gap, rect_of
from .graph_route import add_hops, route_arrows

Via = tuple[float, float, float, float]  # a line passing a layer: x, y of the layer's middle, its top and bottom

H_GAP = 56  # air between neighbours in a layer
V_GAP = 88  # air between layers
TIGHT_GAP = 44  # … next to a junction dot
VIRTUAL_W = 24  # room a passing line takes in a layer
JUNCTION = 10
BUS_MIN = 4  # a fan of at least this many lines can be drawn as a bus
FREE_GAP = 120  # a separate new diagram is put this far from what is already there
TRIES = 24
SWEEPS = 10


def _round(v: float) -> int:
    return int(math.floor(v + 0.5))


# ——— layering ———


def _layers(ids: list[str], edges: list[tuple[str, str]]) -> dict[str, int]:
    succ: dict[str, list[str]] = {i: [] for i in ids}
    indeg = {i: 0 for i in ids}
    for u, v in edges:
        if u != v and v not in succ[u]:
            succ[u].append(v)
    for u in ids:
        for v in succ[u]:
            indeg[v] += 1
    state: dict[str, int] = {}
    back: set[tuple[str, str]] = set()

    def dfs(u: str) -> None:
        state[u] = 1
        for v in succ[u]:
            if state.get(v) == 1:
                back.add((u, v))
            elif v not in state:
                dfs(v)
        state[u] = 2

    for u in [i for i in ids if indeg[i] == 0] + ids:
        if u not in state:
            dfs(u)
    dag = [(v, u) if (u, v) in back else (u, v) for u in ids for v in succ[u]]
    dag = list(dict.fromkeys(dag))
    down: dict[str, list[str]] = {i: [] for i in ids}
    up: dict[str, list[str]] = {i: [] for i in ids}
    for u, v in dag:
        down[u].append(v)
        up[v].append(u)
    rank: dict[str, int] = {}

    def depth(u: str) -> int:
        if u not in rank:
            rank[u] = max((depth(p) + 1 for p in up[u]), default=0)
        return rank[u]

    for i in ids:
        depth(i)
    for i in ids:  # a pure source sits right above its first target, not at the very top
        if not up[i] and down[i]:
            rank[i] = min(rank[v] for v in down[i]) - 1
    low = min(rank.values(), default=0)
    return {i: r - low for i, r in rank.items()}


# ——— coordinates inside one layer ———


def _place_layer(order: list[str], want: dict[str, float], width: dict[str, float], pinned: dict[str, float]) -> dict[str, float]:
    def sep(a: str, b: str) -> float:
        g = lambda i: VIRTUAL_W if i.startswith("v:") else H_GAP
        return width[a] / 2 + width[b] / 2 + (g(a) + g(b)) / 2

    out: dict[str, float] = {i: pinned[i] for i in order if i in pinned}

    def solve(run: list[str], left: str | None, right: str | None) -> None:
        if not run:
            return
        off = [0.0]
        for a, b in zip(run, run[1:]):
            off.append(off[-1] + sep(a, b))
        target = [want[i] - o for i, o in zip(run, off)]
        blocks: list[list[float]] = []
        for t in target:
            blocks.append([t, 1])
            while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
                s, c = blocks.pop()
                blocks[-1][0] += s
                blocks[-1][1] += c
        y: list[float] = []
        for s, c in blocks:
            y += [s / c] * int(c)
        lo = out[left] + sep(left, run[0]) if left else -math.inf
        hi = out[right] - sep(run[-1], right) - off[-1] if right else math.inf
        y = [max(v, lo) for v in y]
        if lo <= hi:
            y = [min(v, hi) for v in y]
        for i, v, o in zip(run, y, off):
            out[i] = v + o

    run: list[str] = []
    left: str | None = None
    for i in order:
        if i in pinned:
            solve(run, left, i)
            run, left = [], i
        else:
            run.append(i)
    solve(run, left, None)
    return out


class _Arranger:
    """Order and x-coordinates of every layer of one component."""

    def __init__(self, layers: list[list[str]], width: dict[str, float], pinned: dict[str, float], chain: list[tuple[str, str]]):
        self.layers = layers
        self.width = width
        self.pinned = pinned
        self.up: dict[str, list[str]] = {i: [] for ly in layers for i in ly}
        self.down: dict[str, list[str]] = {i: [] for ly in layers for i in ly}
        for a, b in chain:
            self.down[a].append(b)
            self.up[b].append(a)
        self.pairs = chain

    def crossings(self, x: dict[str, float]) -> int:
        by_layer: dict[int, list[tuple[float, float]]] = {}
        where = {i: k for k, ly in enumerate(self.layers) for i in ly}
        for a, b in self.pairs:
            by_layer.setdefault(where[a], []).append((x[a], x[b]))
        n = 0
        for segs in by_layer.values():
            for i, (a1, b1) in enumerate(segs):
                for a2, b2 in segs[i + 1 :]:
                    if (a1 - a2) * (b1 - b2) < -1e-9:
                        n += 1
        return n

    def score(self, x: dict[str, float]) -> tuple[int, float]:
        return (self.crossings(x), sum(abs(x[a] - x[b]) for a, b in self.pairs))

    def initial(self, rng: random.Random | None) -> dict[str, float]:
        x: dict[str, float] = dict(self.pinned)
        free = [i for ly in self.layers for i in ly if i not in self.pinned]
        for _ in range(len(free) + 1):
            changed = False
            for i in free:
                if i in x:
                    continue
                known = [x[n] for n in self.up[i] + self.down[i] if n in x]
                if known:
                    x[i] = sum(known) / len(known)
                    changed = True
            if not changed:
                break
        nxt = 0.0
        for i in free:
            if i not in x:
                x[i] = nxt
                nxt += 220
        if rng:
            for i in free:
                x[i] += rng.uniform(-160, 160)
        for ly in self.layers:
            self._settle(ly, x)
        return x

    def _settle(self, layer: list[str], x: dict[str, float]) -> None:
        layer.sort(key=lambda i: (x[i], i))
        x.update(_place_layer(layer, {i: x[i] for i in layer}, self.width, self.pinned))

    def _sweep(self, x: dict[str, float], downward: bool) -> None:
        ks = range(1, len(self.layers)) if downward else range(len(self.layers) - 2, -1, -1)
        for k in ks:
            layer = self.layers[k]
            for i in layer:
                if i in self.pinned:
                    continue
                nb = self.up[i] if downward else self.down[i]
                if nb:
                    x[i] = sum(x[n] for n in nb) / len(nb)
            self._settle(layer, x)

    def _transpose(self, x: dict[str, float]) -> dict[str, float]:
        best = self.score(x)
        improved = True
        rounds = 0
        while improved and rounds < 3:
            improved = False
            rounds += 1
            for layer in self.layers:
                for p in range(len(layer) - 1):
                    a, b = layer[p], layer[p + 1]
                    if a in self.pinned or b in self.pinned:
                        continue
                    trial = dict(x)
                    trial[a], trial[b] = x[b], x[a]
                    saved = list(layer)
                    layer[p], layer[p + 1] = b, a
                    trial.update(_place_layer(layer, {i: trial[i] for i in layer}, self.width, self.pinned))
                    s = self.score(trial)
                    if s < best:
                        x, best, improved = trial, s, True
                    else:
                        layer[:] = saved
        return x

    def run(self) -> dict[str, float]:
        best_x: dict[str, float] | None = None
        best_orders: list[list[str]] | None = None
        best_score: tuple[int, float] | None = None
        base = [list(ly) for ly in self.layers]
        for t in range(TRIES):
            self.layers = [list(ly) for ly in base]
            x = self.initial(random.Random(t) if t else None)
            stall = 0
            local = self.score(x)
            for _ in range(SWEEPS):
                self._sweep(x, True)
                self._sweep(x, False)
                s = self.score(x)
                if s < local:
                    local, stall = s, 0
                else:
                    stall += 1
                    if stall >= 3:
                        break
            x = self._transpose(x)
            s = self.score(x)
            if best_score is None or s < best_score:
                best_x, best_orders, best_score = dict(x), [list(ly) for ly in self.layers], s
            if best_score[0] == 0 and t >= 3:
                break
        assert best_x is not None and best_orders is not None
        self.layers = best_orders
        x = best_x
        for _ in range(6):  # settle: each item towards the middle of all its neighbours
            trial = dict(x)
            for layer in self.layers:
                want = {i: (sum(trial[n] for n in self.up[i] + self.down[i]) / len(self.up[i] + self.down[i]) if (self.up[i] + self.down[i]) and i not in self.pinned else trial[i]) for i in layer}
                trial.update(_place_layer(layer, want, self.width, self.pinned))
            if self.crossings(trial) <= self.crossings(x):
                x = trial
        return x


# ——— the whole layout ———


def layout(scene: dict[str, Any], movable: set[str] | frozenset[str], arrows: list[str] | None = None, bus: bool = False) -> dict[str, Any]:
    """Place ``movable`` nodes and route ``arrows`` (default: every line that touches a movable node).

    Returns ``{"nodes": {id: {x, y}}, "arrows": {id: {path, start?, end?, plain?, new?}}, "junctions": [...]}``.
    Nodes and lines not named stay exactly as they are; a line is listed only where it differs from what
    it is now (``path`` None: back to the plain straight arrow the page draws by itself)."""
    nodes = {i: dict(n) for i, n in elements_by_id(scene).items()}
    old_junctions = {j["id"] for j in scene.get("junctions", [])}
    movable = {m for m in movable if m in nodes}
    work = [dict(a) for a in scene.get("arrows", [])]
    by_arrow = {a["id"]: a for a in work}
    touching = [a["id"] for a in work if {*arrow_ends(a)} & movable and all(e in nodes for e in arrow_ends(a))]
    route_ids = [i for i in (arrows if arrows is not None else touching) if i in by_arrow]
    changes: dict[str, dict[str, Any]] = {}
    trunks: dict[str, str] = {}
    new_junctions: set[str] = set()
    edges = []  # the layout sees the lines as they were drawn: a bus is a way of drawing a fan, not a different graph
    for a in work:
        s, e = arrow_ends(a)
        if s in nodes and e in nodes and s != e and ({s, e} & movable) and (a["id"] in route_ids or a["id"] in touching):
            edges.append((a["id"], s, e))
    if bus:
        hubs = _make_buses(nodes, work, by_arrow, route_ids, old_junctions, new_junctions, changes, trunks)
    all_junctions = old_junctions | new_junctions
    vias = _place_nodes(nodes, movable, edges, scene, all_junctions)
    for i in movable:
        nodes[i]["x"], nodes[i]["y"] = _round(nodes[i]["x"]), _round(nodes[i]["y"])
    if bus:
        _seat_junctions(nodes, hubs)
    routed = route_arrows(nodes, work, route_ids, all_junctions, trunks, vias) if route_ids else {}
    routed = add_hops(routed, {a["id"]: arrow_path(a, nodes) for a in work if a["id"] not in routed})
    out_arrows: dict[str, dict[str, Any]] = {aid: dict(c) for aid, c in changes.items()}
    for aid, pts in routed.items():
        s, e = arrow_ends(by_arrow[aid])
        path = [[_round(p[0]), _round(p[1])] for p in pts]
        straight = s in nodes and e in nodes and len(path) == 2 and all(abs(p[0] - q[0]) <= 1.5 and abs(p[1] - q[1]) <= 1.5 for p, q in zip(path, default_path(nodes[s], nodes[e])))
        if not straight:
            out_arrows.setdefault(aid, {})["path"] = path
        elif by_arrow[aid].get("path"):
            out_arrows.setdefault(aid, {})["path"] = None  # it was drawn some other way: it goes back to the plain straight arrow
    junction_out = [{"id": j, "x": _round(nodes[j]["x"]), "y": _round(nodes[j]["y"]), "width": JUNCTION, "height": JUNCTION} for j in sorted(new_junctions)]
    return {"nodes": {i: {"x": nodes[i]["x"], "y": nodes[i]["y"]} for i in nodes if i in movable and i not in all_junctions}, "arrows": out_arrows, "junctions": junction_out}


def _make_buses(nodes, work, by_arrow, route_ids, old_junctions, new_junctions, changes, trunks) -> dict[str, tuple[str, str]]:
    """Turn each fan of BUS_MIN or more new lines out of (or into) one node into a trunk to a junction dot and branches from it."""
    used: set[str] = set()
    hubs: dict[str, tuple[str, str]] = {}
    for direction in ("out", "in"):
        hub_end = "start" if direction == "out" else "end"  # the end of a branch that moves to the junction
        groups: dict[str, list[str]] = {}
        for aid in route_ids:
            a = by_arrow[aid]
            s, e = arrow_ends(a)
            if aid in used or s not in nodes or e not in nodes or s == e or s in old_junctions or e in old_junctions:
                continue
            groups.setdefault(s if direction == "out" else e, []).append(aid)
        for hub, ids in groups.items():
            if len({arrow_ends(by_arrow[i])[1 if direction == "out" else 0] for i in ids}) < BUS_MIN:
                continue
            k = 1
            while f"j{k}" in nodes:
                k += 1
            jid = f"j{k}"
            nodes[jid] = {"id": jid, "type": "ellipse", "x": 0, "y": 0, "width": JUNCTION, "height": JUNCTION}
            new_junctions.add(jid)
            hubs[jid] = (hub, direction)
            trunk_id = f"bus-{jid}"
            for aid in ids:
                used.add(aid)
                by_arrow[aid][hub_end] = {"id": jid}
                changes[aid] = {hub_end: jid, **({"plain": True} if direction == "in" else {})}
            trunk = {"id": trunk_id, "type": "arrow", "start": {"id": hub if direction == "out" else jid}, "end": {"id": jid if direction == "out" else hub}}
            work.append(trunk)
            by_arrow[trunk_id] = trunk
            route_ids.append(trunk_id)
            trunks[jid] = trunk_id
            changes[trunk_id] = {"new": True, "start": trunk["start"]["id"], "end": trunk["end"]["id"], **({"plain": True} if direction == "out" else {})}
    return hubs


def _seat_junctions(nodes: dict[str, dict[str, Any]], hubs: dict[str, tuple[str, str]]) -> None:
    """A junction dot goes in the gap between its node's layer and the next one, so the bar it makes crosses no node."""
    for jid, (hub, direction) in hubs.items():
        h = nodes[hub]
        cy = h["y"] + h["height"] / 2
        band = max(float(n["height"]) for i, n in nodes.items() if i not in hubs and abs(n["y"] + n["height"] / 2 - cy) < 2)
        sign = 1 if direction == "out" else -1
        nodes[jid]["y"] = round(cy + sign * (band / 2 + V_GAP / 2) - JUNCTION / 2)
        nodes[jid]["x"] = h["x"] + h["width"] / 2 - JUNCTION / 2


def _place_nodes(nodes: dict[str, dict[str, Any]], movable: set[str], edges: list[tuple[str, str, str]], scene: dict[str, Any], junctions: set[str]) -> dict[str, list[Via]]:
    involved = set(movable)
    for _, s, e in edges:
        involved.update((s, e))
    order = [i for i in nodes if i in involved]
    parent = {i: i for i in order}

    def find(i: str) -> str:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for _, s, e in edges:
        parent[find(s)] = find(e)
    comps: dict[str, list[str]] = {}
    for i in order:
        comps.setdefault(find(i), []).append(i)
    anchored = [c for c in comps.values() if any(i not in movable for i in c)]
    free = [c for c in comps.values() if all(i in movable for i in c)]
    vias: dict[str, list[Via]] = {}
    for comp in anchored:
        vias.update(_place_component(nodes, movable, comp, [ed for ed in edges if ed[1] in comp], junctions))
    settled = [n for i, n in nodes.items() if (i not in movable or any(i in c for c in anchored)) and i not in junctions]
    box = bbox_of([*settled, *scene.get("frames", [])])
    x_cursor = box[0] if box else 0.0
    y0 = box[3] + FREE_GAP if box else 0.0
    for comp in free:
        got = _place_component(nodes, movable, comp, [ed for ed in edges if ed[1] in comp], junctions)
        real = [nodes[i] for i in comp if i not in junctions]
        left, top = min(n["x"] for n in real), min(n["y"] for n in real)
        right = max(n["x"] + n["width"] for n in real)
        dx, dy = x_cursor - left, y0 - top
        for i in comp:
            nodes[i]["x"] += dx
            nodes[i]["y"] += dy
        vias.update({aid: [(x + dx, y + dy, t + dy, b + dy) for x, y, t, b in vs] for aid, vs in got.items()})
        x_cursor += right - left + FREE_GAP
    _clear_overlaps(nodes, movable, junctions)
    return vias


def _place_component(nodes: dict[str, dict[str, Any]], movable: set[str], comp: list[str], edges: list[tuple[str, str, str]], junctions: set[str]) -> dict[str, list[Via]]:
    rank = _layers(comp, [(s, e) for _, s, e in edges])
    top = max(rank.values(), default=0)
    real = {i: nodes[i] for i in comp}
    layers: list[list[str]] = [[] for _ in range(top + 1)]
    for i in comp:
        layers[rank[i]].append(i)
    width = {i: float(n["width"]) for i, n in real.items()}
    chain: list[tuple[str, str]] = []
    stand_ins: dict[str, list[str]] = {}
    for k, (aid, u, v) in enumerate(edges):  # a line that passes layers leaves a stand-in in each
        a, b = (u, v) if rank[u] <= rank[v] else (v, u)
        prev = a
        for r in range(rank[a] + 1, rank[b]):
            vid = f"v:{k}:{r}"
            width[vid] = 0.0
            layers[r].append(vid)
            chain.append((prev, vid))
            stand_ins.setdefault(aid, []).append(vid)
            prev = vid
        if rank[a] != rank[b]:
            chain.append((prev, b))
        if rank[u] > rank[v] and aid in stand_ins:
            stand_ins[aid].reverse()
    height = [max([float(real[i]["height"]) for i in ly if i in real] or [0.0]) for ly in layers]
    tight = [all(i in junctions or i not in real for i in ly) for ly in layers]
    at: dict[int, list[float]] = {}
    for i in comp:
        if i not in movable:
            at.setdefault(rank[i], []).append(real[i]["y"] + real[i]["height"] / 2)
    yc = {k: sorted(ys)[len(ys) // 2] for k, ys in at.items()}

    def step(k: int) -> float:
        return height[k] / 2 + (TIGHT_GAP if tight[k] or tight[k + 1] else V_GAP) + height[k + 1] / 2

    first = min(yc, default=0)
    yc.setdefault(first, 0.0)
    for k in range(first - 1, -1, -1):
        yc[k] = yc[k + 1] - step(k)
    for k in range(first + 1, top + 1):
        yc.setdefault(k, yc[k - 1] + step(k - 1))
    pinned = {i: real[i]["x"] + real[i]["width"] / 2 for i in comp if i not in movable}
    for k in range(top + 1):  # fixed nodes of other diagrams that stand in this layer's band are in the way too
        lo, hi = yc[k] - height[k] / 2 - 20, yc[k] + height[k] / 2 + 20
        for i, n in nodes.items():
            if i not in comp and i not in movable and i not in junctions and n["y"] < hi and n["y"] + n["height"] > lo:
                width[f"o:{i}"] = float(n["width"])
                pinned[f"o:{i}"] = n["x"] + n["width"] / 2
                layers[k].append(f"o:{i}")
    x = _Arranger(layers, width, pinned, chain).run()
    for i in comp:
        if i in movable:
            nodes[i]["x"] = x[i] - nodes[i]["width"] / 2
            nodes[i]["y"] = yc[rank[i]] - nodes[i]["height"] / 2
    layer_of = {vid: int(vid.split(":")[2]) for vids in stand_ins.values() for vid in vids}
    return {aid: [(x[v], yc[layer_of[v]], yc[layer_of[v]] - height[layer_of[v]] / 2, yc[layer_of[v]] + height[layer_of[v]] / 2) for v in vids] for aid, vids in stand_ins.items()}


def _clear_overlaps(nodes: dict[str, dict[str, Any]], movable: set[str], junctions: set[str]) -> None:
    """Last resort: a new node that still lands on another one moves right until it has its air."""
    done = [n for i, n in nodes.items() if i not in movable and i not in junctions]
    for i in sorted((i for i in movable if i not in junctions), key=lambda i: (nodes[i]["y"], nodes[i]["x"])):
        n = nodes[i]
        for _ in range(len(done) + 1):
            hit = next((o for o in done if rect_gap(rect_of(n), rect_of(o)) < MIN_GAP), None)
            if hit is None:
                break
            n["x"] = hit["x"] + hit["width"] + MIN_GAP
        done.append(n)


def apply_layout(scene: dict[str, Any], res: dict[str, Any]) -> dict[str, Any]:
    """The scene as it looks after ``layout`` (used to measure before the page is touched)."""
    out = {k: v for k, v in scene.items()}
    out["nodes"] = [{**n, **res["nodes"][n["id"]]} if n["id"] in res["nodes"] else n for n in scene["nodes"]]
    out["junctions"] = [*scene.get("junctions", []), *res["junctions"]]
    arrows = []
    seen = set()
    for a in scene["arrows"]:
        u = res["arrows"].get(a["id"])
        seen.add(a["id"])
        if not u:
            arrows.append(a)
            continue
        b = dict(a)
        if "path" in u:
            b.pop("path", None)
            if u["path"]:
                b["path"] = u["path"]
        if "start" in u:
            b["start"] = {"id": u["start"]}
        if "end" in u:
            b["end"] = {"id": u["end"]}
        arrows.append(b)
    for aid, u in res["arrows"].items():
        if aid not in seen and u.get("new"):
            arrows.append({"id": aid, "type": "arrow", "start": {"id": u["start"]}, "end": {"id": u["end"]}, **({"path": u["path"]} if "path" in u else {})})
    out["arrows"] = arrows
    return out
