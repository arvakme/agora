// 剖面 walking (./route.ts): a node's top edge is a floor; an arrow bound to two nodes is glided
// along as drawn (§5 沿箭头滑行: round the node's outline to the arrow's port, along the arrow, its
// elbows rounded, round the other node up onto its top); where no arrow leads a temporary scaffold
// (bridges and ladders) goes over everything between. Expected legs are written out from those rules
// for the prototype's diagram (scripts/fidelity/setup.ts) and the demo project's (straight, mostly
// slanted arrows).
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { GLIDE_ROUND, route, walkMap, type Connector, type Route, type WalkMap } from "./route";

type Spot = { place: string; at: { x: number; y: number } };
type P2 = { x: number; y: number };
const pts = (...n: number[]) => n.filter((_, i) => i % 2 === 0).map((x, i) => ({ x, y: n[2 * i + 1] }));
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Legs as "kind a → b" ("kind*" for a temporary scaffold's), for readable diffs. */
const legs = (rt: Route) => rt.legs.map((l) => `${l.kind}${l.temp ? "*" : ""} ${r6(l.a.x)},${r6(l.a.y)} → ${r6(l.b.x)},${r6(l.b.y)}`);
/** The same, with each run of glide pieces as one "glide a → b" (where it sets off and where it comes out). */
const shape = (rt: Route) => {
  const out: string[] = [];
  let g: P2 | null = null;
  rt.legs.forEach((l, i) => {
    if (l.kind !== "glide") return void out.push(legs({ legs: [l], len: 0 })[0]);
    g ??= l.a;
    if (rt.legs[i + 1]?.kind !== "glide") {
      out.push(`glide ${r6(g.x)},${r6(g.y)} → ${r6(l.b.x)},${r6(l.b.y)}`);
      g = null;
    }
  });
  return out;
};
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
    else if (l.kind === "glide") expect(l.temp, `${name}: a glide is never temporary`).toBe(false);
    else expect(l.b.y, `${name}: walks and bridges are level`).toBe(l.a.y);
    const x0 = Math.min(l.a.x, l.b.x);
    const x1 = Math.max(l.a.x, l.b.x);
    const onTop = (lo: number, hi: number) => boxes.some((b) => Math.abs(b.y - l.a.y) < 1e-6 && lo >= b.x - 1e-6 && hi <= b.x + b.w + 1e-6);
    if (l.kind === "walk") expect(onTop(x0, x1) && !l.temp, `${name}: a walk is on a top edge (and never temporary)`).toBe(true);
    if (l.kind === "bridge") expect(onTop((x0 + x1) / 2, (x0 + x1) / 2), `${name}: a bridge is off the floors`).toBe(false);
    // a glide goes where the arrow is drawn (and cuts a node's corner round its outline): only walks, bridges and ladders keep out
    if (l.kind !== "glide") for (const b of boxes) {
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

  it("web → mysql: hop by hop along the connector chain through api — it surfaces on api's top between the two arrows and walks across it", () => {
    const rt = route(proto, P("web", 64), P("mysql", 704));
    expect(shape(rt)).toEqual(["walk 64,230 → 210,230", "glide 210,230 → 330,230", "walk 330,230 → 530,230", "glide 530,230 → 680,120", "walk 680,120 → 704,120"]);
    // mysql → redis: in at api's right side and out of it again: one glide, never up onto api's top between
    const mr = route(proto, P("mysql", 704), P("redis", 704));
    expect(shape(mr)).toEqual(["walk 704,120 → 680,120", "glide 680,120 → 680,330", "walk 680,330 → 704,330"]);
    expectOn(mr, [{ x: 610, y: 200 }, { x: 530, y: 266 }, { x: 610, y: 320 }]);
    expect(mr.legs.filter((l) => l.kind === "glide").every((l) => l.a.y > 230 + 1e-6 || l.a.x > 530)).toBe(true);
  });

  it("the shortest chain by drawn length wins: a direct redis–mysql arrow beats going round through api", () => {
    const map = walkMap(new Map(Object.entries(PROTO)), [...PROTO_EDGES, { from: "redis", to: "mysql", pts: pts(760, 330, 760, 184) }]);
    const rt = route(map, P("redis", 704), P("mysql", 704));
    expect(shape(rt)).toEqual(["walk 704,330 → 760,330", "glide 760,330 → 680,120", "walk 680,120 → 704,120"]);
    expectOn(rt, [{ x: 760, y: 250 }]);
  });

  it("to the 图外 tray (no connector leads there): a temporary scaffold — up at the corner nearer the tray, 24 px over everything between, down at the tray's near corner", () => {
    const rt = route(proto, P("web", 64), P("tray", 650));
    expect(legs(rt)).toEqual(["walk 64,230 → 210,230", "climb* 210,230 → 210,206", "bridge* 210,206 → 620,206", "climb* 620,206 → 620,470", "walk 620,470 → 650,470"]);
    expect(rt.len).toBe(874);
    // from pay, which api overhangs: still a scaffold, and still never through api (holds)
    const fromPay = route(proto, P("pay", 374), P("tray", 650));
    expect(fromPay.legs.some((l) => l.kind === "climb")).toBe(true);
    expect(fromPay.legs.filter((l) => l.kind !== "walk").every((l) => l.temp)).toBe(true);
    holds(proto, Object.values(PROTO), P("pay", 374), P("tray", 650));
  });

  it("unconnected nodes: a scaffold 24 px over the highest thing between (drawn obstacles too); an arrow, even one drawn behind a node, is glided as drawn", () => {
    const boxes = new Map(Object.entries(GAP));
    expect(legs(route(walkMap(boxes, []), G("a", 24), G("b", 424)))).toEqual(["walk 24,200 → 100,200", "climb* 100,200 → 100,76", "bridge* 100,76 → 400,76", "climb* 400,76 → 400,200", "walk 400,200 → 424,200"]);
    expect(legs(route(walkMap(boxes, [], [ICON]), G("a", 24), G("b", 424)))).toEqual(["walk 24,200 → 100,200", "climb* 100,200 → 100,36", "bridge* 100,36 → 400,36", "climb* 400,36 → 400,200", "walk 400,200 → 424,200"]);
    const through = walkMap(boxes, [{ from: "a", to: "b", pts: pts(100, 220, 400, 220) }], [ICON]);
    const rt = route(through, G("a", 24), G("b", 424));
    expect(shape(rt)).toEqual(["walk 24,200 → 100,200", "glide 100,200 → 400,200", "walk 400,200 → 424,200"]);
    expectOn(rt, [{ x: 250, y: 220 }]);
  });

  it("the demo's slanted arrows are glided along their slant, not made orthogonal: no ladder, no bridge", () => {
    const rt = route(demo, D("api", 384), D("cache", 530.4));
    expect(shape(rt)).toEqual(["walk 384,210 → 440,210", "glide 440,210 → 524.6,445.6", "walk 524.6,445.6 → 530.4,445.6"]);
    expectOn(rt, [{ x: (439.3 + 524.6) / 2, y: (317.3 + 439.6) / 2 }]);
    expect(rt.legs.some((l) => l.kind === "climb" || l.kind === "bridge")).toBe(false);
    expect(shape(route(demo, D("api", 384), D("mysql", 584)))).toEqual(["walk 384,210 → 440,210", "glide 440,210 → 560,210", "walk 560,210 → 584,210"]);
    // cache → mysql: up the slant into api's side and straight out again along the level arrow, without surfacing
    expect(shape(route(demo, D("cache", 530.4), D("mysql", 584)))).toEqual(["walk 530.4,445.6 → 524.6,445.6", "glide 524.6,445.6 → 560,210", "walk 560,210 → 584,210"]);
  });

  it("every route keeps the rules (legs join end to end, level walks and bridges, upright climbs, walks on a top edge, walks and ladders never inside a node, no NaN, len = the sum, deterministic)", () => {
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
