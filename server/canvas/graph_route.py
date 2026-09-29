"""Where a line attaches to a node and how it runs: anchors spread along a side, straight when that is
clean, otherwise an orthogonal path that goes around nodes and other lines, hops where a crossing
cannot be avoided. Pure functions over the scene (see ``graph_geom``); ``graph_layout`` calls them
after it has placed the nodes.
"""

from __future__ import annotations

import heapq
import math
import time
from typing import Any

from .graph_geom import (
    GAP,
    Point,
    arrow_ends,
    arrow_path,
    centre,
    collinear_run,
    cross_point,
    rect_of,
    seg_hits_rect,
    seg_len,
    segments,
)

LANE = 16  # orthogonal paths keep this far from nodes
BEND = 40  # cost of a corner, in px of extra length
SLANT = 60  # … more when a slanted run meets it: a bent line reads best when its runs are horizontal and vertical
CROSS = 300  # cost of crossing another line
OVERLAP = 400  # cost of running on top of another line, per grid step
THROUGH = 20000  # cost of cutting through a node
BUDGET_S = 8.0  # after this long, lines that are still not clean keep the best of the ready-made ways (no more searching)
TRACKS = (8, 16)  # extra grid lines outside the keep-clear zone of every node
HOP_R = 10  # a hop is 2·HOP_R wide and HOP_R high
SPREAD_LO, SPREAD_HI = 0.15, 0.85  # anchors stay inside this part of a side
NORMALS = {"bottom": (0, 1), "top": (0, -1), "right": (1, 0), "left": (-1, 0)}
DIRS = [(1, 0), (0, 1), (-1, 0), (0, -1)]


def side_towards(n: dict[str, Any], p: Point) -> str:
    x0, y0, x1, y1 = rect_of(n)
    if p[1] > y1:
        return "bottom"
    if p[1] < y0:
        return "top"
    return "right" if p[0] > (x0 + x1) / 2 else "left"


def border_point(n: dict[str, Any], side: str, t: float) -> Point:
    """The point ``t`` (0..1) of the way along a side of the node, pushed out by GAP."""
    x0, y0, x1, y1 = rect_of(n)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hw, hh = (x1 - x0) / 2, (y1 - y0) / 2
    shape = n.get("type")
    if side in ("top", "bottom"):
        x = x0 + t * (x1 - x0)
        u = min(abs(x - cx) / hw, 1.0) if hw else 0.0
        off = hh * (math.sqrt(1 - u * u) if shape == "ellipse" else 1 - u if shape == "diamond" else 1.0)
        return (x, cy + (off + GAP) * (1 if side == "bottom" else -1))
    y = y0 + t * (y1 - y0)
    u = min(abs(y - cy) / hh, 1.0) if hh else 0.0
    off = hw * (math.sqrt(1 - u * u) if shape == "ellipse" else 1 - u if shape == "diamond" else 1.0)
    return (cx + (off + GAP) * (1 if side == "right" else -1), y)


def _frac(n: dict[str, Any], side: str, p: Point) -> float:
    x0, y0, x1, y1 = rect_of(n)
    return (p[0] - x0) / (x1 - x0 or 1) if side in ("top", "bottom") else (p[1] - y0) / (y1 - y0 or 1)


def spread_anchors(
    nodes: dict[str, dict[str, Any]],
    arrows: list[dict[str, Any]],
    route_ids: set[str],
    kept: dict[str, list[Point]],
    skip: set[str],
    vias: dict[str, list[tuple[float, float, float, float]]] | None = None,
    hint: dict[str, list[Point]] | None = None,
) -> dict[str, dict[str, tuple[str, Point]]]:
    """For each arrow to route, where each end attaches: ``{arrow: {"s": (side, point), "e": (side, point)}}``.

    Ends on the same side of a node are spread evenly along it (ordered by where the other end is, so
    the lines do not cross right at the node: by the place the line arrives from, its first stop when
    it has one); a side that already carries a line nobody may move keeps a clear spot around it. ``skip`` are nodes (junction dots) that take no spreading."""
    att: dict[tuple[str, str], list[tuple[float, str, str]]] = {}
    for a in arrows:
        if a["id"] not in route_ids:
            continue
        s, e = arrow_ends(a)
        if s not in nodes or e not in nodes or s == e or (s in skip and e in skip):
            continue
        for end, me, other in (("s", s, e), ("e", e, s)):
            if me in skip:
                continue
            oc = centre(nodes[other])
            side = side_towards(nodes[me], oc)
            stops = (vias or {}).get(a["id"])
            drawn = (hint or {}).get(a["id"])
            if drawn and len(drawn) >= 2 and side in ("top", "bottom"):
                walk = drawn if end == "s" else drawn[::-1]
                oc = (next((p[0] for p in walk[1:] if abs(p[0] - walk[0][0]) > 1), walk[0][0]), oc[1])
            elif stops and side in ("top", "bottom"):
                oc = (stops[0][0] if end == "s" else stops[-1][0], oc[1])
            att.setdefault((me, side), []).append((oc[0] if side in ("top", "bottom") else oc[1], a["id"], end))
    taken: dict[tuple[str, str], list[float]] = {}
    for a in arrows:
        if a["id"] in route_ids or a["id"] not in kept or not kept[a["id"]]:
            continue
        pts = kept[a["id"]]
        for me, p in ((arrow_ends(a)[0], pts[0]), (arrow_ends(a)[1], pts[-1])):
            if me in nodes and me not in skip:
                side = min(NORMALS, key=lambda sd: _dist_to_side(nodes[me], sd, p))
                taken.setdefault((me, side), []).append(_frac(nodes[me], side, p))
    out: dict[str, dict[str, tuple[str, Point]]] = {}
    for (me, side), items in att.items():
        n = nodes[me]
        span = float(n["width"] if side in ("top", "bottom") else n["height"])
        items.sort(key=lambda it: (it[0], it[1], it[2]))
        count = len(items)
        ideal = [SPREAD_LO + (SPREAD_HI - SPREAD_LO) * (i + 1) / (count + 1) for i in range(count)]
        if count == 1 and not taken.get((me, side)):
            ideal = [0.5]
        used = list(taken.get((me, side), []))
        for (_, aid, end), f in zip(items, ideal):
            if used:
                grid = [g / 20 for g in range(2, 19)]
                free = [g for g in grid if all(abs(g - u) * span >= 14 for u in used)]
                if free:
                    f = min(free, key=lambda g: abs(g - f))
            used.append(f)
            out.setdefault(aid, {})[end] = (side, border_point(n, side, f))
    return out


def _dist_to_side(n: dict[str, Any], side: str, p: Point) -> float:
    x0, y0, x1, y1 = rect_of(n)
    return abs(p[1] - (y1 if side == "bottom" else y0)) if side in ("top", "bottom") else abs(p[0] - (x1 if side == "right" else x0))


class _Others:
    """The other lines a new one must not cross or run along, split by direction so a grid step is cheap to check."""

    def __init__(self, paths: list[tuple[str, list[Point]]]):
        self._cache: dict[tuple[Point, Point], float] = {}
        self.h: list[tuple[float, float, float]] = []
        self.v: list[tuple[float, float, float]] = []
        self.d: list[tuple[Point, Point]] = []
        for _, pts in paths:
            for p, q, _hop in segments(pts):
                if abs(p[1] - q[1]) < 1e-6:
                    self.h.append((p[1], min(p[0], q[0]), max(p[0], q[0])))
                elif abs(p[0] - q[0]) < 1e-6:
                    self.v.append((p[0], min(p[1], q[1]), max(p[1], q[1])))
                else:
                    self.d.append((p, q))

    def step_cost(self, p: Point, q: Point) -> float:
        key = (p, q) if p <= q else (q, p)
        got = self._cache.get(key)
        if got is not None:
            return got
        cost = 0.0
        if abs(p[1] - q[1]) < 1e-6:  # horizontal step
            y, lo, hi = p[1], min(p[0], q[0]), max(p[0], q[0])
            cost += CROSS * sum(1 for x, y0, y1 in self.v if lo - 0.5 <= x < hi - 0.5 and y0 + 0.5 < y < y1 - 0.5)  # (half open: a crossing on a grid point counts once)
            cost += OVERLAP * sum(1 for yy, x0, x1 in self.h if abs(yy - y) < 1.5 and min(hi, x1) - max(lo, x0) > 1)
            for (ax, ay), (bx, by) in self.d:
                if min(ay, by) + 0.5 < y < max(ay, by) - 0.5 and lo - 0.5 <= ax + (y - ay) * (bx - ax) / (by - ay) < hi - 0.5:
                    cost += CROSS
        else:
            x, lo, hi = p[0], min(p[1], q[1]), max(p[1], q[1])
            cost += CROSS * sum(1 for y, x0, x1 in self.h if lo - 0.5 <= y < hi - 0.5 and x0 + 0.5 < x < x1 - 0.5)
            cost += OVERLAP * sum(1 for xx, y0, y1 in self.v if abs(xx - x) < 1.5 and min(hi, y1) - max(lo, y0) > 1)
            for (ax, ay), (bx, by) in self.d:
                if min(ax, bx) + 0.5 < x < max(ax, bx) - 0.5 and lo - 0.5 <= ay + (x - ax) * (by - ay) / (bx - ax) < hi - 0.5:
                    cost += CROSS
        self._cache[key] = cost
        return cost

    def path_cost(self, pts: list[Point]) -> float:
        cost = 0.0
        for p, q in zip(pts, pts[1:]):
            if abs(p[1] - q[1]) < 1e-6 or abs(p[0] - q[0]) < 1e-6:
                cost += self.step_cost(p, q)
            else:  # a diagonal segment: crossings with everything
                for y, x0, x1 in self.h:
                    if cross_point(p, q, (x0, y), (x1, y)):
                        cost += CROSS
                for x, y0, y1 in self.v:
                    if cross_point(p, q, (x, y0), (x, y1)):
                        cost += CROSS
                for r, s in self.d:
                    if cross_point(p, q, r, s):
                        cost += CROSS
                    cost += OVERLAP * (collinear_run(p, q, r, s) > 1)
        return cost


def _through(pts: list[Point], rects: list[tuple[float, float, float, float]]) -> int:
    return sum(1 for r in rects if any(seg_hits_rect(p, q, r) for p, q in zip(pts, pts[1:])))


def _length(pts: list[Point]) -> float:
    return sum(seg_len(p, q) for p, q in zip(pts, pts[1:]))


def _slanted_corners(pts: list[Point]) -> int:
    def flat(p: Point, q: Point) -> bool:
        return abs(p[0] - q[0]) < 1e-6 or abs(p[1] - q[1]) < 1e-6

    return sum(1 for a, b, c in zip(pts, pts[1:], pts[2:]) if _corner(a, b, c) and not (flat(a, b) and flat(b, c)))


def _corner(a: Point, b: Point, c: Point) -> bool:
    return abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-6


def _corners(pts: list[Point]) -> int:
    n = 0
    for a, b, c in zip(pts, pts[1:], pts[2:]):
        if abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-6:
            n += 1
    return n


def _orthogonal(
    a: Point,
    da: tuple[int, int],
    b: Point,
    db: tuple[int, int],
    obstacles: list[tuple[float, float, float, float]],
    others: _Others,
    window: float | None,
    tracks: tuple[int, ...] = (),
) -> list[Point] | None:
    xs_set = {a[0], b[0]}
    ys_set = {a[1], b[1]}
    for x0, y0, x1, y1 in obstacles:
        xs_set.update((x0, x1, (x0 + x1) / 2))
        ys_set.update((y0, y1, (y0 + y1) / 2))
        for k in tracks:  # side by side tracks just outside the keep-clear zone, so lines can run next to each other
            xs_set.update((x0 - k, x1 + k))
            ys_set.update((y0 - k, y1 + k))
    lo_x, hi_x = min(a[0], b[0]), max(a[0], b[0])
    lo_y, hi_y = min(a[1], b[1]), max(a[1], b[1])
    if window is not None:
        xs_set = {x for x in xs_set if lo_x - window <= x <= hi_x + window}
        ys_set = {y for y in ys_set if lo_y - window <= y <= hi_y + window}
    # lanes between neighbouring columns / rows of obstacles: room to run between nodes
    for vals in (xs_set, ys_set):
        s = sorted(vals)
        vals.update((p + q) / 2 for p, q in zip(s, s[1:]) if q - p > 2 * LANE)
    xs, ys = sorted(xs_set), sorted(ys_set)
    xi = {x: i for i, x in enumerate(xs)}
    yi = {y: j for j, y in enumerate(ys)}

    seen: dict[tuple[float, float], bool] = {}

    def inside(x: float, y: float) -> bool:
        got = seen.get((x, y))
        if got is None:
            got = seen[(x, y)] = any(x0 + 0.01 < x < x1 - 0.01 and y0 + 0.01 < y < y1 - 0.01 for x0, y0, x1, y1 in obstacles)
        return got

    def blocked(p: Point, q: Point) -> bool:
        return inside((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)

    start = (xi[a[0]], yi[a[1]], DIRS.index(da))
    goal = (xi[b[0]], yi[b[1]], DIRS.index((-db[0], -db[1])))
    heap: list[tuple[float, int, float, tuple[int, int, int]]] = []
    counter = 0
    best = {start: 0.0}
    parent: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    heapq.heappush(heap, (abs(a[0] - b[0]) + abs(a[1] - b[1]), counter, 0.0, start))
    while heap:
        _, _, g, st = heapq.heappop(heap)
        if g > best.get(st, math.inf):
            continue
        if st == goal:
            pts = [(xs[st[0]], ys[st[1]])]
            while st in parent:
                st = parent[st]
                pts.append((xs[st[0]], ys[st[1]]))
            pts.reverse()
            return pts
        i, j, d = st
        for nd, (dx, dy) in enumerate(DIRS):
            if (nd + 2) % 4 == d:
                continue
            ni, nj = i + dx, j + dy
            if not (0 <= ni < len(xs) and 0 <= nj < len(ys)):
                continue
            p, q = (xs[i], ys[j]), (xs[ni], ys[nj])
            if inside(*q) and not (ni == goal[0] and nj == goal[1]) or blocked(p, q):
                continue
            ng = g + seg_len(p, q) + (BEND if nd != d else 0) + others.step_cost(p, q)
            ns = (ni, nj, nd)
            if ng < best.get(ns, math.inf):
                best[ns] = ng
                parent[ns] = st
                counter += 1
                heapq.heappush(heap, (ng + abs(xs[ni] - b[0]) + abs(ys[nj] - b[1]), counter, ng, ns))
    return None


def _simplify(pts: list[Point]) -> list[Point]:
    out = [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - out[-1][0]) < 1e-6 and abs(p[1] - out[-1][1]) < 1e-6:
            continue
        if len(out) >= 2:
            a, b = out[-2], out[-1]
            if abs((b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0])) < 1e-6 and (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1]) > 0:
                out[-1] = p
                continue
        out.append(p)
    return out


def _candidates(sp: Point, ep: Point, vias: list[tuple[float, float, float, float]], band_a: tuple[float, float], band_b: tuple[float, float]) -> list[list[Point]]:
    """Ways to run from ``sp`` to ``ep`` other than straight: through the places the layout kept free for
    this line in each layer it passes (as a polyline, and as orthogonal jogs at several heights)."""
    out: list[list[Point]] = []
    if vias:
        out.append([sp, *[(v[0], v[1]) for v in vias], ep])
    bands = [band_a, *[(v[2], v[3]) for v in vias], band_b]
    cols = [sp[0], *[v[0] for v in vias], ep[0]]
    for off in (0, 8, -8, 16, -16):
        pts = [sp]
        for k in range(len(cols) - 1):
            (t0, b0), (t1, b1) = bands[k], bands[k + 1]
            if t1 >= b0:
                y = (b0 + t1) / 2
            elif b1 <= t0:
                y = (t0 + b1) / 2
            else:
                break
            pts += [(cols[k], y + off), (cols[k + 1], y + off)]
        else:
            out.append(_simplify([*pts, ep]))
    return out


def _pick(
    default: list[Point],
    na: tuple[int, int],
    nb: tuple[int, int],
    stubs: tuple[float, float],
    candidates: list[list[Point]],
    rects: list[tuple[float, float, float, float]],
    obstacles: list[tuple[float, float, float, float]],
    oth: _Others,
    deadline: float,
) -> list[Point]:
    """The cheapest way to run one line: the plain one if it is clean, else the best of the ready-made candidates,
    else what a search around the obstacles finds."""

    def problem(pts: list[Point]) -> float:
        return THROUGH * _through(pts, rects) + oth.path_cost(pts)

    def total(pts: list[Point]) -> float:
        return _length(pts) + BEND * _corners(pts) + SLANT * _slanted_corners(pts) + problem(pts)

    best = default
    if problem(best) > 0 and candidates:
        cand = min(candidates, key=total)
        if total(cand) < total(best):
            best = cand
    if problem(best) > 0 and time.monotonic() < deadline:
        sp, ep = default[0], default[-1]
        a2 = (sp[0] + na[0] * stubs[0], sp[1] + na[1] * stubs[0])
        b2 = (ep[0] + nb[0] * stubs[1], ep[1] + nb[1] * stubs[1])
        for tracks in ((), TRACKS):  # more grid lines only when the plain search still leaves a crossing or a shared run
            for window in (240.0, None):
                found = _orthogonal(a2, na, b2, nb, obstacles, oth, window, tracks)
                if found:
                    cand = _simplify([sp, *found, ep])
                    if total(cand) < total(best):
                        best = cand
                    break
            if problem(best) == 0:
                break
    return best


def route_arrows(
    nodes: dict[str, dict[str, Any]],
    arrows: list[dict[str, Any]],
    route_ids: list[str],
    junctions: set[str] = frozenset(),
    trunks: dict[str, str] | None = None,
    vias: dict[str, list[tuple[float, float, float, float]]] | None = None,
) -> dict[str, list[Point]]:
    """Paths for the arrows in ``route_ids`` (in the order given); every other arrow keeps its drawn path
    and is an obstacle. Straight when clean, else the best of: through the layout's free places
    (``vias``: per line, x / middle / top / bottom of each layer it passes), orthogonal jogs, and a
    search around nodes and lines.

    ``trunks`` maps a junction dot to the line that hangs it from its node: the dot is moved (in
    ``nodes``) in line with where that line attaches, so the trunk is a straight drop."""
    by_id = {a["id"]: a for a in arrows}
    todo = [i for i in route_ids if i in by_id]
    kept = {a["id"]: arrow_path(a, nodes) for a in arrows if a["id"] not in todo}
    rects_all = {i: rect_of(n) for i, n in nodes.items() if i not in junctions}
    deadline = time.monotonic() + BUDGET_S
    obstacles = [(r[0] - LANE, r[1] - LANE, r[2] + LANE, r[3] + LANE) for r in rects_all.values()]
    stub = LANE - GAP  # a search starts and ends on the edge of the keep-clear zone around the nodes

    def run(hint: dict[str, list[Point]] | None) -> tuple[dict[str, list[Point]], float]:
        anchors = spread_anchors(nodes, arrows, set(todo), kept, junctions, vias, hint)
        for j, tid in (trunks or {}).items():
            s, e = arrow_ends(by_id[tid])
            _, p = anchors[tid]["s" if e == j else "e"]
            nodes[j]["x"] = round(p[0]) - float(nodes[j]["width"]) / 2
        result: dict[str, list[Point]] = {}
        # per line: the plain way, the directions it leaves and arrives in, the room before the keep-clear zone at each end
        plan: dict[str, tuple[list[Point], tuple[int, int], tuple[int, int], tuple[float, float]]] = {}
        for aid in todo:
            s, e = arrow_ends(by_id[aid])
            if s in junctions or e in junctions:
                pts = result[aid] = _bus_path(nodes, by_id[aid], anchors, junctions)
                if s in junctions and e in junctions:
                    continue
                out_of_dot = s in junctions
                side, p = anchors[aid]["e" if out_of_dot else "s"]
                j = pts[0] if out_of_dot else pts[-1]
                dx = p[0] - j[0]
                toward = (int(math.copysign(1, dx)), 0) if abs(dx) >= 1 and side in ("top", "bottom") else (-NORMALS[side][0], -NORMALS[side][1])
                plan[aid] = (pts, toward, NORMALS[side], (0.0, stub)) if out_of_dot else (pts, NORMALS[side], (-toward[0], -toward[1]), (stub, 0.0))
            elif "s" in anchors.get(aid, {}) and "e" in anchors.get(aid, {}):
                (ss, sp), (es, ep) = anchors[aid]["s"], anchors[aid]["e"]
                plan[aid] = ([sp, ep], NORMALS[ss], NORMALS[es], (stub, stub))
                result[aid] = [sp, ep]

        settled: set[str] = set()  # in the first pass a line that has not been drawn yet is not in the way of the others

        def others_for(aid: str) -> _Others:
            return _Others([(i, p) for i, p in {**kept, **result}.items() if i != aid and p and (i in kept or i in settled or i not in plan)])

        for _pass in range(2):
            for aid in sorted(plan, key=lambda i: _length(plan[i][0])):
                default, na, nb, stubs = plan[aid]
                s, e = arrow_ends(by_id[aid])
                via = [] if (s in junctions or e in junctions) else _candidates(default[0], default[-1], (vias or {}).get(aid, []), (rects_all[s][1], rects_all[s][3]), (rects_all[e][1], rects_all[e][3]))
                settled.add(aid)
                result[aid] = _pick(default, na, nb, stubs, via, [r for i, r in rects_all.items() if i not in (s, e)], obstacles, others_for(aid), deadline)
        score = 0.0
        for aid, pts in result.items():
            s, e = arrow_ends(by_id[aid])
            score += _length(pts) + BEND * _corners(pts) + THROUGH * _through(pts, [r for i, r in rects_all.items() if i not in (s, e)]) + others_for(aid).path_cost(pts)
        return result, score

    first, first_score = run(None)
    second, second_score = run(first)  # order the anchors by where the lines actually arrive from
    return second if second_score < first_score else first


def _bus_path(nodes: dict[str, dict[str, Any]], a: dict[str, Any], anchors: dict[str, dict[str, tuple[str, Point]]], junctions: set[str]) -> list[Point]:
    """A line into or out of a junction dot: along the trunk, or across at the dot's height and then along the branch."""
    s, e = arrow_ends(a)
    if s in junctions and e in junctions:
        return [centre(nodes[s]), centre(nodes[e])]
    out_of_dot = s in junctions
    j = centre(nodes[s if out_of_dot else e])
    side, p = anchors[a["id"]]["e" if out_of_dot else "s"]
    if side in ("top", "bottom") and abs(p[0] - j[0]) >= 1.0:
        mid = [(p[0], j[1])]
    else:
        mid = []
    pts = [j, *mid, p]
    return pts if out_of_dot else pts[::-1]


def add_hops(paths: dict[str, list[Point]], fixed: dict[str, list[Point]]) -> dict[str, list[Point]]:
    """Give the lines in ``paths`` a small hop (a bump) wherever they cross another line.

    ``fixed`` are the lines nobody may redraw, so a new line hops over an old one; between two new
    lines the flatter one hops (the tie goes to the later id). Crossings close to a corner or an end,
    or to another hop, are left as they are."""
    out = dict(paths)
    everyone = {**fixed, **paths}

    def flatness(p: Point, q: Point) -> float:
        return abs(q[1] - p[1]) / (seg_len(p, q) or 1)

    for aid in sorted(paths):
        pts = out[aid]
        found: dict[int, list[Point]] = {}
        for i, (p, q) in enumerate(zip(pts, pts[1:])):
            if seg_len(p, q) < 3 * HOP_R:
                continue
            for oid, opts in everyone.items():
                if oid == aid or not opts:
                    continue
                for r, s in zip(opts, opts[1:]):
                    c = cross_point(p, q, r, s)
                    if c is None or seg_len(c, p) < HOP_R + 3 or seg_len(c, q) < HOP_R + 3:
                        continue
                    if any(seg_len(c, e) < 2 * HOP_R for e in (opts[0], opts[-1], pts[0], pts[-1])):
                        continue
                    if oid in paths and (flatness(r, s), oid) < (flatness(p, q), aid):
                        continue  # the other one is flatter: it hops
                    found.setdefault(i, []).append(c)
        if not found:
            continue
        new: list[Point] = [pts[0]]
        for i, (p, q) in enumerate(zip(pts, pts[1:])):
            length = seg_len(p, q) or 1
            ux, uy = (q[0] - p[0]) / length, (q[1] - p[1]) / length
            nx, ny = -uy, ux
            if ny > 1e-9 or (abs(ny) <= 1e-9 and nx < 0):
                nx, ny = -nx, -ny  # the bump goes up (or to the right on a vertical line)
            last = None
            for c in sorted(found.get(i, []), key=lambda c: (c[0] - p[0]) * ux + (c[1] - p[1]) * uy):
                along = (c[0] - p[0]) * ux + (c[1] - p[1]) * uy
                if last is not None and along - last < 3 * HOP_R:
                    continue
                last = along
                a, b = (c[0] - ux * HOP_R, c[1] - uy * HOP_R), (c[0] + ux * HOP_R, c[1] + uy * HOP_R)
                new += [a, (a[0] + nx * HOP_R, a[1] + ny * HOP_R), (b[0] + nx * HOP_R, b[1] + ny * HOP_R), b]
            new.append(q)
        out[aid] = new
    return out
