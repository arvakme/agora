// 剖面 trips (./rig.ts planTrip / tripAt along ./route.ts routes; web/docs/workstation.md §2 §5): a
// worker walks floors and bridges and climbs ladders. Walking, a planted foot is on the floor or
// bridge under it; climbing, hands and feet hold the rungs of the ladder, the diagonal pairs taking
// turns; a whole trip keeps to the time budget (a long one goes faster: longer, quicker steps); the
// body glides from the start spot to the end spot without a jump; the same move gives the same trip.
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { planTrip, RIG, STEP_MAX, tripAt, TRIP_MAX_MS, TRIP_MIN_MS, type Foot, type Trip } from "./rig.ts";
import { route, walkMap, type Leg, type WalkMap } from "./route.ts";

type Spot = { place: string; at: { x: number; y: number } };
const pts = (...n: number[]) => n.filter((_, i) => i % 2 === 0).map((x, i) => ({ x, y: n[2 * i + 1] }));
const spotOn = (boxes: Record<string, Box>) => (place: string, x: number, y = boxes[place].y): Spot => ({ place, at: { x, y } });

// The prototype's diagram (scripts/fidelity/setup.ts) with the 图外 tray beside 支付服务, as in route.test.ts.
const PROTO: Record<string, Box> = {
  web: { x: 40, y: 230, w: 170, h: 72 },
  api: { x: 330, y: 230, w: 200, h: 72 },
  mysql: { x: 680, y: 120, w: 160, h: 64 },
  redis: { x: 680, y: 330, w: 160, h: 64 },
  pay: { x: 350, y: 450, w: 160, h: 64 },
  tray: { x: 620, y: 470, w: 200, h: 56 },
};
const proto = walkMap(new Map(Object.entries(PROTO)), [
  { from: "web", to: "api", pts: pts(210, 266, 330, 266) },
  { from: "api", to: "mysql", pts: pts(530, 252, 610, 252, 610, 152, 680, 152) },
  { from: "api", to: "redis", pts: pts(530, 280, 610, 280, 610, 362, 680, 362) },
  { from: "api", to: "pay", pts: pts(430, 302, 430, 450) },
]);
const P = spotOn(PROTO);
// The demo project's canvas: web's top edge is 6.5 px above api's — a step, not a ladder.
const DEMO: Record<string, Box> = { web: { x: -18.2, y: 203.5, w: 180, h: 120.8 }, api: { x: 360, y: 210, w: 80, h: 101.3 } };
const demo = walkMap(new Map(Object.entries(DEMO)), [{ from: "web", to: "api", pts: pts(167.8, 262.9, 354, 261.1) }]);
const D = spotOn(DEMO);
// One long floor, for walks of any length.
const HALL: Record<string, Box> = { hall: { x: 0, y: 100, w: 3000, h: 40 } };
const hall = walkMap(new Map(Object.entries(HALL)), []);
const H = spotOn(HALL);

const K = 1.2; // world px per figure unit: a main agent at 100 %
const T0 = 10_000;
function plan(map: WalkMap, from: Spot, to: Spot, k = K): { p: Trip; legs: Leg[] } {
  const rt = route(map, from, to);
  return { p: planTrip({ from: from.place, to: to.place, t: T0, slot: 0 }, rt, from.at, k), legs: rt.legs };
}
const TRIPS: [string, WalkMap, Spot, Spot][] = [
  ["api → mysql, up the ladder at 610", proto, P("api", 354), P("mysql", 704)],
  ["mysql → api, down it", proto, P("mysql", 704), P("api", 354)],
  ["web → pay, a bridge then down beside api's wall", proto, P("web", 64), P("pay", 374)],
  ["pay → api, up beside api's wall", proto, P("pay", 374), P("api", 354)],
  ["web → the 图外 tray, a scaffold up, across and down", proto, P("web", 64), P("tray", 650)],
  ["web → api, a bridge across", proto, P("web", 64), P("api", 400)],
  ["web → mysql, the long way", proto, P("web", 64), P("mysql", 704)],
  ["demo web → api, over a 6.5 px step", demo, D("web", 5.8), D("api", 384)],
  ["a few steps along one floor", hall, H("hall", 100), H("hall", 126)],
  ["a long way along one floor", hall, H("hall", 100), H("hall", 1300)],
];
const lifted = (f: Foot) => f.lift > 1e-6;

/** Where a foot comes down, sampled every ms: time and x. */
function footfalls(p: Trip): { t: number; x: number }[] {
  const out: { t: number; x: number }[] = [];
  let prev = tripAt(p, p.t0).feet;
  for (let t = p.t0 + 1; t <= p.t1; t++) {
    const now = tripAt(p, t).feet;
    now.forEach((f, i) => lifted(prev[i]) && !lifted(f) && out.push({ t, x: f.x }));
    prev = now;
  }
  return out;
}
const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;

describe("planTrip / tripAt (剖面 trips)", () => {
  it("a whole trip lasts TRIP_MIN_MS–TRIP_MAX_MS, from the turn at set-off to the last foot down: a short one slowed to the minimum, a long one sped up to the maximum", () => {
    for (const [name, map, from, to] of TRIPS) {
      const { p } = plan(map, from, to);
      expect(p.t0, name).toBe(T0);
      expect(p.t1 - p.t0, name).toBeGreaterThanOrEqual(TRIP_MIN_MS);
      expect(p.t1 - p.t0, name).toBeLessThanOrEqual(TRIP_MAX_MS);
    }
    expect(plan(hall, H("hall", 100), H("hall", 126)).p.t1 - T0).toBe(TRIP_MIN_MS);
    expect(plan(hall, H("hall", 100), H("hall", 1300)).p.t1 - T0).toBe(TRIP_MAX_MS);
    expect(plan(proto, P("web", 64), P("mysql", 704)).p.t1 - T0).toBe(TRIP_MAX_MS);
  });

  it("the body starts on the start spot, ends on the end spot and glides between without a jump (every ms under 1 px; at 60 fps no frame changes velocity by 1.5 px)", () => {
    for (const [name, map, from, to] of TRIPS) {
      const { p } = plan(map, from, to);
      expect(tripAt(p, p.t0 - 100).root, name).toEqual(from.at);
      expect(tripAt(p, p.t0).root, name).toEqual(from.at);
      expect(tripAt(p, p.t1).root, name).toEqual(to.at);
      expect(tripAt(p, p.t1 + 100).root, name).toEqual(to.at);
      let prev = tripAt(p, p.t0 - 5).root;
      for (let t = p.t0 - 4; t <= p.t1 + 5; t++) {
        const r = tripAt(p, t).root;
        expect(Math.hypot(r.x - prev.x, r.y - prev.y), `${name}: +${t - p.t0} ms`).toBeLessThan(1);
        prev = r;
      }
      for (let off = 0; off < 16; off += 4) {
        const fr: { x: number; y: number }[] = [];
        for (let t = p.t0 - 50 + off; t <= p.t1 + 50; t += 1000 / 60) fr.push(tripAt(p, t).root);
        for (let i = 2; i < fr.length; i++) {
          const snap = Math.hypot(fr[i].x - 2 * fr[i - 1].x + fr[i - 2].x, fr[i].y - 2 * fr[i - 1].y + fr[i - 2].y);
          expect(snap, `${name}: frame ${i} (+${off} ms)`).toBeLessThan(1.5);
        }
      }
    }
  });

  it("walking, a planted foot stands on the floor or bridge under it (at that leg's height), a swinging one is lifted", () => {
    for (const [name, map, from, to] of TRIPS) {
      const { p, legs } = plan(map, from, to);
      const level = legs.filter((l) => l.kind !== "climb");
      const tol = RIG.stance * K + 0.01;
      const near = (f: Foot, x: number, y: number) => Math.abs(f.y - y) < 1e-6 && Math.abs(f.x - x) <= tol;
      let swung = 0;
      for (let t = p.t0; t <= p.t1; t += 3) {
        const s = tripAt(p, t);
        if (s.climb > 0) continue;
        for (const f of s.feet) {
          if (lifted(f)) {
            swung++;
            continue;
          }
          const on = level.some((l) => Math.abs(l.a.y - f.y) < 1e-6 && f.x >= Math.min(l.a.x, l.b.x) - tol && f.x <= Math.max(l.a.x, l.b.x) + tol);
          expect(on || near(f, from.at.x, from.at.y) || near(f, to.at.x, to.at.y), `${name}: +${t - p.t0} ms, foot at ${f.x},${f.y}`).toBe(true);
        }
      }
      expect(swung, `${name}: the feet swing`).toBeGreaterThan(0);
    }
    // over the step, the feet come down on both floors: web's (203.5) and api's (210)
    const { p } = plan(demo, D("web", 5.8), D("api", 384));
    const ys = new Set<number>();
    for (let t = p.t0; t <= p.t1; t += 3) for (const f of tripAt(p, t).feet) if (!lifted(f)) ys.add(f.y);
    expect([...ys].sort()).toEqual([203.5, 210]);
  });

  it("climbing, every hand and foot not moving holds a rung of the ladder (a foot may stand on the floor at its foot); the same side's hand and foot never let go together; the near hand moves with the far foot", () => {
    for (const [name, map, from, to] of TRIPS) {
      const { p, legs } = plan(map, from, to);
      const ladders = legs.filter((l) => l.kind === "climb" && Math.abs(l.b.y - l.a.y) >= STEP_MAX);
      expect(new Set(p.ladders.map((l) => l.x)), `${name}: a ladder where the route climbs (a step has none)`).toEqual(new Set(ladders.map((l) => l.a.x)));
      if (!ladders.length) continue;
      let on = 0;
      let pair = 0;
      for (let t = p.t0; t <= p.t1; t += 2) {
        const s = tripAt(p, t);
        if (s.climb < 1) continue;
        expect(s.hands, `${name}: hands on the ladder`).not.toBeNull();
        on++;
        const [fn, ff] = s.feet;
        const [hn, hf] = s.hands!;
        for (const [i, l] of [fn, ff, hn, hf].entries()) {
          if (lifted(l)) continue;
          const held = p.ladders.some((d) => Math.abs(d.x - l.x) < 1e-6 && (d.rungs.some((y) => Math.abs(y - l.y) < 1e-6) || (i < 2 && Math.abs(d.bottom - l.y) < 1e-6)));
          expect(held, `${name}: +${t - p.t0} ms, limb ${i} at ${l.x},${l.y}`).toBe(true);
        }
        expect(lifted(hn) && lifted(fn), `${name}: +${t - p.t0} ms, the near hand and foot both off`).toBe(false);
        expect(lifted(hf) && lifted(ff), `${name}: +${t - p.t0} ms, the far hand and foot both off`).toBe(false);
        if (lifted(hn) && lifted(ff)) pair++;
      }
      expect(on, `${name}: some time on the ladder`).toBeGreaterThan(0);
      expect(pair, `${name}: the near hand and the far foot move together`).toBeGreaterThan(0);
    }
  });

  it("on a ladder the worker faces it from a little way off; it walks to it first and steps off at the other floor (no teleport onto or off it)", () => {
    for (const [name, map, from, to] of TRIPS) {
      const { p } = plan(map, from, to);
      if (!p.ladders.length) continue;
      for (let t = p.t0; t <= p.t1; t += 5) {
        const s = tripAt(p, t);
        if (s.climb < 1) continue;
        const d = p.ladders.reduce((a, b) => (Math.abs(b.x - s.root.x) < Math.abs(a.x - s.root.x) ? b : a));
        const off = (d.x - s.root.x) * s.f;
        expect(off, `${name}: +${t - p.t0} ms, the ladder is in front`).toBeGreaterThan(0);
        expect(off, `${name}: +${t - p.t0} ms, within reach`).toBeLessThan(10 * K);
      }
    }
  });

  it("draws what is walked: a bridge for each gap crossed, a ladder (rails and rungs about 5.5 figure units apart, evenly from floor to floor, rails reaching above the upper floor) for each climb; a scaffold's are temporary", () => {
    const up = plan(proto, P("api", 354), P("mysql", 704)).p;
    expect(up.bridges).toEqual([
      { a: { x: 530, y: 230 }, b: { x: 610, y: 230 }, temp: false },
      { a: { x: 610, y: 120 }, b: { x: 680, y: 120 }, temp: false },
    ]);
    expect(up.ladders).toHaveLength(1);
    const l = up.ladders[0];
    expect(l).toMatchObject({ x: 610, bottom: 230, temp: false });
    expect(l.top).toBeLessThan(120);
    for (const k of [K, K * 0.8]) {
      const rungs = [...plan(proto, P("api", 354), P("mysql", 704), k).p.ladders[0].rungs].sort((a, b) => b - a);
      const gaps = rungs.slice(1).map((y, i) => rungs[i] - y);
      for (const g of gaps) expect(g).toBeCloseTo(gaps[0], 6);
      expect(Math.abs(gaps[0] - 5.5 * k)).toBeLessThan(5.5 * k * 0.1);
      expect(rungs.some((y) => Math.abs(y - 120) < 1e-6)).toBe(true);
      expect(rungs.every((y) => y < 230)).toBe(true);
    }
    const tray = plan(proto, P("web", 64), P("tray", 650)).p;
    expect(tray.ladders.length).toBeGreaterThan(0);
    expect(tray.bridges.length).toBeGreaterThan(0);
    expect(tray.ladders.every((d) => d.temp) && tray.bridges.every((b) => b.temp)).toBe(true);
    const flat = plan(hall, H("hall", 100), H("hall", 400)).p;
    expect(flat.bridges).toEqual([]);
    expect(flat.ladders).toEqual([]);
  });

  it("a longer way goes faster with longer and quicker steps together", () => {
    const steps = (p: Trip) => {
      const f = footfalls(p).slice(2, -2);
      return { stride: mean(f.slice(1).map((x, i) => Math.abs(x.x - f[i].x))), ms: mean(f.slice(1).map((x, i) => x.t - f[i].t)) };
    };
    const walk = steps(plan(hall, H("hall", 100), H("hall", 400)).p);
    const run = steps(plan(hall, H("hall", 100), H("hall", 1300)).p);
    expect(run.stride).toBeGreaterThan(walk.stride * 1.2);
    expect(run.ms).toBeLessThan(walk.ms * 0.8);
  });

  it("is a pure function of the move and the way: the same trip, the same pose at the same t", () => {
    for (const [name, map, from, to] of TRIPS) {
      const a = plan(map, from, to).p;
      const b = plan(map, from, to).p;
      expect(b, name).toEqual(a);
      for (const t of [a.t0 + 1, (a.t0 + a.t1) / 2, a.t1 - 1]) expect(tripAt(b, t), name).toEqual(tripAt(a, t));
    }
  });
});
