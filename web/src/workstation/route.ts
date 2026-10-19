// 剖面 walking (web/docs/workstation.md §小人): how a worker gets from one spot to another when the
// diagram is read as a cross-section. A node's top edge is a floor, walked. An arrow bound to the two
// nodes is a call — data flowing — so a worker that goes along one goes like a packet: it glides along
// the arrow's own drawn line (straight, slanted or elbowed; its elbows rounded), from where the arrow
// leaves the node to where it arrives (round the node's outline from its top edge to that port and back
// up at the other end) — but only along one arrow straight from node to node, and only when that is not
// much the longer way. Everywhere else it hops (§5 跳过去): it walks along its floor to the point nearest
// where it is going and jumps — one ballistic arc over whatever is between, onto the other floor (two,
// by way of a floor between, when one would have to go too high). Nothing is built and the drawing
// itself never changes. Pure (type-only imports), so it runs under vitest in node.
import type { Box } from "../canvas/clearance";
import type { Pt } from "./rig";

/** An arrow bound to a node at each end: a world-coordinate polyline from `from`'s edge to `to`'s. */
export type Connector = { from: string; to: string; pts: readonly Pt[] };
/**
 * A hop's arc (§5 跳过去), feet from `a` (on one floor) to `b` (on the other): up to `top` (the apex's world y) and down again under one
 * gravity, sideways at an even pace — plus `out` px out to one side and back (4u(1−u) over the arc), to get round the wall of a node
 * it takes off or lands under. Where it is at a share u of its time: `arcAt`.
 */
export type Arc = { a: Pt; b: Pt; top: number; out: number };
/**
 * One stretch of a route. `walk`: along a floor (a node's top edge; nothing to draw). `glide`: a straight piece of an arrow's line
 * (its rounded elbows are many short pieces), or of a node's outline between its top edge and the arrow's port, glided along as a
 * capsule (§5 沿箭头滑行). `hop`: a piece of a hop's arc (`arc`, the same object for every piece of one hop: the pieces are even
 * shares of its time). `bridge` (level, off the floors) and `climb` (up or down; one of ≤ 4 px is a step between floors that count as
 * level) are left for the way without a walk map (./place.ts `straight`) and a level walk under a node's bottom line. `temp`: a
 * temporary scaffold's (no route builds one now); a walk, a glide or a hop never is.
 */
export type Leg = { kind: "walk" | "bridge" | "climb" | "glide" | "hop"; a: Pt; b: Pt; temp: boolean; arc?: Arc };
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
/** What a hop takes off from or lands on: a node's top edge, x0 … x1 at y (`box`), or the one point where a worker stands off it (beside or under its node: x0 = x1). */
type Floor = { x0: number; x1: number; y: number; box: Box | null };

const E = 0.5; // world px that still count as the same line
/** A glide's corners (an arrow's elbows, the turns round a node's outline) are rounded to this radius (world px, at most half of either side). */
export const GLIDE_ROUND = 16;
const BEND_STEPS = 8; // pieces to a rounded corner
const JOG = 8; // world px: a glide's corners closer than this to the next are cut across
/** Along an arrow only when that way is at most this many times the length of the hop's: a glide that goes the long way round (down a node's side to a port on its bottom, out and back) is not taken. */
export const GLIDE_OVER = 1.3;

// ——— the hop (§5 跳过去) ———
/** Cartoon gravity (world px/ms², 1300 px/s²): a hop over a gap takes 0.3 s in the air, one up or down a node's height 0.5–0.8 s, and nothing comes down faster than 1 px/ms (60 fps: 16 px a frame) from 360 px up. */
export const HOP_G = 0.0013;
/** The crouch before a hop (anticipation, the push at its end) and the squash after it (the catch and getting up), ms. */
export const HOP_CROUCH_MS = 130;
export const HOP_LAND_MS = 130;
/** The apex rises at least this far over the higher floor (a level or a downward hop still reads as a jump)… */
const HOP_LIFT = 14;
/** …and at least this share of the hop's span (a wide one is a long jump, not a skim)… */
const HOP_LOB = 0.12;
/** …and high enough that it goes sideways no faster than this (px/ms): a wide hop goes higher, not flatter. */
const HOP_VX = 0.6;
/** A hop's feet keep this far over what is under them (px), the body this far to either side of it, and the body (feet to head, tucked) is this tall: nothing passes through a node or a drawn thing on the way. The nodes it takes off from and lands on are kept off by the feet's line alone. */
const HOP_OVER = 14;
const HOP_PAD = 6;
const HOP_BODY = 40;
/** …and off the walls of the two nodes at its ends by this much: it falls past the node it stepped off, not down its edge. */
const OWN_PAD = 4;
/** One arc that has to go higher than this over the higher floor (a tall node between) is two hops by way of a floor between, if there is one; HOP_TOP is the most an arc may rise. */
const HOP_HIGH = 160;
const HOP_TOP = 400;
/** A hop's arc is drawn (and traced) in this many pieces, checked at twice as many points. */
export const HOP_STEPS = 24;
/** The sideways swings (px) tried, smallest first, for a hop that takes off or lands under a node and must get round its wall. */
const OUTS = [12, 24, 36, 48, 60].flatMap((o) => [-o, o]);
/** What a px of swinging out costs, choosing between ways to hop (ms): steering in the air reads as odd, so a hop walks to the edge and steps off it rather than swing far out from the middle. */
const OUT_MS = 12;
/** What a px of floor costs in time, choosing between ways to hop: the walking pace (rig.ts WALK_SPEED). */
const WALK_PX_MS = 0.22;

/** Where a hop's feet are at share u of its time: sideways at an even pace (plus the swing out), up and down a parabola under one gravity. */
export function arcAt(arc: Arc, u: number): Pt {
  const { a, b, top, out } = arc;
  const hr = Math.max(0, a.y - top);
  const hf = Math.max(0, b.y - top);
  const s = Math.sqrt(hr) + Math.sqrt(hf);
  const uA = s ? Math.sqrt(hr) / s : 0.5;
  return { x: a.x + (b.x - a.x) * u + out * 4 * u * (1 - u), y: top + s * s * (u - uA) ** 2 };
}
/** How long a hop is in the air (ms): up to its apex and down from it under HOP_G. */
export function hopAir(arc: Pick<Arc, "a" | "b" | "top">): number {
  return Math.sqrt((2 * Math.max(0, arc.a.y - arc.top)) / HOP_G) + Math.sqrt((2 * Math.max(0, arc.b.y - arc.top)) / HOP_G);
}

/**
 * The walking map of one diagram: node boxes by place (the tray too, under the caller's key), the
 * connectors between them (arrows bound at both ends; others are ignored) and everything else drawn
 * (a hop keeps clear of it).
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
 * The way from one spot to another. On one floor: along it. Otherwise a hop (§5 跳过去): walk along the floor to the takeoff, the
 * point of it nearest the landing (or its end), one arc over everything between — its apex HOP_OVER over what is under it, at least
 * HOP_LIFT over the higher floor — onto the other floor at the point nearest the takeoff, and walk on; of the takeoffs and landings
 * that clear everything, the quickest way. A spot off its node's top edge (beside or under it) hops from (or to) where it stands.
 * Where one arrow joins the two nodes directly, it glides along it instead — walk along the top edge to the point nearest the
 * arrow's port, round the node's outline to the port, along the arrow's own line (elbows rounded, GLIDE_ROUND), round the other
 * node's outline up to its top edge, and walk on — unless that way is over GLIDE_OVER times the hop's. Pure.
 */
export function route(m: WalkMap, from: Spot, to: Spot): Route {
  const A = m.boxes.get(from.place) ?? dot(from.at);
  const B = m.boxes.get(to.place) ?? dot(to.at);
  const floors = [...m.boxes.values()];
  const w = world(m, from, to, [A, B]);
  const P = floorOf(from.at, A);
  const Q = floorOf(to.at, B);
  let legs: Leg[];
  if (from.place === to.place && from.at.y === to.at.y && !floors.some((b) => cuts(from.at, to.at, b))) legs = split(path(from.at, [[[to.at], false]]), floors);
  else {
    const free = floors.filter((b) => b !== A && b !== B && w.solid.includes(b)).map((b) => floorOf({ x: b.x, y: b.y }, b));
    legs = hopWay(from.at, P, to.at, Q, w, floors, free);
    const g = from.place !== to.place ? glideWay(m, from, to, A, B, P, Q, w, floors) : null;
    if (g && lengthOf(g) <= GLIDE_OVER * lengthOf(legs)) legs = g;
  }
  return { legs, len: lengthOf(legs) };
}

const lengthOf = (legs: readonly Leg[]) => legs.reduce((n, l) => n + Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), 0);

/** The glide along the one arrow (the shortest, if there are more) that joins the two places directly, with the walks (or hops) onto its ends; none: null. */
function glideWay(m: WalkMap, from: Spot, to: Spot, A: Box, B: Box, P: Floor, Q: Floor, w: World, floors: readonly Box[]): Leg[] | null {
  const ls = (m.links.get(from.place) ?? []).filter((l) => l.to === to.place);
  if (!ls.length) return null;
  const c = ls.reduce((x, y) => (y.w < x.w ? y : x)).c;
  const pts = c.from === from.place ? [...c.pts] : [...c.pts].reverse();
  // round its node's outline from the top edge to the arrow's port, along the arrow, round the other node's outline up to its top edge
  const way = rounded([...rim(A, pts[0]), ...pts.slice(1, -1), ...rim(B, pts[pts.length - 1]).reverse()]);
  const out: Leg[] = [...onto(from.at, P, way[0], top(A), w, floors)];
  for (let i = 1; i < way.length; i++) if (Math.hypot(way[i].x - way[i - 1].x, way[i].y - way[i - 1].y) > 1e-6) out.push({ kind: "glide", a: way[i - 1], b: way[i], temp: false });
  out.push(...onto(way[way.length - 1], top(B), to.at, Q, w, floors));
  return out;
}

/** From p on floor P to q on floor Q, both on one node: along its top edge; otherwise (a spot beside or under it) one hop. */
function onto(p: Pt, P: Floor, q: Pt, Q: Floor, w: World, floors: readonly Box[]): Leg[] {
  if (P.box && P.box === Q.box && p.y === q.y) return split(path(p, [[[q], false]]), floors);
  return hopWay(p, P, q, Q, w, floors, []);
}

const top = (b: Box): Floor => ({ x0: b.x, x1: b.x + b.w, y: b.y, box: b });
/** The floor a spot is on: its node's top edge; beside the node, the spot itself; under it, the line it stands on out to either side past the node's walls (it walks out from under before it hops, and in under after). */
function floorOf(at: Pt, b: Box): Floor {
  if (b.w > 0 && Math.abs(at.y - b.y) <= E && at.x >= b.x - E && at.x <= b.x + b.w + E) return top(b);
  if (b.w > 0 && at.y > b.y + b.h && at.x > b.x && at.x < b.x + b.w) return { x0: b.x - UNDER, x1: b.x + b.w + UNDER, y: at.y, box: null };
  return { x0: at.x, x1: at.x, y: at.y, box: null };
}
/** A worker standing under a node walks this far past its wall (world px) to hop: clear of it at the side (OWN_PAD) with room for the body. */
const UNDER = 12;

/** What a hop keeps clear of: the nodes (bar one that holds a spot) and drawn things that are not part of one; `own`: the nodes it takes off from and lands on, kept off by the feet's line alone. */
type World = { solid: Box[]; own: Box[] };
function world(m: WalkMap, from: Spot, to: Spot, ends: Box[]): World {
  const free = (b: Box) => !within(b, from.at) && !within(b, to.at);
  const nodes = [...m.boxes.values()];
  const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const own = ends.filter((b) => b.w > 0 || b.h > 0);
  // a drawn thing that overlaps a node is part of it (its label, its icon); one the figure stands in at either end is not in its way
  const loose = m.obstacles.filter((o) => free(o) && !nodes.some((b) => meets(o, b)) && !column(o, from.at) && !column(o, to.at));
  return { solid: [...nodes.filter(free), ...loose], own };
}
/** A body standing at p (feet to head, HOP_BODY tall) overlaps b. */
const column = (b: Box, p: Pt) => p.x > b.x - E && p.x < b.x + b.w + E && p.y > b.y && p.y - HOP_BODY < b.y + b.h;

/** The arc goes through something: at any of 2·HOP_STEPS points along it, the body (HOP_BODY tall over the feet) inside a node or a drawn thing, kept HOP_PAD to the side of it and the feet HOP_OVER over it — the two nodes at its ends excepted, which the body keeps only OWN_PAD off at the side (it takes off from and lands on their top edges). */
function hits(arc: Arc, w: World): boolean {
  const n = 2 * HOP_STEPS;
  const xs = [arc.a.x, arc.b.x, arc.a.x + arc.out, arc.b.x + arc.out];
  const lo = Math.min(...xs) - HOP_PAD;
  const hi = Math.max(...xs) + HOP_PAD;
  const near = w.solid.filter((b) => b.x < hi && b.x + b.w > lo).map((b) => {
    const own = w.own.some((o) => o === b || (b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h));
    return { b, pad: own ? OWN_PAD : HOP_PAD, over: own ? 0 : HOP_OVER };
  });
  for (let i = 1; i < n; i++) {
    const c = arcAt(arc, i / n);
    for (const { b, pad, over } of near) {
      if (c.x > b.x - pad + E && c.x < b.x + b.w + pad - E && c.y + over > b.y + E && c.y - HOP_BODY < b.y + b.h - E) return true;
    }
  }
  return false;
}

/** A planned hop: takeoff and landing (the arc's ends) and what the way costs from p to q through it (ms: the walks either side, the crouch, the air, the squash). */
type Hop = { arc: Arc; cost: number };
const walkMs = (d: number) => Math.abs(d) / WALK_PX_MS;
const hopMs = (arc: Pick<Arc, "a" | "b" | "top">) => HOP_CROUCH_MS + hopAir(arc) + HOP_LAND_MS;

/**
 * The hop from p on P to q on Q whose arc rises no more than `high` over the higher floor: from the point of P nearest the landing
 * to the point of Q nearest the takeoff, if a straight arc from there clears everything; otherwise the quickest of the takeoffs at
 * that point, P's ends and beside things in the way, and the landings likewise on Q. Each arc starts as low as HOP_LIFT and
 * HOP_LOB allow (and HOP_VX: a wide one higher) and goes up 6 px at a time until it clears everything — first straight, then
 * swinging out to one side and back. None clears: null.
 */
function bestHop(p: Pt, P: Floor, q: Pt, Q: Floor, w: World, high: number): Hop | null {
  const onP = (x: number) => clampTo(x, P.x0, P.x1);
  const onQ = (x: number) => clampTo(x, Q.x0, Q.x1);
  const lo = Math.min(P.x0, Q.x0) - 80;
  const hi = Math.max(P.x1, Q.x1) + 80;
  // beside the walls of things in the way (a node's own walls are its floor's ends, for a takeoff)
  const near = w.solid.filter((b) => b.x < hi && b.x + b.w > lo);
  const wall = (b: Box) => {
    const pad = w.own.includes(b) ? OWN_PAD + 2 : HOP_PAD + 2;
    return [b.x - pad, b.x + b.w + pad];
  };
  const walls = near.flatMap(wall);
  const uniq = (xs: number[]) => [...new Set(xs.map((x) => Math.round(x * 1000) / 1000))];
  const pairs: { t: Pt; l: Pt; walk: number; top: number; bound: number }[] = [];
  for (const tx of uniq([onP(onQ(onP(q.x))), onP(q.x), P.x0, P.x1, ...near.filter((b) => !w.own.includes(b)).flatMap(wall).map(onP)]))
    for (const lx of uniq([onQ(tx), Q.x0, Q.x1, ...walls.map(onQ)])) {
      const t = { x: tx, y: P.y };
      const l = { x: lx, y: Q.y };
      let y = Math.min(P.y, Q.y) - Math.max(HOP_LIFT, HOP_LOB * Math.abs(lx - tx));
      // not flung sideways: a wide hop goes up until its time in the air allows HOP_VX
      while (Math.abs(lx - tx) / hopAir({ a: t, b: l, top: y }) > HOP_VX) y -= 4;
      // flying over a floor it could walk along (back over the one it takes off from, on over the one it lands on) costs twice the walk: it walks to the near end and hops from there
      const over = (F: Floor) => Math.max(0, Math.min(F.x1, Math.max(tx, lx)) - Math.max(F.x0, Math.min(tx, lx)));
      const walk = walkMs(p.x - tx) + walkMs(lx - q.x) + 2 * walkMs(over(P) + over(Q));
      pairs.push({ t, l, walk, top: y, bound: walk + hopMs({ a: t, b: l, top: y }) });
    }
  const ceil = Math.min(P.y, Q.y) - high;
  // the plain hop: the nearest points of the two floors, straight over
  const tx = onP(onQ(onP(q.x)));
  const first = pairs.find((c) => c.t.x === Math.round(tx * 1000) / 1000 && c.l.x === Math.round(onQ(tx) * 1000) / 1000)!;
  for (let y = first.top; y >= ceil; y -= 6) {
    const arc = { a: first.t, b: first.l, top: y, out: 0 };
    if (!hits(arc, w)) return { arc, cost: first.walk + hopMs(arc) };
  }
  pairs.sort((u, v) => u.bound - v.bound || u.t.x - v.t.x || u.l.x - v.l.x);
  let best: Hop | null = null;
  for (const c of pairs) {
    if (best && c.bound >= best.cost) break;
    if (c.top < ceil) continue;
    const arc = clear(c.t, c.l, c.top, ceil, w);
    if (!arc) continue;
    const cost = c.walk + hopMs(arc) + OUT_MS * Math.abs(arc.out);
    if (!best || cost < best.cost) best = { arc, cost };
  }
  return best;
}
/** The lowest arc from t to l, from `top` up to `ceil`, that clears everything: straight first, then swinging out to either side. */
function clear(t: Pt, l: Pt, top: number, ceil: number, w: World): Arc | null {
  for (const out of [0, ...OUTS])
    for (let y = top; y >= ceil; y -= 6) {
      const arc = { a: t, b: l, top: y, out };
      if (!hits(arc, w)) return arc;
    }
  return null;
}

/**
 * The legs from p on floor P to q on floor Q by hops: one if it clears everything without going over HOP_HIGH; otherwise two, by way
 * of one of the floors `via` (the quickest); otherwise one up to HOP_TOP; otherwise (a diagram with no way through) the plain arc
 * over the higher floor, through whatever is there.
 */
function hopWay(p: Pt, P: Floor, q: Pt, Q: Floor, w: World, floors: readonly Box[], via: readonly Floor[]): Leg[] {
  let plan: Arc[] | null = null;
  const one = bestHop(p, P, q, Q, w, HOP_HIGH);
  if (one) plan = [one.arc];
  else {
    let cost = Infinity;
    for (const F of via) {
      const mid = { x: clampTo(q.x, F.x0, F.x1), y: F.y };
      const h1 = bestHop(p, P, mid, F, w, HOP_HIGH);
      if (!h1) continue;
      const h2 = bestHop(h1.arc.b, F, q, Q, w, HOP_HIGH);
      if (!h2) continue;
      const c = h1.cost - walkMs(h1.arc.b.x - mid.x) + h2.cost;
      if (c < cost) {
        cost = c;
        plan = [h1.arc, h2.arc];
      }
    }
    if (!plan) {
      const h = bestHop(p, P, q, Q, w, HOP_TOP);
      const tx = clampTo(q.x, P.x0, P.x1);
      plan = [h?.arc ?? { a: { x: tx, y: P.y }, b: { x: clampTo(tx, Q.x0, Q.x1), y: Q.y }, top: Math.min(P.y, Q.y) - HOP_HIGH, out: 0 }];
    }
  }
  const out: Leg[] = [];
  let at = p;
  for (const arc of plan) {
    out.push(...split(path(at, [[[arc.a], false]]), floors));
    const pts = [arc.a];
    for (let i = 1; i < HOP_STEPS; i++) pts.push(arcAt(arc, i / HOP_STEPS));
    pts.push(arc.b);
    for (let i = 1; i < pts.length; i++) out.push({ kind: "hop", a: pts[i - 1], b: pts[i], temp: false, arc });
    at = arc.b;
  }
  out.push(...split(path(at, [[[q], false]]), floors));
  return out;
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
