// Going down a ladder (ACC1 #13, web/docs/workstation.md §16): facing the ladder, hands first and feet after, the body close
// and the legs long — not a squat that reads as sitting on the rungs. Going up is as it was: the knees bend to reach the
// next rung overhead. Measured on the door ladder (./rig.ts `planDoor`), mid-climb.
import { describe, expect, it } from "vitest";
import { REF_K } from "./docks.ts";
import { frames } from "./poseHealth.ts";
import { DOOR_MS, makeSprings, planDoor, solve } from "./rig.ts";

const deg = (r: number) => (r * 180) / Math.PI;

/** Mean over the middle of the climb: hip height above the feet' line, knee's reach ahead of the hip, torso lean toward the ladder (°), the highest hand above the shoulders. */
function stance(dir: 1 | -1, leaving: boolean) {
  const trip = planDoor(REF_K, dir, leaving, 1);
  const sp = makeSprings();
  const s = { n: 0, hip: 0, knee: 0, lean: 0 };
  for (let t = -100; t <= DOOR_MS + 100; t += 20) {
    const j = solve({ t, wall: t, dt: 0.02, reset: t === -100, pose: "write", since: 0, dock: { x: 0, y: 0 }, trip, k: REF_K, still: false }, sp);
    if (t < 250 || t > DOOR_MS - 100) continue;
    s.n++;
    s.hip += -j.py;
    s.knee += Math.max((j.legN.jx - j.hipN.x) * j.f, (j.legF.jx - j.hipF.x) * j.f);
    s.lean += deg(Math.atan2((j.nx - j.px) * j.f, j.py - j.ny));
  }
  return { hip: s.hip / s.n, knee: s.knee / s.n, lean: s.lean / s.n };
}

describe("a ladder climbed down", () => {
  for (const [dir, leaving, name] of [[1, true, "down into the parent's node"], [-1, false, "down from above the sub-diagram's floor"]] as const) {
    it(`${name}: the hips stay higher than the climb up's`, () => {
      const s = stance(dir, leaving);
      expect(s.hip).toBeGreaterThan(20.8);
      expect(s.hip).toBeLessThan(21.8); // higher and the head still shows over the floor line when the door closes behind it
    });
    it(`${name}: the body leans to the ladder, never back`, () => {
      expect(stance(dir, leaving).lean).toBeGreaterThan(4);
    });
  }
  it("going up is unchanged: hips low enough to reach the rung overhead", () => {
    for (const [dir, leaving] of [[1, false], [-1, true]] as const) expect(stance(dir, leaving).hip).toBeLessThan(20.6);
  });
});

// A ladder beside a node's wall (a trip through the diagram, not a door): going down it sat on its heels — hips low, both knees folded.
describe("a ladder climbed down, along a trip", () => {
  const climbing = (label: string) => frames().filter((f) => f.scenario === "trip" && f.label === `${label}, then idle` && f.joints.climb > 0.99);
  const hipOf = (fs: ReturnType<typeof frames>) => fs.reduce((n, f) => n - f.joints.py, 0) / fs.length;
  it("down: the hips stay high", () => {
    const fs = climbing("mysql → api (ladder down)");
    expect(fs.length).toBeGreaterThan(20);
    expect(hipOf(fs)).toBeGreaterThan(22);
  });
  it("down: the hips are over the feet and the torso leans in; up is as it was, the body a little back of its hands and feet", () => {
    const seat = (fs: ReturnType<typeof frames>) => {
      let behind = 0, lean = 0;
      for (const { joints: j } of fs) {
        behind += ((j.legN.ex + j.legF.ex) / 2 - j.hipN.x) * j.f;
        lean += deg(Math.atan2((j.nx - j.px) * j.f, j.py - j.ny));
      }
      return { behind: behind / fs.length, lean: lean / fs.length };
    };
    const down = seat(climbing("mysql → api (ladder down)"));
    expect(down.behind).toBeLessThan(1.6);
    expect(down.lean).toBeGreaterThan(8);
    const up = seat(climbing("api → mysql (ladder up)"));
    expect(up.behind).toBeGreaterThan(2);
    expect(up.lean).toBeLessThan(6);
    expect(hipOf(climbing("api → mysql (ladder up)"))).toBeLessThan(20.6);
  });
});
