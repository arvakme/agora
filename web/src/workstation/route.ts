// 剖面 walking (web/docs/workstation.md §小人): how a worker gets from one spot to another when the
// diagram is read as a cross-section. A node's top edge is a floor; an arrow bound to two nodes is
// the way between their floors — where it runs level it is a bridge, where it rises a ladder; where
// no arrow leads (or its way would cut through a node) a temporary scaffold goes up over everything
// between and down again. Bridges and ladders are drawn only while someone walks them; the drawing
// itself never changes. Pure (type-only imports), so it runs under vitest in node.
import type { Box } from "../canvas/clearance";
import type { Pt } from "./rig";

/** An arrow bound to a node at each end: a world-coordinate polyline from `from`'s edge to `to`'s. */
export type Connector = { from: string; to: string; pts: readonly Pt[] };
/**
 * One stretch of a route. `walk`: along a floor (a node's top edge; nothing to draw). `bridge`: level,
 * across a gap. `climb`: up or down a ladder (one of ≤ 4 px is a step between floors that count as
 * level). `temp`: that bridge or ladder is a temporary scaffold (drawn dashed), not a connector's;
 * a walk never is.
 */
export type Leg = { kind: "walk" | "bridge" | "climb"; a: Pt; b: Pt; temp: boolean };
/** Legs end to end from the start spot to the end spot; `len` is their total length (world px). */
export type Route = { legs: Leg[]; len: number };
/** A diagram's floors and ways (walkMap); built once per scene version, read by route. */
export type WalkMap = {
  boxes: ReadonlyMap<string, Box>;
  obstacles: readonly Box[];
  links: ReadonlyMap<string, readonly { to: string; c: Connector; w: number }[]>;
};
/** Where a worker stands: its place (a node's element id, or the caller's key for the 图外 tray) and its feet. */
type Spot = { place: string; at: Pt };
type Stop = { p: Pt; temp: boolean };

const E = 0.5; // world px that still count as the same line
const LEVEL = 4; // tops this close are one level: a bridge across, no ladder
const WALL = 10; // a ladder beside a node stands this far off its wall
const OVER = 24; // a scaffold runs this far above the highest thing under it

/**
 * The walking map of one diagram: node boxes by place (the tray too, under the caller's key), the
 * connectors between them (arrows bound at both ends; others are ignored) and everything else drawn
 * (scaffolds keep above it).
 */
export function walkMap(boxes: ReadonlyMap<string, Box>, connectors: readonly Connector[], obstacles: readonly Box[] = []): WalkMap {
  const links = new Map<string, { to: string; c: Connector; w: number }[]>();
  for (const c of connectors) {
    if (c.from === c.to || !boxes.has(c.from) || !boxes.has(c.to) || c.pts.length < 2) continue;
    // its length made orthogonal: a slanted stretch counts as its level and upright parts
    const w = c.pts.reduce((n, p, i) => (i ? n + Math.abs(p.x - c.pts[i - 1].x) + Math.abs(p.y - c.pts[i - 1].y) : 0), 0);
    for (const [a, to] of [[c.from, c.to], [c.to, c.from]]) links.set(a, [...(links.get(a) ?? []), { to, c, w }]);
  }
  return { boxes, obstacles, links };
}

/**
 * The way from one spot to another. On one node: along its top edge. Otherwise hop by hop along the
 * shortest chain of connectors (by orthogonal length): side by side, a bridge across the gap, with a
 * ladder in it where the tops differ by more than 4 px (at the arrow's upright stretch, else mid-gap);
 * stacked, a ladder 10 px off the upper node's wall on the side nearer the destination. No chain, or
 * a hop that would cut through a node: a temporary scaffold. A spot off its node's top edge (beside
 * or under it) first gets onto the top. Never inside a node, except one that holds a spot. Pure.
 */
export function route(m: WalkMap, from: Spot, to: Spot): Route {
  const A = m.boxes.get(from.place) ?? dot(from.at);
  const B = m.boxes.get(to.place) ?? dot(to.at);
  const free = (b: Box) => !within(b, from.at) && !within(b, to.at);
  const solid = [...m.boxes.values()].filter(free);
  const up = onto(from.at, A, to.at.x); // [from.at, …, on A's floor]
  const down = onto(to.at, B, from.at.x).reverse(); // [on B's floor, …, to.at]
  const go = (via: Pt[], temp: boolean) => path(from.at, [[up.slice(1), true], [[...via, down[0]], temp], [down.slice(1), true]]);
  let stops: Stop[] | undefined;
  if (from.place === to.place) stops = from.at.y === to.at.y ? path(from.at, [[[to.at], true]]) : go([], true);
  else {
    const hops = chain(m, from.place, to.place);
    if (hops) {
      const via: Pt[] = [];
      let a = A;
      for (const h of hops) {
        const b = m.boxes.get(h.place)!;
        const x = ladder(a, b, h.c, to.at.x);
        via.push({ x, y: a.y }, { x, y: b.y });
        a = b;
      }
      const s = go(via, false);
      if (!s.some((q, i) => i > 0 && solid.some((b) => cuts(s[i - 1].p, q.p, b)))) stops = s;
    }
    stops ??= go(scaffold(up[up.length - 1], A, down[0], B, solid, [...solid, ...m.obstacles.filter(free)]), true);
  }
  const legs = split(stops, [...m.boxes.values()]);
  return { legs, len: legs.reduce((n, l) => n + Math.abs(l.b.x - l.a.x) + Math.abs(l.b.y - l.a.y), 0) };
}

const dot = (p: Pt): Box => ({ x: p.x, y: p.y, w: 0, h: 0 });
/** p is strictly inside b (a node that holds a spot is not in the way). */
const within = (b: Box, p: Pt) => p.x > b.x + E && p.x < b.x + b.w - E && p.y > b.y + E && p.y < b.y + b.h - E;
/** The level or upright move p → q goes inside b. */
const cuts = (p: Pt, q: Pt, b: Box) =>
  Math.max(p.x, q.x) > b.x + E && Math.min(p.x, q.x) < b.x + b.w - E && Math.max(p.y, q.y) > b.y + E && Math.min(p.y, q.y) < b.y + b.h - E;

/** From a spot onto its node's floor: beside or above the node straight up or down; under it, out to the side nearer `toward` first. */
function onto(at: Pt, b: Box, toward: number): Pt[] {
  if (at.y === b.y) return [at];
  if (at.y < b.y || at.x <= b.x || at.x >= b.x + b.w) return [at, { x: at.x, y: b.y }];
  const x = Math.abs(b.x - WALL - toward) <= Math.abs(b.x + b.w + WALL - toward) ? b.x - WALL : b.x + b.w + WALL;
  return [at, { x, y: at.y }, { x, y: b.y }];
}

/** The shortest chain of connectors from one place to another (Dijkstra; ties go to the first found): each hop's place and connector. */
function chain(m: WalkMap, from: string, to: string): { place: string; c: Connector }[] | null {
  const dist = new Map([[from, 0]]);
  const prev = new Map<string, { place: string; c: Connector }>();
  const done = new Set<string>();
  for (;;) {
    let u: string | undefined;
    for (const [k, d] of dist) if (!done.has(k) && (u === undefined || d < dist.get(u)!)) u = k;
    if (u === undefined) return null;
    if (u === to) break;
    done.add(u);
    for (const l of m.links.get(u) ?? []) {
      const d = dist.get(u)! + l.w;
      const old = dist.get(l.to);
      if (old === undefined || d < old) {
        dist.set(l.to, d);
        prev.set(l.to, { place: u, c: l.c });
      }
    }
  }
  const hops: { place: string; c: Connector }[] = [];
  for (let p = to; p !== from; p = prev.get(p)!.place) hops.unshift({ place: p, c: prev.get(p)!.c });
  return hops;
}

/** Where the hop from floor a to floor b changes level: the ladder's x (b's facing wall when the tops are level). */
function ladder(a: Box, b: Box, c: Connector, dest: number): number {
  const right = b.x - (a.x + a.w) > E;
  if (right || a.x - (b.x + b.w) > E) {
    // side by side
    const wb = right ? b.x : b.x + b.w;
    if (Math.abs(a.y - b.y) <= LEVEL) return wb;
    const lo = Math.min(right ? a.x + a.w : a.x, wb);
    const hi = Math.max(right ? a.x + a.w : a.x, wb);
    const i = c.pts.findIndex((p, i) => i > 0 && Math.abs(p.x - c.pts[i - 1].x) <= 1 && p.y !== c.pts[i - 1].y && p.x > lo && p.x < hi);
    return i > 0 ? (c.pts[i].x + c.pts[i - 1].x) / 2 : (lo + hi) / 2;
  }
  // stacked: beside the upper one's wall
  const u = a.y <= b.y ? a : b;
  const l = u.x - WALL;
  const r = u.x + u.w + WALL;
  return Math.abs(l - dest) <= Math.abs(r - dest) ? l : r;
}

/**
 * A temporary scaffold from floor a (at p) to floor b (at q): up at a's corner nearer q, across 24 px
 * over the highest thing between, down at b's corner nearer that — or right where the worker is, when
 * it is already out past that corner. A corner that something hangs over gives way to the cheapest
 * column beside that thing's wall. Returns the four turns.
 */
function scaffold(p: Pt, a: Box, q: Pt, b: Box, solid: readonly Box[], tops: readonly Box[]): Pt[] {
  const column = (n: Box, y: number, from: number, other: number) => {
    const over = solid.filter((s) => s.y < y - E);
    const cost = (x: number) => Math.abs(x - from) + Math.abs(x - other);
    const corners = [n.x, n.x + n.w].sort((u, v) => Math.abs(u - other) - Math.abs(v - other));
    if ((from - corners[0]) * (corners[0] - corners[1]) > 0) corners.unshift(from);
    const walls = over.flatMap((s) => [s.x - WALL, s.x + s.w + WALL]).sort((u, v) => cost(u) - cost(v) || u - v);
    const clear = (x: number) => !over.some((s) => x > s.x + E && x < s.x + s.w - E) && !solid.some((s) => cuts({ x: from, y }, { x, y }, s));
    return [...corners, ...walls].find(clear) ?? corners[0];
  };
  const xa = column(a, a.y, p.x, q.x);
  const xb = column(b, b.y, q.x, xa);
  const lo = Math.min(xa, xb);
  const hi = Math.max(xa, xb);
  const top = Math.min(a.y, b.y, ...tops.filter((t) => t.x < hi - E && t.x + t.w > lo + E).map((t) => t.y)) - OVER;
  return [{ x: xa, y: a.y }, { x: xa, y: top }, { x: xb, y: top }, { x: xb, y: b.y }];
}

/**
 * The stops from `start` through each part's points (a part's moves share its `temp`). A move that goes
 * nowhere is dropped, one that carries straight on joins the one before, one that doubles back is cut short.
 */
function path(start: Pt, parts: [readonly Pt[], boolean][]): Stop[] {
  const s: Stop[] = [{ p: start, temp: false }];
  const same = (u: Pt, v: Pt) => u.x === v.x && u.y === v.y;
  for (const [pts, t] of parts)
    for (const p of pts) {
      let temp = t;
      let q = s[s.length - 1];
      while (s.length > 1 && !same(q.p, p)) {
        const o = s[s.length - 2].p;
        if (!((o.x === q.p.x && q.p.x === p.x) || (o.y === q.p.y && q.p.y === p.y))) break;
        const back = (q.p.x - o.x) * (p.x - q.p.x) + (q.p.y - o.y) * (p.y - q.p.y) < 0;
        if (!back && q.temp !== temp) break;
        // doubling back short of o: what is left of the move was walked on the way out
        if (back && (q.p.x - o.x) * (p.x - o.x) + (q.p.y - o.y) * (p.y - o.y) > 0) temp = q.temp;
        s.pop();
        q = s[s.length - 1];
      }
      if (!same(q.p, p)) s.push({ p, temp });
    }
  return s;
}

/** Legs along the stops: upright moves climb; level ones split where they step on or off a floor (any node's top edge at that height). */
function split(stops: readonly Stop[], floors: readonly Box[]): Leg[] {
  const out: Leg[] = [];
  const add = (kind: Leg["kind"], a: Pt, b: Pt, temp: boolean) => {
    const l = out[out.length - 1];
    if (l && l.kind === kind && l.temp === temp && (l.b.x - l.a.x) * (b.x - a.x) + (l.b.y - l.a.y) * (b.y - a.y) > 0) l.b = b;
    else out.push({ kind, a, b, temp });
  };
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1].p;
    const { p: b, temp } = stops[i];
    if (a.x === b.x) {
      add("climb", { x: a.x, y: a.y }, { x: b.x, y: b.y }, temp);
      continue;
    }
    const on = floors.filter((f) => Math.abs(f.y - a.y) <= E);
    const xs = [...new Set([a.x, b.x, ...on.flatMap((f) => [f.x, f.x + f.w])])].filter((x) => (x - a.x) * (x - b.x) <= 0).sort((u, v) => (u - v) * Math.sign(b.x - a.x));
    for (let j = 1; j < xs.length; j++) {
      const mid = (xs[j - 1] + xs[j]) / 2;
      const floor = on.some((f) => mid >= f.x && mid <= f.x + f.w);
      add(floor ? "walk" : "bridge", { x: xs[j - 1], y: a.y }, { x: xs[j], y: a.y }, !floor && temp);
    }
  }
  return out;
}
