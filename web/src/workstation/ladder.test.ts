// 进出子图 = 爬梯子 (web/docs/workstation.md §12): going through a door is a climb down (or up) a ladder one figure high.
// The part of the body past the floor line is cut off — it is not shrunk or faded — and the moment it is all the way
// down is the moment the door's phase turns `behind`. Pure: the trip (./rig.ts `planDoor`), the line it is cut at and
// the ladder that is drawn (./hatch.ts).
import { describe, expect, it } from "vitest";
import { REF_K } from "./docks.ts";
import { ladderShape, cutLine } from "./hatch.ts";
import { CLIMB_SPEED, DOOR_H, DOOR_MS, makeSprings, planDoor, RIG, solve, tripAt } from "./rig.ts";

const K = REF_K;
/** The figure at door time t: the top of its head and the sole of its foot (world y, the floor line = 0), and what solve says about scale. */
function at(dir: 1 | -1, leaving: boolean, t: number, k = K) {
  const trip = planDoor(k, dir, leaving, 1);
  const j = solve({ t, dt: 0.016, reset: true, pose: "write", since: 0, dock: { x: 0, y: 0 }, trip, k, still: false }, makeSprings());
  return { j, root: j.root.y, top: j.root.y + (j.hy - RIG.head) * k, walking: j.walking, climb: j.climb };
}

describe("the trip through a door", () => {
  it("takes DOOR_MS and covers one figure's height at the climbing pace", () => {
    const trip = planDoor(K, 1, true, 1);
    expect(trip.t0).toBe(0);
    expect(trip.t1).toBe(DOOR_MS);
    expect(tripAt(trip, 0).root.y).toBe(0);
    expect(tripAt(trip, DOOR_MS).root.y).toBeCloseTo(DOOR_H * K, 5);
    // mid-climb (the pace is the top of the ramps): px per ms
    const mid = trip.phases.find((p) => p.kind === "climb")!;
    const m = (mid.t0 + mid.t1) / 2;
    const v = (tripAt(trip, m + 5).root.y - tripAt(trip, m - 5).root.y) / 10;
    expect(v).toBeGreaterThan(CLIMB_SPEED * 0.95);
    expect(v).toBeLessThan(CLIMB_SPEED * 1.05);
  });

  it("a smaller figure (a sub-agent) takes as long, over a shorter way: the pace scales with it", () => {
    const small = planDoor(K * 0.8, 1, true, 1);
    expect(small.t1).toBe(DOOR_MS);
    expect(tripAt(small, DOOR_MS).root.y).toBeCloseTo(DOOR_H * K * 0.8, 5);
  });

  it("going in on the parent canvas: down, never back up; hands and feet on the ladder before it drops", () => {
    let prev = -Infinity;
    for (let t = 0; t <= DOOR_MS; t += 10) {
      const y = tripAt(planDoor(K, 1, true, 1), t).root.y;
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
    const early = tripAt(planDoor(K, 1, true, 1), 20);
    expect(early.root.y).toBeLessThan(1); // still at the top while it takes hold
    const later = tripAt(planDoor(K, 1, true, 1), 250);
    expect(later.hands).not.toBeNull();
    expect(later.climb).toBe(1);
  });

  it("the floor line cuts the figure off: standing on it at first, part way through half in, then all the way under (no shrinking, no fading)", () => {
    expect(cutLine(1, K)).toBe(0);
    const start = at(1, true, 0);
    expect(start.top).toBeLessThan(-40 * K); // a whole figure above the line
    expect(start.root).toBeCloseTo(0, 5);
    const half = at(1, true, DOOR_MS * 0.6);
    expect(half.top).toBeLessThan(0);
    expect(half.root).toBeGreaterThan(0); // head above the line, feet below it: cut through the middle
    const end = at(1, true, DOOR_MS - 1);
    expect(end.top).toBeGreaterThanOrEqual(0); // nothing of it above the line: gone
    expect(end.j.scale).toBeUndefined();
  });

  it("coming out is the same climb backwards: the position at t is the going-in position at DOOR_MS − t", () => {
    for (const t of [0, 100, 250, 400, 600, DOOR_MS]) {
      expect(tripAt(planDoor(K, 1, false, 1), t).root.y).toBeCloseTo(tripAt(planDoor(K, 1, true, 1), DOOR_MS - t).root.y, 6);
    }
    expect(at(1, false, 1).top).toBeGreaterThanOrEqual(0); // all the way under to begin with
    const end = tripAt(planDoor(K, 1, false, 1), DOOR_MS);
    expect(end.root.y).toBe(0); // and up on the floor at the end, standing
    expect(end.climb).toBe(0);
  });

  it("the sub-diagram's canvas: it comes down from one figure's height above the floor, cut off by that line, and stands on the floor", () => {
    const line = cutLine(-1, K);
    expect(line).toBeCloseTo(-DOOR_H * K, 5);
    const start = at(-1, false, 0);
    expect(start.root).toBeLessThanOrEqual(line + 1e-6); // the soles at the line: all of it above, out of the picture
    const end = tripAt(planDoor(K, -1, false, 1), DOOR_MS);
    expect(end.root.y).toBe(0);
    // going up and out is the reverse
    expect(tripAt(planDoor(K, -1, true, 1), 0).root.y).toBe(0);
    expect(tripAt(planDoor(K, -1, true, 1), DOOR_MS).root.y).toBeCloseTo(line, 5);
    const gone = at(-1, true, DOOR_MS - 1);
    expect(gone.root).toBeLessThanOrEqual(line + 1);
  });
});

describe("the ladder that is drawn at a door", () => {
  it("on the parent canvas its upper end stands above the floor, the rest is under it (cut off)", () => {
    const l = ladderShape(1);
    expect(l.top).toBeLessThan(0);
    expect(l.bottom).toBe(0);
    expect(l.rungs.length).toBeGreaterThan(1);
    expect(l.rungs.every((y) => y < 0 && y >= l.top)).toBe(true);
  });

  it("on the sub-diagram's canvas it hangs from one figure's height above the floor down to the floor", () => {
    const l = ladderShape(-1);
    expect(l.top).toBeCloseTo(-DOOR_H, 5);
    expect(l.bottom).toBe(0);
    expect(l.rungs.length).toBeGreaterThan(4);
  });
});
