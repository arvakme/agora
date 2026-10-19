// 剖面 walking (web/docs/workstation.md §小人): how a worker gets from one spot to another when the
// diagram is read as a cross-section. A node's top edge is a floor, walked. An arrow bound to two
// nodes is a call — data flowing — so a worker that goes along one goes like a packet: it glides
// along the arrow's own drawn line (straight, slanted or elbowed; its elbows rounded), from where the
// arrow leaves the node to where it arrives (round the node's outline from its top edge to that port
// and back up at the other end). Where no arrow leads, a temporary scaffold goes up over everything
// between and down again (bridges and ladders, drawn only while someone walks them; the drawing itself
// never changes). Pure (type-only imports), so it runs under vitest in node.
import type { Box } from "../canvas/clearance";
import type { Pt } from "./rig";

/** An arrow bound to a node at each end: a world-coordinate polyline from `from`'s edge to `to`'s. */
export type Connector = { from: string; to: string; pts: readonly Pt[] };
/**
 * One stretch of a route. `walk`: along a floor (a node's top edge; nothing to draw). `bridge`: level,
 * across a gap. `climb`: up or down a ladder (one of ≤ 4 px is a step between floors that count as
 * level). `glide`: a straight piece of an arrow's line (its rounded elbows are many short pieces), or of a
 * node's outline between its top edge and the arrow's port, glided along as a capsule (§5 沿箭头滑行).
 * `temp`: that bridge or ladder is a temporary scaffold (drawn dashed), not a connector's; a walk or a
 * glide never is.
 */
export type Leg = { kind: "walk" | "bridge" | "climb" | "glide"; a: Pt; b: Pt; temp: boolean };
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
const WALL = 10; // a ladder beside a node stands this far off its wall
const OVER = 24; // a scaffold runs this far above the highest thing under it
/** A glide's corners (an arrow's elbows, the turns round a node's outline) are rounded to this radius (world px, at most half of either side). */
export const GLIDE_ROUND = 16;
const BEND_STEPS = 8; // pieces to a rounded corner
const JOG = 8; // world px: a glide's corners closer than this to the next are cut across

/**
 * The walking map of one diagram: node boxes by place (the tray too, under the caller's key), the
 * connectors between them (arrows bound at both ends; others are ignored) and everything else drawn
 * (scaffolds keep above it).
 */
export function walkMap(boxes: ReadonlyMap<string, Box>, connectors: readonly Connector[], obstacles: readonly Box[] = []): WalkMap {
  const links = new Map<string, { to: string; c: Connector; w: number }[]>();
  for (const c of connectors) {
    if (c.from === c.to || !boxes.has(c.from) || !boxes.has(c.to) || c.pts.length < 2) continue;
    // its drawn length: it is glided along as drawn, a slanted stretch straight
    const w = c.pts.reduce((n, p, i) => (i ? n + Math.hypot(p.x - c.pts[i - 1].x, p.y - c.pts[i - 1].y) : 0), 0);
    for (const [a, to] of [[c.from, c.to], [c.to, c.from]]) links.set(a, [...(links.get(a) ?? []), { to, c, w }]);
  }
  return { boxes, obstacles, links };
}

/**
 * The way from one spot to another. On one node: along its top edge. Otherwise hop by hop along the
 * shortest chain of connectors (by drawn length): walk along the top edge to the point nearest the
 * arrow's port, then glide — round the node's outline to the port, along the arrow's own line (elbows
 * rounded, GLIDE_ROUND), round the other node's outline up to its top edge — and walk on. No chain: a
 * temporary scaffold (bridges and ladders). A spot off its node's top edge (beside or under it) first
 * gets onto the top. Walks, bridges and ladders never go inside a node, except one that holds a spot
 * (a glide goes where the arrow is drawn). Pure.
 */
export function route(m: WalkMap, from: Spot, to: Spot): Route {
  const A = m.boxes.get(from.place) ?? dot(from.at);
  const B = m.boxes.get(to.place) ?? dot(to.at);
  const free = (b: Box) => !within(b, from.at) && !within(b, to.at);
  const solid = [...m.boxes.values()].filter(free);
  const floors = [...m.boxes.values()];
  const up = onto(from.at, A, to.at.x); // [from.at, …, on A's floor]
  const down = onto(to.at, B, from.at.x).reverse(); // [on B's floor, …, to.at]
  const go = (via: Pt[], temp: boolean) => path(from.at, [[up.slice(1), true], [[...via, down[0]], temp], [down.slice(1), true]]);
  let legs: Leg[] | undefined;
  if (from.place === to.place) legs = split(from.at.y === to.at.y ? path(from.at, [[[to.at], true]]) : go([], true), floors);
  else {
    const hops = chain(m, from.place, to.place);
    if (hops) {
      const out: Leg[] = [...split(path(from.at, [[up.slice(1), true]]), floors)];
      const add = (kind: Leg["kind"], a: Pt, b: Pt) => {
        if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) out.push({ kind, a, b, temp: false });
      };
      // along a top edge to where a glide starts (or on from where it ends): a walk, and a bridge where it goes past the node's end
      const level = (a: Pt, b: Pt) => out.push(...split(path(a, [[[b], false]]), floors));
      // each hop's line: round its node's outline from the top edge to the arrow's port, along the arrow, round the next node's outline up to its top edge.
      // Hops that meet where one arrives and the next leaves (the same point on a node's top edge) are one glide: it does not surface between them.
      const ways: Pt[][] = [];
      let a = A;
      let place = from.place;
      for (const h of hops) {
        const b = m.boxes.get(h.place)!;
        const pts = h.c.from === place ? [...h.c.pts] : [...h.c.pts].reverse();
        const raw = [...rim(a, pts[0]), ...pts.slice(1, -1), ...rim(b, pts[pts.length - 1]).reverse()];
        const last = ways[ways.length - 1];
        const end = last?.[last.length - 1];
        if (end && Math.hypot(end.x - raw[0].x, end.y - raw[0].y) < 1e-6) last.push(...raw.slice(1));
        else ways.push(raw);
        a = b;
        place = h.place;
      }
      let at = up[up.length - 1];
      for (const raw of ways) {
        const way = rounded(raw);
        level(at, way[0]);
        for (let i = 1; i < way.length; i++) add("glide", way[i - 1], way[i]);
        at = way[way.length - 1];
      }
      level(at, down[0]);
      legs = [...out, ...split(path(down[0], [[down.slice(1), true]]), floors)];
    } else legs = split(go(scaffold(up[up.length - 1], A, down[0], B, solid, [...solid, ...m.obstacles.filter(free)]), true), floors);
  }
  return { legs, len: legs.reduce((n, l) => n + Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), 0) };
}

const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/**
 * From a node's top edge round its outline to `p`, where an arrow leaves it (on its edge, or a little off it): the points, the first on the top edge.
 * A port on the top edge is right under the feet; on a side, from that side's top corner down to it; on the bottom, from the nearer top corner down
 * that side and along the bottom.
 */
function rim(b: Box, p: Pt): Pt[] {
  const q = { x: clampTo(p.x, b.x, b.x + b.w), y: clampTo(p.y, b.y, b.y + b.h) };
  const d = { top: Math.abs(p.y - b.y) + Math.abs(p.x - q.x), right: Math.abs(p.x - b.x - b.w) + Math.abs(p.y - q.y), left: Math.abs(p.x - b.x) + Math.abs(p.y - q.y), bottom: Math.abs(p.y - b.y - b.h) + Math.abs(p.x - q.x) };
  const side = (Object.keys(d) as (keyof typeof d)[]).reduce((s, k) => (d[k] < d[s] - 1e-6 ? k : s), "top");
  const r = b.x + b.w;
  const pts: Pt[] =
    side === "top"
      ? [{ x: q.x, y: b.y }]
      : side === "left" || side === "right"
        ? [{ x: side === "left" ? b.x : r, y: b.y }, { x: side === "left" ? b.x : r, y: q.y }]
        : ((x: number) => [{ x, y: b.y }, { x, y: b.y + b.h }, { x: q.x, y: b.y + b.h }])(q.x - b.x <= r - q.x ? b.x : r);
  return [...pts, p];
}

/** A polyline without repeated or straight-through points, its corners rounded (a quadratic curve over GLIDE_ROUND either side, at most half a side), as short straight pieces. */
function rounded(raw: readonly Pt[]): Pt[] {
  const pts: Pt[] = [];
  for (const p of raw) {
    // straight on through the last point, or back over it (up a node's side to its top and straight down again to a port further down): it is not a corner
    for (;;) {
      const q = pts[pts.length - 1];
      const o = pts[pts.length - 2];
      if (!o || !q || Math.abs((q.x - o.x) * (p.y - q.y) - (q.y - o.y) * (p.x - q.x)) > 1e-6) break;
      pts.pop();
    }
    const q = pts[pts.length - 1];
    if (q && Math.hypot(p.x - q.x, p.y - q.y) < 1e-6) continue;
    pts.push(p);
  }
  // a jog of a few px (an arrow that ends a little off the node's outline, at a corner) is not a bend to slow down for: cut across it
  for (let i = 1; i < pts.length - 1; ) {
    const near = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < JOG;
    if (near(pts[i], pts[i - 1]) || near(pts[i], pts[i + 1])) pts.splice(i, 1);
    else i++;
  }
  if (pts.length < 3) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, v, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const la = Math.hypot(a.x - v.x, a.y - v.y);
    const lc = Math.hypot(c.x - v.x, c.y - v.y);
    const r = Math.min(GLIDE_ROUND, la / 2, lc / 2);
    const p1 = { x: v.x + ((a.x - v.x) * r) / la, y: v.y + ((a.y - v.y) * r) / la };
    const p2 = { x: v.x + ((c.x - v.x) * r) / lc, y: v.y + ((c.y - v.y) * r) / lc };
    for (let s = 0; s <= BEND_STEPS; s++) {
      const u = s / BEND_STEPS;
      const p = { x: (1 - u) ** 2 * p1.x + 2 * u * (1 - u) * v.x + u * u * p2.x, y: (1 - u) ** 2 * p1.y + 2 * u * (1 - u) * v.y + u * u * p2.y };
      const q = out[out.length - 1];
      if (Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) out.push(p);
    }
  }
  const last = pts[pts.length - 1];
  const q = out[out.length - 1];
  if (Math.hypot(last.x - q.x, last.y - q.y) > 1e-6) out.push(last);
  return out;
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
