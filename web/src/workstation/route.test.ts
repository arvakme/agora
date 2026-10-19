// 剖面 walking (./route.ts): a node's top edge is a floor; an arrow bound to the two nodes is glided
// along as drawn (§5 沿箭头滑行: round the node's outline to the arrow's port, along the arrow, its
// elbows rounded, round the other node up onto its top) when it is not much the longer way; anywhere
// else the worker hops (§5 跳过去): walks to the end of its floor nearest where it goes and jumps one
// arc over everything between. Expected legs are written out from those rules for the prototype's
// diagram (scripts/fidelity/setup.ts) and the demo project's (straight, mostly slanted arrows).
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { arcAt, GLIDE_OVER, GLIDE_ROUND, hopAir, HOP_STEPS, route, walkMap, type Connector, type Route, type WalkMap } from "./route";

type Spot = { place: string; at: { x: number; y: number } };
type P2 = { x: number; y: number };
const pts = (...n: number[]) => n.filter((_, i) => i % 2 === 0).map((x, i) => ({ x, y: n[2 * i + 1] }));
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Legs as "kind a → b" ("kind*" for a temporary scaffold's), for readable diffs. */
const legs = (rt: Route) => rt.legs.map((l) => `${l.kind}${l.temp ? "*" : ""} ${r6(l.a.x)},${r6(l.a.y)} → ${r6(l.b.x)},${r6(l.b.y)}`);
/** The same, with each run of glide pieces as one "glide a → b" (where it sets off and where it comes out), and each hop's pieces as one "hop a → b". */
const shape = (rt: Route) => {
  const out: string[] = [];
  let g: P2 | null = null;
  rt.legs.forEach((l, i) => {
    if (l.kind !== "glide" && l.kind !== "hop") return void out.push(legs({ legs: [l], len: 0 })[0]);
    g ??= l.a;
    const next = rt.legs[i + 1];
    if (next?.kind !== l.kind || next.arc !== l.arc) {
      out.push(`${l.kind} ${r6(g.x)},${r6(g.y)} → ${r6(l.b.x)},${r6(l.b.y)}`);
      g = null;
    }
  });
  return out;
};
/** The hops' arcs of a route, each once. */
const arcs = (rt: Route) => [...new Set(rt.legs.flatMap((l) => (l.kind === "hop" && l.arc ? [l.arc] : [])))];
/** The highest the feet are (least world y) over x0 … x1 along a route's hops. */
const highest = (rt: Route, x0: number, x1: number) => Math.min(...rt.legs.filter((l) => l.kind === "hop").flatMap((l) => [l.a, l.b]).filter((p) => p.x > x0 && p.x < x1).map((p) => p.y));
/** Each point lies on the route's glide line (within half a px). */
function expectOn(rt: Route, qs: P2[]) {
  const g = rt.legs.filter((l) => l.kind === "glide");
  for (const q of qs) {
    const off = Math.min(...g.map(({ a, b }) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const u = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(a.x + dx * u - q.x, a.y + dy * u - q.y);
    }));
    expect(off, `${q.x},${q.y} on the glide`).toBeLessThan(2); // (a port a few px off the node: the line cuts across that jog)
  }
}
/** A spot on a layout: feet at x, on the node's top edge unless y is given. */
const spotOn = (boxes: Record<string, Box>) => (place: string, x: number, y = boxes[place].y): Spot => ({ place, at: { x, y } });

// The prototype's diagram (world px) and the 图外 tray beside 支付服务, where docks.ts trayBox puts it.
const PROTO: Record<string, Box> = {
  web: { x: 40, y: 230, w: 170, h: 72 },
  api: { x: 330, y: 230, w: 200, h: 72 },
  mysql: { x: 680, y: 120, w: 160, h: 64 },
  redis: { x: 680, y: 330, w: 160, h: 64 },
  pay: { x: 350, y: 450, w: 160, h: 64 },
  tray: { x: 620, y: 470, w: 200, h: 56 },
};
const PROTO_EDGES: Connector[] = [
  { from: "web", to: "api", pts: pts(210, 266, 330, 266) },
  { from: "api", to: "mysql", pts: pts(530, 252, 610, 252, 610, 152, 680, 152) },
  { from: "api", to: "redis", pts: pts(530, 280, 610, 280, 610, 362, 680, 362) },
  { from: "api", to: "pay", pts: pts(430, 302, 430, 450) },
];
const proto = walkMap(new Map(Object.entries(PROTO)), PROTO_EDGES);
const P = spotOn(PROTO);

// The demo project's canvas: straight two-point arrows, bound at both ends, mostly slanted.
const DEMO: Record<string, Box> = {
  web: { x: -18.2, y: 203.5, w: 180, h: 120.8 },
  api: { x: 360, y: 210, w: 80, h: 101.3 },
  mysql: { x: 560, y: 210, w: 160, h: 102.7 },
  cache: { x: 506.4, y: 445.6, w: 100, h: 79 },
};
const demo = walkMap(new Map(Object.entries(DEMO)), [
  { from: "web", to: "api", pts: pts(167.8, 262.9, 354, 261.1) },
  { from: "api", to: "mysql", pts: pts(446.5, 261.3, 553.5, 260.6) },
  { from: "api", to: "cache", pts: pts(439.3, 317.3, 524.6, 439.6) },
]);
const D = spotOn(DEMO);

// Two nodes with a taller one between them, and an icon drawn above that one.
const GAP: Record<string, Box> = {
  a: { x: 0, y: 200, w: 100, h: 40 },
  tall: { x: 200, y: 100, w: 100, h: 200 },
  b: { x: 400, y: 200, w: 100, h: 40 },
};
const ICON: Box = { x: 220, y: 60, w: 40, h: 30 };
const G = spotOn(GAP);

/** The rules every route keeps, whatever the layout. */
function holds(map: WalkMap, boxes: readonly Box[], from: Spot, to: Spot) {
  const name = `${from.place} ${from.at.x},${from.at.y} → ${to.place} ${to.at.x},${to.at.y}`;
  const rt = route(map, from, to);
  expect(route(map, from, to), `${name}: same input, same route`).toEqual(rt);
  let at = from.at;
  let len = 0;
  for (const l of rt.legs) {
    expect(l.a, `${name}: legs join end to end`).toEqual(at);
    expect([l.a.x, l.a.y, l.b.x, l.b.y].every(Number.isFinite), `${name}: no NaN`).toBe(true);
    expect(l.a.x !== l.b.x || l.a.y !== l.b.y, `${name}: no empty leg`).toBe(true);
    if (l.kind === "climb") expect(l.b.x, `${name}: climbs are upright`).toBe(l.a.x);
    else if (l.kind === "glide" || l.kind === "hop") expect(l.temp, `${name}: a glide or a hop is never temporary`).toBe(false);
    else expect(l.b.y, `${name}: walks and bridges are level`).toBe(l.a.y);
    if (l.kind === "hop") expect(l.arc, `${name}: a hop's piece has its arc`).toBeDefined();
    const x0 = Math.min(l.a.x, l.b.x);
    const x1 = Math.max(l.a.x, l.b.x);
    const onTop = (lo: number, hi: number) => boxes.some((b) => Math.abs(b.y - l.a.y) < 1e-6 && lo >= b.x - 1e-6 && hi <= b.x + b.w + 1e-6);
    if (l.kind === "walk") expect(onTop(x0, x1) && !l.temp, `${name}: a walk is on a top edge (and never temporary)`).toBe(true);
    if (l.kind === "bridge") expect(onTop((x0 + x1) / 2, (x0 + x1) / 2), `${name}: a bridge is off the floors`).toBe(false);
    // a glide goes where the arrow is drawn (and cuts a node's corner round its outline): walks, bridges, ladders and hops keep out (a hop's pieces are chords of its arc: their ends are on it)
    if (l.kind !== "glide") for (const b of boxes) {
      if (l.kind === "hop") {
        const ins = (p: P2) => p.x > b.x + 1e-6 && p.x < b.x + b.w - 1e-6 && p.y > b.y + 1e-6 && p.y < b.y + b.h - 1e-6;
        const mine = ins(from.at) || ins(to.at);
        expect(!mine && (ins(l.a) || ins(l.b)), `${name}: hop ${l.a.x},${l.a.y} → ${l.b.x},${l.b.y} goes inside ${JSON.stringify(b)}`).toBe(false);
        continue;
      }
      const inside = x1 > b.x + 1e-6 && x0 < b.x + b.w - 1e-6 && Math.max(l.a.y, l.b.y) > b.y + 1e-6 && Math.min(l.a.y, l.b.y) < b.y + b.h - 1e-6;
      expect(inside, `${name}: ${l.kind} ${l.a.x},${l.a.y} → ${l.b.x},${l.b.y} goes inside ${JSON.stringify(b)}`).toBe(false);
    }
    len += Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    at = l.b;
  }
  expect(at, `${name}: ends at the spot`).toEqual(to.at);
  expect(rt.len, `${name}: len is the legs' total`).toBeCloseTo(len, 6);
}

describe("route (剖面: floors, glides along arrows, scaffolds)", () => {
  it("on one node: a single walk along its top edge; standing still is an empty route", () => {
    const rt = route(proto, P("api", 354), P("api", 446));
    expect(legs(rt)).toEqual(["walk 354,230 → 446,230"]);
    expect(rt.len).toBe(92);
    expect(route(proto, P("api", 354), P("api", 354))).toEqual({ legs: [], len: 0 });
  });

  it("web ↔ api: along the HTTP arrow it glides — round web's corner down to the port, along the arrow, up round api's corner — and walks on; nothing is built", () => {
    const there = route(proto, P("web", 64), P("api", 400));
    expect(shape(there)).toEqual(["walk 64,230 → 210,230", "glide 210,230 → 330,230", "walk 330,230 → 400,230"]);
    expectOn(there, [{ x: 210, y: 250 }, { x: 270, y: 266 }, { x: 330, y: 250 }]);
    expect(shape(route(proto, P("api", 400), P("web", 64)))).toEqual(["walk 400,230 → 330,230", "glide 330,230 → 210,230", "walk 210,230 → 64,230"]);
  });

  it("api → mysql / redis: along the elbow arrow as drawn (x = 610 upright), its elbows rounded", () => {
    const up = route(proto, P("api", 354), P("mysql", 704));
    expect(shape(up)).toEqual(["walk 354,230 → 530,230", "glide 530,230 → 680,120", "walk 680,120 → 704,120"]);
    expectOn(up, [{ x: 530, y: 245 }, { x: 570, y: 252 }, { x: 610, y: 200 }, { x: 650, y: 152 }, { x: 680, y: 135 }]);
    // the elbow (610, 252) is rounded: the line passes inside it, within GLIDE_ROUND
    const g = up.legs.filter((l) => l.kind === "glide");
    const near = Math.min(...g.map((l) => Math.hypot(l.a.x - 610, l.a.y - 252)));
    expect(near).toBeGreaterThan(2);
    expect(near).toBeLessThan(GLIDE_ROUND);
    expect(shape(route(proto, P("mysql", 704), P("api", 354)))).toEqual(["walk 704,120 → 680,120", "glide 680,120 → 530,230", "walk 530,230 → 354,230"]);
    const red = route(proto, P("api", 354), P("redis", 704));
    expect(shape(red)).toEqual(["walk 354,230 → 530,230", "glide 530,230 → 680,330", "walk 680,330 → 704,330"]);
    expectOn(red, [{ x: 610, y: 320 }, { x: 650, y: 362 }]);
  });

  it("api ↔ pay, stacked: from api's top round its corner and along its bottom to the port, down the arrow onto pay's top", () => {
    const down = route(proto, P("api", 354), P("pay", 374));
    expect(shape(down)).toEqual(["walk 354,230 → 330,230", "glide 330,230 → 430,450", "walk 430,450 → 374,450"]);
    expectOn(down, [{ x: 330, y: 270 }, { x: 380, y: 302 }, { x: 430, y: 400 }]);
    expect(shape(route(proto, P("pay", 374), P("api", 354)))).toEqual(["walk 374,450 → 430,450", "glide 430,450 → 330,230", "walk 330,230 → 354,230"]);
    expect(shape(route(proto, P("api", 354), P("pay", 490)))).toEqual(["walk 354,230 → 330,230", "glide 330,230 → 430,450", "walk 430,450 → 490,450"]);
  });

  it("not joined by one arrow (web → mysql: the HTTP arrow, then the SQL one), it hops: to web's end nearest mysql, one arc up onto mysql's near end, and walks on — never along a chain of arrows through api", () => {
    const rt = route(proto, P("web", 64), P("mysql", 704));
    expect(shape(rt)).toEqual(["walk 64,230 → 210,230", "hop 210,230 → 680,120", "walk 680,120 → 704,120"]);
    expect(rt.legs.some((l) => l.kind === "glide")).toBe(false);
    // its apex is over the higher floor by at least HOP_LIFT, more for a wide hop (a long jump, not a skim)
    const [arc] = arcs(rt);
    expect(arc.top).toBeLessThan(120 - 14);
    expect(rt.legs.filter((l) => l.kind === "hop")).toHaveLength(HOP_STEPS);
    // the pieces are even shares of its time along one parabola
    expect(rt.legs.filter((l) => l.kind === "hop")[5].b).toEqual(arcAt(arc, 6 / HOP_STEPS));
  });

  it("mysql → redis, stacked with no arrow between them: off mysql's near edge, swinging out past its wall, down onto redis's corner — the body never inside either", () => {
    const rt = route(proto, P("mysql", 704), P("redis", 704));
    expect(shape(rt)).toEqual(["walk 704,120 → 680,120", "hop 680,120 → 680,330", "walk 680,330 → 704,330"]);
    const [arc] = arcs(rt);
    expect(arc.out).toBeLessThan(0); // out to the left, away from the walls
    for (let i = 1; i < 40; i++) {
      const p = arcAt(arc, i / 40);
      if (p.y > 120 && p.y - 40 < 184) expect(p.x, `beside mysql at ${p.y}`).toBeLessThan(680);
    }
    // and back again: the same arc the other way
    expect(shape(route(proto, P("redis", 704), P("mysql", 704)))).toEqual(["walk 704,330 → 680,330", "hop 680,330 → 680,120", "walk 680,120 → 704,120"]);
  });

  it("a direct arrow is glided when it is not much the longer way: a redis–mysql arrow beats the hop; one that goes the long way round (over GLIDE_OVER times the hop's way) is not taken", () => {
    const map = walkMap(new Map(Object.entries(PROTO)), [...PROTO_EDGES, { from: "redis", to: "mysql", pts: pts(760, 330, 760, 184) }]);
    const rt = route(map, P("redis", 704), P("mysql", 704));
    expect(shape(rt)).toEqual(["walk 704,330 → 760,330", "glide 760,330 → 680,120", "walk 680,120 → 704,120"]);
    expectOn(rt, [{ x: 760, y: 250 }]);
    // side by side, an arrow from one's bottom down and round to the other's bottom: hopping across the gap is far shorter
    const SIDE: Record<string, Box> = { a: { x: 0, y: 200, w: 100, h: 40 }, b: { x: 200, y: 200, w: 100, h: 40 } };
    const round = walkMap(new Map(Object.entries(SIDE)), [{ from: "a", to: "b", pts: pts(50, 240, 50, 400, 250, 400, 250, 240) }]);
    const S = spotOn(SIDE);
    const way = route(round, S("a", 50), S("b", 250));
    expect(shape(way)).toEqual(["walk 50,200 → 100,200", "hop 100,200 → 200,200", "walk 200,200 → 250,200"]);
    expect(GLIDE_OVER).toBeGreaterThan(1);
  });

  it("to the 图外 tray (no connector leads there): a hop off web's near end, over api with HOP_OVER to spare, down onto the tray's near end; nothing is built", () => {
    const rt = route(proto, P("web", 64), P("tray", 650));
    expect(shape(rt)).toEqual(["walk 64,230 → 210,230", "hop 210,230 → 620,470", "walk 620,470 → 650,470"]);
    expect(rt.legs.some((l) => l.temp || l.kind === "climb" || l.kind === "bridge")).toBe(false);
    expect(highest(rt, 324, 536)).toBeLessThanOrEqual(230 - 14);
    // from pay, which api overhangs: a hop too, never through api (holds)
    const fromPay = route(proto, P("pay", 374), P("tray", 650));
    expect(fromPay.legs.some((l) => l.kind === "hop")).toBe(true);
    holds(proto, Object.values(PROTO), P("pay", 374), P("tray", 650));
  });

  it("api → pay, stacked with no arrow: walks to api's near end and steps off it, out past its wall and in again under it onto pay", () => {
    const bare = walkMap(new Map(Object.entries(PROTO)), []);
    const rt = route(bare, P("api", 354), P("pay", 374));
    expect(shape(rt)).toEqual(["walk 354,230 → 330,230", "hop 330,230 → 350,450", "walk 350,450 → 374,450"]);
    const [arc] = arcs(rt);
    expect(arc.out).toBeLessThan(0);
    expect(arc.top).toBe(230 - 14); // a step off: no higher than it must be
    // the time in the air is gravity's: up 14 px and down 234
    expect(hopAir(arc)).toBeCloseTo(Math.sqrt((2 * 14) / 0.0013) + Math.sqrt((2 * 234) / 0.0013), 6);
  });

  it("unconnected nodes: one hop over the taller node between, its apex HOP_OVER over it (and over a drawn icon above it); an arrow, even one drawn behind a node, is glided as drawn", () => {
    const boxes = new Map(Object.entries(GAP));
    const over = route(walkMap(boxes, []), G("a", 24), G("b", 424));
    expect(shape(over)).toEqual(["walk 24,200 → 100,200", "hop 100,200 → 400,200", "walk 400,200 → 424,200"]);
    expect(highest(over, 194, 306)).toBeLessThanOrEqual(100 - 14);
    expect(arcs(over)[0].top).toBeGreaterThan(100 - 14 - 20); // just over it, not sky high
    const icon = route(walkMap(boxes, [], [ICON]), G("a", 24), G("b", 424));
    expect(shape(icon)).toEqual(["walk 24,200 → 100,200", "hop 100,200 → 400,200", "walk 400,200 → 424,200"]);
    expect(highest(icon, 214, 266)).toBeLessThanOrEqual(60 - 14);
    const through = walkMap(boxes, [{ from: "a", to: "b", pts: pts(100, 220, 400, 220) }], [ICON]);
    const rt = route(through, G("a", 24), G("b", 424));
    expect(shape(rt)).toEqual(["walk 24,200 → 100,200", "glide 100,200 → 400,200", "walk 400,200 → 424,200"]);
    expectOn(rt, [{ x: 250, y: 220 }]);
  });

  it("the demo's slanted arrows are glided along their slant, not made orthogonal; api → mysql (a level arrow between the middles of their sides: down one side, across, up the other is 1.7 times the hop) and cache → mysql (no one arrow) hop", () => {
    const rt = route(demo, D("api", 384), D("cache", 530.4));
    expect(shape(rt)).toEqual(["walk 384,210 → 440,210", "glide 440,210 → 524.6,445.6", "walk 524.6,445.6 → 530.4,445.6"]);
    expectOn(rt, [{ x: (439.3 + 524.6) / 2, y: (317.3 + 439.6) / 2 }]);
    expect(rt.legs.some((l) => l.kind === "climb" || l.kind === "bridge" || l.kind === "hop")).toBe(false);
    expect(shape(route(demo, D("api", 384), D("mysql", 584)))).toEqual(["walk 384,210 → 440,210", "hop 440,210 → 560,210", "walk 560,210 → 584,210"]);
    const cm = route(demo, D("cache", 530.4), D("mysql", 584));
    expect(cm.legs.some((l) => l.kind === "glide")).toBe(false);
    expect(arcs(cm)).toHaveLength(1);
  });

  it("every route keeps the rules (legs join end to end, level walks and bridges, upright climbs, walks on a top edge, walks and hops never inside a node, no NaN, len = the sum, deterministic)", () => {
    const protoSpots = [
      P("web", 64),
      P("api", 354),
      P("api", 570), // past its right end
      P("api", 549.2, 302), // beside it, on its bottom line
      P("api", 294, 302),
      P("api", 354, 382), // under it
      P("mysql", 704),
      P("redis", 704),
      P("redis", 859.2, 394),
      P("pay", 374),
      P("pay", 490),
      P("pay", 314, 514),
      P("tray", 650),
    ];
    for (const f of protoSpots) for (const t of protoSpots) holds(proto, Object.values(PROTO), f, t);
    const demoSpots = [D("web", 5.8), D("api", 384), D("mysql", 584), D("cache", 530.4)];
    for (const f of demoSpots) for (const t of demoSpots) holds(demo, Object.values(DEMO), f, t);
    const gap = walkMap(new Map(Object.entries(GAP)), [{ from: "a", to: "b", pts: pts(100, 220, 400, 220) }], [ICON]);
    const gapSpots = [G("a", 24), G("tall", 224), G("b", 424)];
    for (const f of gapSpots) for (const t of gapSpots) holds(gap, Object.values(GAP), f, t);
  });
});
