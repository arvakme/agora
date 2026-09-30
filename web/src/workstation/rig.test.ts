// The rig's pure parts: two-bone IK, springs that settle and reset on a jump (so a paused replay
// frame is exact). Trips (footsteps, ladders) are in trip.test.ts.
import { describe, expect, it } from "vitest";
import { ik, makeSprings, solve, Spring } from "./rig.ts";

const A = { x: 0, y: 0 };

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
    const at = (t: number) => solve({ t, pose: "write", since: 0, dock: A, trip: null, still: false }, sp);
    for (let t = 0; t < 2000; t += 16) at(t);
    const fresh = solve({ t: 500, pose: "write", since: 0, dock: A, trip: null, still: false }, makeSprings());
    expect(at(500)).toEqual(fresh); // went backwards: reset, same as solving from scratch
  });
});

describe("a trip with nowhere to go", () => {
  it("has no steps when its legs add up to under a pixel (the two docks are the same spot)", async () => {
    const { planTrip } = await import("./rig.ts");
    const m = { from: "a", to: "b", t: 1000, slot: 0 };
    const tiny = planTrip(m, { legs: [{ kind: "walk", a: { x: 5, y: 5 }, b: { x: 5.3, y: 5 }, temp: false }], len: 0.3 }, { x: 5, y: 5 });
    expect(tiny.phases).toHaveLength(0);
    expect(tiny.t1).toBe(tiny.t0);
    const real = planTrip(m, { legs: [{ kind: "walk", a: { x: 5, y: 5 }, b: { x: 85, y: 5 }, temp: false }], len: 80 }, { x: 5, y: 5 });
    expect(real.phases.length).toBeGreaterThan(0);
  });
});
