// 剖面 walking (./route.ts): a node's top edge is a floor; an arrow bound to two nodes is the way
// between their floors — level stretches are bridges, upright ones ladders — and where no arrow
// leads (or its way would cut through a node) a temporary scaffold goes over everything between.
// Expected legs are written out from those rules for the prototype's diagram
// (scripts/fidelity/setup.ts) and the demo project's (straight, mostly slanted arrows).
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { route, walkMap, type Connector, type Route, type WalkMap } from "./route";

type Spot = { place: string; at: { x: number; y: number } };
const pts = (...n: number[]) => n.filter((_, i) => i % 2 === 0).map((x, i) => ({ x, y: n[2 * i + 1] }));
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Legs as "kind a → b" ("kind*" for a temporary scaffold's), for readable diffs. */
const legs = (rt: Route) => rt.legs.map((l) => `${l.kind}${l.temp ? "*" : ""} ${r6(l.a.x)},${r6(l.a.y)} → ${r6(l.b.x)},${r6(l.b.y)}`);
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
    else expect(l.b.y, `${name}: walks and bridges are level`).toBe(l.a.y);
    const x0 = Math.min(l.a.x, l.b.x);
    const x1 = Math.max(l.a.x, l.b.x);
    const onTop = (lo: number, hi: number) => boxes.some((b) => Math.abs(b.y - l.a.y) < 1e-6 && lo >= b.x - 1e-6 && hi <= b.x + b.w + 1e-6);
    if (l.kind === "walk") expect(onTop(x0, x1) && !l.temp, `${name}: a walk is on a top edge (and never temporary)`).toBe(true);
    if (l.kind === "bridge") expect(onTop((x0 + x1) / 2, (x0 + x1) / 2), `${name}: a bridge is off the floors`).toBe(false);
    for (const b of boxes) {
      const inside = x1 > b.x + 1e-6 && x0 < b.x + b.w - 1e-6 && Math.max(l.a.y, l.b.y) > b.y + 1e-6 && Math.min(l.a.y, l.b.y) < b.y + b.h - 1e-6;
      expect(inside, `${name}: ${l.kind} ${l.a.x},${l.a.y} → ${l.b.x},${l.b.y} goes inside ${JSON.stringify(b)}`).toBe(false);
    }
    len += Math.abs(l.b.x - l.a.x) + Math.abs(l.b.y - l.a.y);
    at = l.b;
  }
  expect(at, `${name}: ends at the spot`).toEqual(to.at);
  expect(rt.len, `${name}: len is the legs' total`).toBeCloseTo(len, 6);
}

describe("route (剖面: floors, bridges, ladders, scaffolds)", () => {
  it("on one node: a single walk along its top edge; standing still is an empty route", () => {
    const rt = route(proto, P("api", 354), P("api", 446));
    expect(legs(rt)).toEqual(["walk 354,230 → 446,230"]);
    expect(rt.len).toBe(92);
    expect(route(proto, P("api", 354), P("api", 354))).toEqual({ legs: [], len: 0 });
  });

  it("web ↔ api: the tops are level, so a bridge straight across the gap — no ladder", () => {
    const there = route(proto, P("web", 64), P("api", 400));
    expect(legs(there)).toEqual(["walk 64,230 → 210,230", "bridge 210,230 → 330,230", "walk 330,230 → 400,230"]);
    expect(there.len).toBe(336);
    expect(legs(route(proto, P("api", 400), P("web", 64)))).toEqual(["walk 400,230 → 330,230", "bridge 330,230 → 210,230", "walk 210,230 → 64,230"]);
  });

  it("api → mysql / redis: the ladder stands where the elbow arrow runs upright (x = 610)", () => {
    const up = route(proto, P("api", 354), P("mysql", 704));
    expect(legs(up)).toEqual(["walk 354,230 → 530,230", "bridge 530,230 → 610,230", "climb 610,230 → 610,120", "bridge 610,120 → 680,120", "walk 680,120 → 704,120"]);
    expect(up.len).toBe(460);
    expect(legs(route(proto, P("mysql", 704), P("api", 354)))).toEqual(["walk 704,120 → 680,120", "bridge 680,120 → 610,120", "climb 610,120 → 610,230", "bridge 610,230 → 530,230", "walk 530,230 → 354,230"]);
    expect(legs(route(proto, P("api", 354), P("redis", 704)))).toEqual(["walk 354,230 → 530,230", "bridge 530,230 → 610,230", "climb 610,230 → 610,330", "bridge 610,330 → 680,330", "walk 680,330 → 704,330"]);
  });

  it("api ↔ pay, stacked: the ladder stands 10 px off api's wall, on the side nearer where the worker is going", () => {
    const down = route(proto, P("api", 354), P("pay", 374));
    expect(legs(down)).toEqual(["walk 354,230 → 330,230", "bridge 330,230 → 320,230", "climb 320,230 → 320,450", "bridge 320,450 → 350,450", "walk 350,450 → 374,450"]);
    expect(down.len).toBe(308);
    expect(legs(route(proto, P("pay", 374), P("api", 354)))).toEqual(["walk 374,450 → 350,450", "bridge 350,450 → 320,450", "climb 320,450 → 320,230", "bridge 320,230 → 330,230", "walk 330,230 → 354,230"]);
    // bound for pay's right end: the right-hand wall, though the worker sets off from api's left end
    expect(legs(route(proto, P("api", 354), P("pay", 490)))).toEqual(["walk 354,230 → 530,230", "bridge 530,230 → 540,230", "climb 540,230 → 540,450", "bridge 540,450 → 510,450", "walk 510,450 → 490,450"]);
  });

  it("web → mysql: hop by hop along the connector chain through api — a bridge, then the ladder at 610", () => {
    const rt = route(proto, P("web", 64), P("mysql", 704));
    expect(legs(rt)).toEqual([
      "walk 64,230 → 210,230",
      "bridge 210,230 → 330,230",
      "walk 330,230 → 530,230",
      "bridge 530,230 → 610,230",
      "climb 610,230 → 610,120",
      "bridge 610,120 → 680,120",
      "walk 680,120 → 704,120",
    ]);
    expect(rt.len).toBe(750);
    // passing api's level without stepping onto it: one ladder from mysql's level down to redis's
    expect(legs(route(proto, P("mysql", 704), P("redis", 704)))).toEqual(["walk 704,120 → 680,120", "bridge 680,120 → 610,120", "climb 610,120 → 610,330", "bridge 610,330 → 680,330", "walk 680,330 → 704,330"]);
  });

  it("the shortest chain by orthogonal length wins: a direct redis–mysql arrow beats going round through api", () => {
    const map = walkMap(new Map(Object.entries(PROTO)), [...PROTO_EDGES, { from: "redis", to: "mysql", pts: pts(760, 330, 760, 184) }]);
    expect(legs(route(map, P("redis", 704), P("mysql", 704)))).toEqual(["walk 704,330 → 680,330", "bridge 680,330 → 670,330", "climb 670,330 → 670,120", "bridge 670,120 → 680,120", "walk 680,120 → 704,120"]);
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

  it("unconnected nodes, or a connector whose bridge would cut through a node: a scaffold 24 px over the highest thing between (drawn obstacles too)", () => {
    const boxes = new Map(Object.entries(GAP));
    expect(legs(route(walkMap(boxes, []), G("a", 24), G("b", 424)))).toEqual(["walk 24,200 → 100,200", "climb* 100,200 → 100,76", "bridge* 100,76 → 400,76", "climb* 400,76 → 400,200", "walk 400,200 → 424,200"]);
    const through = walkMap(boxes, [{ from: "a", to: "b", pts: pts(100, 220, 400, 220) }], [ICON]);
    expect(legs(route(through, G("a", 24), G("b", 424)))).toEqual(["walk 24,200 → 100,200", "climb* 100,200 → 100,36", "bridge* 100,36 → 400,36", "climb* 400,36 → 400,200", "walk 400,200 → 424,200"]);
  });

  it("the demo's straight slanted arrows are made orthogonal: a ladder mid-gap where the tops differ, a bridge where they are level", () => {
    expect(legs(route(demo, D("api", 384), D("cache", 530.4)))).toEqual(["walk 384,210 → 440,210", "bridge 440,210 → 473.2,210", "climb 473.2,210 → 473.2,445.6", "bridge 473.2,445.6 → 506.4,445.6", "walk 506.4,445.6 → 530.4,445.6"]);
    expect(legs(route(demo, D("api", 384), D("mysql", 584)))).toEqual(["walk 384,210 → 440,210", "bridge 440,210 → 560,210", "walk 560,210 → 584,210"]);
    // cache → mysql passes api's level in the gap: up the ladder, then straight across to mysql
    expect(legs(route(demo, D("cache", 530.4), D("mysql", 584)))).toEqual(["walk 530.4,445.6 → 506.4,445.6", "bridge 506.4,445.6 → 473.2,445.6", "climb 473.2,445.6 → 473.2,210", "bridge 473.2,210 → 560,210", "walk 560,210 → 584,210"]);
  });

  it("tops within 4 px are level: one bridge across the whole gap and at most a step; 5 px apart takes a ladder mid-gap", () => {
    const A: Box = { x: 0, y: 100, w: 100, h: 50 };
    const near: Record<string, Box> = { a: A, b: { x: 200, y: 103, w: 100, h: 50 } };
    const nearMap = walkMap(new Map(Object.entries(near)), [{ from: "a", to: "b", pts: pts(100, 125, 200, 128) }]);
    const rt = route(nearMap, spotOn(near)("a", 24), spotOn(near)("b", 224));
    expect(rt.legs.filter((l) => l.kind === "climb").every((l) => Math.abs(l.b.y - l.a.y) <= 4)).toBe(true);
    expect(rt.legs.some((l) => l.kind === "bridge" && Math.min(l.a.x, l.b.x) === 100 && Math.max(l.a.x, l.b.x) === 200)).toBe(true);
    holds(nearMap, Object.values(near), spotOn(near)("a", 24), spotOn(near)("b", 224));
    const far: Record<string, Box> = { a: A, b: { x: 200, y: 105, w: 100, h: 50 } };
    const farMap = walkMap(new Map(Object.entries(far)), [{ from: "a", to: "b", pts: pts(100, 125, 200, 130) }]);
    expect(legs(route(farMap, spotOn(far)("a", 24), spotOn(far)("b", 224)))).toEqual(["walk 24,100 → 100,100", "bridge 100,100 → 150,100", "climb 150,100 → 150,105", "bridge 150,105 → 200,105", "walk 200,105 → 224,105"]);
  });

  it("every route keeps the rules (legs join end to end, level walks and bridges, upright climbs, walks on a top edge, never inside a node, no NaN, len = the sum, deterministic)", () => {
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
