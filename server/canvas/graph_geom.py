"""Plane geometry of a diagram, shared by ``graph_lint`` (measure) and ``graph_layout`` (arrange).

A *scene* is what ``agora canvas read`` prints: ``nodes`` (``x, y, width, height``), ``arrows``
(``start`` / ``end`` ids, optionally the drawn ``path`` as absolute points), ``junctions``
(small dots where lines meet; they are not nodes). Pure functions over plain dicts and tuples: no
page, no files, so the page's executor and the server's fallback executor use the same numbers.
"""

from __future__ import annotations

import math
from typing import Any, Iterable

Point = tuple[float, float]
Rect = tuple[float, float, float, float]  # x0, y0, x1, y1

GAP = 6  # an arrow stops this far outside its node (the page's arrows do the same)
MIN_GAP = 40  # nodes keep this much air between them (the skill's rule)
HOP_LEG = 16  # a hop is a small bump: its two legs are at most this long …
HOP_TOP = 28  # … and its top at most this wide
EPS = 1e-9


def rect_of(n: dict[str, Any]) -> Rect:
    x, y = float(n["x"]), float(n["y"])
    return (x, y, x + float(n["width"]), y + float(n["height"]))


def centre(n: dict[str, Any]) -> Point:
    return (float(n["x"]) + float(n["width"]) / 2, float(n["y"]) + float(n["height"]) / 2)


def edge_point(n: dict[str, Any], tx: float, ty: float, gap: float = GAP) -> Point:
    """Where the ray from the node's centre towards (tx, ty) leaves the node, pushed out by ``gap``
    (``edgePoint`` in web/src/canvas/scene.ts)."""
    cx, cy = centre(n)
    dx, dy = tx - cx, ty - cy
    if not dx and not dy:
        return (cx, cy)
    hw, hh = float(n["width"]) / 2 + gap, float(n["height"]) / 2 + gap
    if n.get("type") == "ellipse":
        t = 1 / math.hypot(dx / hw, dy / hh)
    elif n.get("type") == "diamond":
        t = 1 / (abs(dx) / hw + abs(dy) / hh)
    else:
        t = min(hw / abs(dx) if dx else math.inf, hh / abs(dy) if dy else math.inf)
    return (cx + dx * t, cy + dy * t)


def default_path(a: dict[str, Any], b: dict[str, Any]) -> list[Point]:
    """The straight arrow the page draws between two nodes."""
    ca, cb = centre(a), centre(b)
    return [edge_point(a, *cb), edge_point(b, *ca)]


def elements_by_id(scene: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Nodes and junctions by id (a junction is geometry an arrow can end on, not a node)."""
    out = {n["id"]: n for n in scene.get("nodes", [])}
    out.update({j["id"]: {"type": "ellipse", **j} for j in scene.get("junctions", [])})
    return out


def arrow_ends(a: dict[str, Any]) -> tuple[str | None, str | None]:
    return ((a.get("start") or {}).get("id"), (a.get("end") or {}).get("id"))


def arrow_path(a: dict[str, Any], by_id: dict[str, dict[str, Any]]) -> list[Point]:
    """The drawn polyline: the arrow's own ``path`` if it has one, else the straight default."""
    if a.get("path"):
        return [(float(p[0]), float(p[1])) for p in a["path"]]
    s, e = arrow_ends(a)
    if s in by_id and e in by_id:
        return default_path(by_id[s], by_id[e])
    return []


def seg_len(p: Point, q: Point) -> float:
    return math.hypot(q[0] - p[0], q[1] - p[1])


def path_length(pts: list[Point]) -> float:
    return sum(seg_len(p, q) for p, q in zip(pts, pts[1:]))


def hop_spans(pts: list[Point]) -> list[int]:
    """Indexes ``i`` where ``pts[i..i+3]`` is a hop: a short bump (leg out, top across, leg back)."""
    out = []
    i = 0
    while i + 3 < len(pts):
        p0, p1, p2, p3 = pts[i : i + 4]
        s1, s2, s3 = (p1[0] - p0[0], p1[1] - p0[1]), (p2[0] - p1[0], p2[1] - p1[1]), (p3[0] - p2[0], p3[1] - p2[1])
        l1, l2 = math.hypot(*s1), math.hypot(*s2)
        if (
            4 <= l1 <= HOP_LEG
            and 4 <= l2 <= HOP_TOP
            and math.hypot(s1[0] + s3[0], s1[1] + s3[1]) <= 2.5  # legs are equal and opposite (coordinates are whole numbers, so allow rounding)
            and abs(s1[0] * s2[0] + s1[1] * s2[1]) <= 0.25 * l1 * l2  # … and stand on the top
        ):
            out.append(i)
            i += 3
        else:
            i += 1
    return out


def segments(pts: list[Point]) -> list[tuple[Point, Point, bool]]:
    """Each segment of the polyline, and whether it belongs to a hop."""
    hop = set()
    for i in hop_spans(pts):
        hop.update((i, i + 1, i + 2))
    return [(p, q, k in hop) for k, (p, q) in enumerate(zip(pts, pts[1:]))]


def bend_count(pts: list[Point]) -> int:
    """Corners of the line (a hop's bump is not a bend)."""
    drop = set()
    for i in hop_spans(pts):
        drop.update((i + 1, i + 2))
    kept = [p for k, p in enumerate(pts) if k not in drop]
    n = 0
    for a, b, c in zip(kept, kept[1:], kept[2:]):
        cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if abs(cross) > 1e-6 * max(seg_len(a, b) * seg_len(b, c), 1):
            n += 1
    return n


def cross_point(p: Point, q: Point, r: Point, s: Point) -> Point | None:
    """Where segments pq and rs properly cross (through each other's inside), else None."""
    d1 = (q[0] - p[0], q[1] - p[1])
    d2 = (s[0] - r[0], s[1] - r[1])
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < EPS:
        return None
    t = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / den
    u = ((r[0] - p[0]) * d1[1] - (r[1] - p[1]) * d1[0]) / den
    if not (1e-6 < t < 1 - 1e-6 and 1e-6 < u < 1 - 1e-6):
        return None
    return (p[0] + t * d1[0], p[1] + t * d1[1])


def collinear_run(p: Point, q: Point, r: Point, s: Point) -> float:
    """Length two parallel segments run on top of each other (0 when they are not collinear)."""
    d1 = (q[0] - p[0], q[1] - p[1])
    l1 = math.hypot(*d1)
    if l1 < EPS:
        return 0.0
    ux, uy = d1[0] / l1, d1[1] / l1
    if abs((r[0] - p[0]) * uy - (r[1] - p[1]) * ux) > 1.5 or abs((s[0] - p[0]) * uy - (s[1] - p[1]) * ux) > 1.5:
        return 0.0
    a0, a1 = 0.0, l1
    b0, b1 = sorted(((r[0] - p[0]) * ux + (r[1] - p[1]) * uy, (s[0] - p[0]) * ux + (s[1] - p[1]) * uy))
    return max(0.0, min(a1, b1) - max(a0, b0))


def seg_hits_rect(p: Point, q: Point, r: Rect, shrink: float = 2.0) -> bool:
    """Whether the segment passes through the inside of the rectangle (shrunk a little, so grazing does not count)."""
    x0, y0, x1, y1 = r[0] + shrink, r[1] + shrink, r[2] - shrink, r[3] - shrink
    if x0 >= x1 or y0 >= y1:
        return False
    dx, dy = q[0] - p[0], q[1] - p[1]
    t0, t1 = 0.0, 1.0
    for pp, dd, lo, hi in ((p[0], dx, x0, x1), (p[1], dy, y0, y1)):
        if abs(dd) < EPS:
            if pp <= lo or pp >= hi:
                return False
            continue
        a, b = (lo - pp) / dd, (hi - pp) / dd
        a, b = min(a, b), max(a, b)
        t0, t1 = max(t0, a), min(t1, b)
        if t0 >= t1:
            return False
    return True


def rects_overlap(a: Rect, b: Rect, margin: float = 0.5) -> bool:
    return a[0] + margin < b[2] and b[0] + margin < a[2] and a[1] + margin < b[3] and b[1] + margin < a[3]


def rect_gap(a: Rect, b: Rect) -> float:
    """The larger of the horizontal and vertical air between two rectangles (0 when they touch or overlap)."""
    return max(max(a[0] - b[2], b[0] - a[2], 0.0), max(a[1] - b[3], b[1] - a[3], 0.0))


def text_width(s: str, size: float = 14) -> float:
    """A label's width: wide (CJK) characters take a full em, the rest about half."""
    return sum(size if ord(c) > 0x2E80 else size * 0.55 for c in s)


LABEL_H = 22
NODE_FONT = 16  # a node's own label (an arrow's label is 14)
USABLE = {"ellipse": 0.7, "diamond": 0.5}  # the part of a box's width the text has to fit in


def label_width(label: str, shape: str = "rectangle") -> float:
    """Width of the widest line of a node's label, and the room the shape leaves for it (compare with the box's width)."""
    return max((text_width(line, NODE_FONT) for line in str(label).split("\n")), default=0.0) / USABLE.get(shape, 1.0)


def fit_size(label: str, shape: str = "rectangle", minimum: tuple[float, float] = (160, 64), widest: float = 360) -> tuple[float, float]:
    """A box for a new node that its label fits in: the default size, or wider (and taller for several lines)."""
    lines = str(label).split("\n")
    return (min(widest, max(minimum[0], math.ceil((label_width(label, shape) + 36) / 8) * 8)), max(minimum[1], 24 * len(lines) + 24))


def label_rect(a: dict[str, Any], pts: list[Point]) -> Rect | None:
    """Where an arrow's label is drawn: centred on the middle of the line — as Excalidraw does it, the middle
    point of the polyline, or the middle of its two middle points."""
    label = a.get("label")
    if not label or len(pts) < 2:
        return None
    n = len(pts)
    cx, cy = pts[n // 2] if n % 2 else ((pts[n // 2 - 1][0] + pts[n // 2][0]) / 2, (pts[n // 2 - 1][1] + pts[n // 2][1]) / 2)
    w = text_width(str(label)) + 8
    return (cx - w / 2, cy - LABEL_H / 2, cx + w / 2, cy + LABEL_H / 2)


def near(p: Point, q: Point, d: float) -> bool:
    return seg_len(p, q) <= d


def bbox_of(items: Iterable[dict[str, Any]]) -> Rect | None:
    rs = [rect_of(n) for n in items]
    if not rs:
        return None
    return (min(r[0] for r in rs), min(r[1] for r in rs), max(r[2] for r in rs), max(r[3] for r in rs))
