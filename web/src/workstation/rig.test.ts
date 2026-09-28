// The rig's pure parts: footstep plans, where the feet are at t, two-bone IK, springs that settle
// and reset on a jump (so a paused replay frame is exact).
import { describe, expect, it } from "vitest";
import { feetAt, ik, makeSprings, planWalk, RIG, rootAt, routeAround, solve, Spring, WALK_MAX_MS, WALK_MIN_MS } from "./rig.ts";

const A = { x: 0, y: 0 };
const B = { x: 300, y: 0 };
const move = { from: "a", to: "b", t: 10_000, slot: 0 };

describe("planWalk", () => {
  const p = planWalk(move, A, B);
  it("starts when the move starts and lasts distance ÷ speed (clamped)", () => {
    expect(p.t0).toBe(10_000);
    expect(p.t1).toBeGreaterThan(p.t0 + 2000 - 1);
    expect(planWalk(move, A, { x: 10, y: 0 }).t1 - 10_000).toBeGreaterThanOrEqual(WALK_MIN_MS);
    expect(planWalk(move, A, { x: 5000, y: 0 }).t1 - 10_000).toBeLessThanOrEqual(WALK_MAX_MS * 1.4);
  });
  it("alternates feet, lands the last full step on the dock and closes the stance", () => {
    const feet = p.steps.map((s) => s.foot);
    for (let i = 1; i < feet.length - 1; i++) expect(feet[i]).not.toBe(feet[i - 1]);
    const last = p.steps[p.steps.length - 1];
    expect(Math.abs(last.to.x - B.x)).toBeCloseTo(RIG.stance, 6);
    expect(p.f).toBe(1);
    expect(planWalk(move, B, A).f).toBe(-1);
  });
  it("is deterministic (a pure function of the move and the docks)", () => {
    expect(planWalk(move, A, B)).toEqual(p);
  });
});

describe("feetAt", () => {
  const p = planWalk(move, A, B);
  it("keeps both feet planted before the walk and on the dock after it", () => {
    const before = feetAt(p, p.t0 - 1);
    expect(before.swing).toBe(-1);
    expect(before.feet.every((f) => f.lift === 0)).toBe(true);
    const after = feetAt(p, p.t1 + 1);
    expect(after.feet.every((f) => Math.abs(f.x - B.x) <= RIG.stance + 1e-9 && f.lift === 0)).toBe(true);
  });
  it("swings one foot at a time, lifted mid-swing", () => {
    const s = p.steps[2];
    const mid = feetAt(p, (s.t0 + s.t1) / 2);
    expect(mid.swing).toBe(s.foot);
    expect(mid.feet[s.foot].lift).toBeGreaterThan(4);
    expect(mid.feet[1 - s.foot].lift).toBe(0);
  });
  it("moves the body forward monotonically", () => {
    let x = -Infinity;
    for (let t = p.t0; t <= p.t1; t += 25) {
      const r = rootAt(p, t);
      expect(r.x).toBeGreaterThanOrEqual(x - 1.6);
      x = Math.max(x, r.x);
    }
    expect(rootAt(p, p.t1).x).toBe(B.x);
  });
});

describe("ik", () => {
  it("reaches a reachable target with bones of the right length", () => {
    const b = ik(0, 0, 10, 10, 8, 8, 1);
    expect(b.ex).toBeCloseTo(10, 6);
    expect(b.ey).toBeCloseTo(10, 6);
    expect(Math.hypot(b.jx, b.jy)).toBeCloseTo(8, 6);
    expect(Math.hypot(b.ex - b.jx, b.ey - b.jy)).toBeCloseTo(8, 6);
  });
  it("stretches toward an unreachable target without breaking", () => {
    const b = ik(0, 0, 100, 0, 8, 8, 1);
    expect(Math.hypot(b.ex, b.ey)).toBeLessThanOrEqual(16);
    expect(Number.isFinite(b.jx)).toBe(true);
  });
});

describe("springs", () => {
  it("settle on the target and stay stable at big steps", () => {
    const s = new Spring(3, 0.6, 0);
    s.reset(0);
    for (let i = 0; i < 400; i++) s.step(1 / 60, 10);
    expect(s.y).toBeCloseTo(10, 2);
    const big = new Spring(3, 0.6, 0);
    big.reset(0);
    for (let i = 0; i < 20; i++) big.step(0.5, 10);
    expect(Math.abs(big.y - 10)).toBeLessThan(1);
  });
  it("a jump (seek backwards or a long gap) resets to the exact pose", () => {
    const sp = makeSprings();
    const at = (t: number) => solve({ t, pose: "write", since: 0, dock: A, walk: null, still: false }, sp);
    for (let t = 0; t < 2000; t += 16) at(t);
    const fresh = solve({ t: 500, pose: "write", since: 0, dock: A, walk: null, still: false }, makeSprings());
    expect(at(500)).toEqual(fresh); // went backwards: reset, same as solving from scratch
  });
});

describe("walking motion", () => {
  it("eases in and out: the first and last steps take longer than the middle ones", () => {
    const p = planWalk(move, A, B);
    const full = p.steps.slice(0, -1).map((s) => s.t1 - s.t0);
    const mid = full[Math.floor(full.length / 2)];
    expect(full[0]).toBeGreaterThan(mid * 1.5);
    expect(full[full.length - 1]).toBeGreaterThan(mid * 1.5);
  });
  it("sets off after a short beat (turning to face the way)", () => {
    const p = planWalk(move, A, B);
    expect(p.steps[0].t0).toBeGreaterThan(p.t0);
  });
  it("walks around nodes in the way, not through them", () => {
    const box = { x: 120, y: -10, w: 60, h: 60 };
    const via = routeAround(A, B, [box]);
    expect(via).toHaveLength(2);
    expect(Math.max(...via.map((v) => v.y))).toBeLessThan(box.y);
    const p = planWalk(move, A, B, via);
    // no footstep lands inside the box
    for (const s of p.steps) expect(s.to.x > box.x && s.to.x < box.x + box.w && s.to.y > box.y && s.to.y < box.y + box.h).toBe(false);
    expect(routeAround(A, B, [{ x: 120, y: 200, w: 60, h: 60 }])).toEqual([]);
    // the nodes it starts and ends on are not "in the way"
    expect(routeAround({ x: 10, y: 0 }, { x: 290, y: 0 }, [{ x: 0, y: 0, w: 60, h: 40 }, { x: 260, y: 0, w: 60, h: 40 }])).toEqual([]);
  });
});
