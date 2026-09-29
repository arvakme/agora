// 姿势体检 (web/docs/workstation.md §小人 · 姿势体检): the rules themselves, and every pose, gesture, pose change, trip and door ladder held to them frame by frame.
import { describe, expect, it } from "vitest";
import { checkJoints, ELBOW_MAX, ELBOW_MAX_WALKING, elbowJumps, frames, jumps, speedOf, speeds, sweep, type Expect } from "./poseHealth.ts";
import { REF_K } from "./docks.ts";
import { makeSprings, planDoor, RAISED, RIG, solve, WALK_SPEED, type Joints } from "./rig.ts";

const stand = (pose: Parameters<typeof solve>[0]["pose"] = "idle"): Joints => solve({ t: 0, pose, since: 0, dock: { x: 0, y: 0 }, trip: null, still: true, reset: true, k: REF_K }, makeSprings());
const ok: Expect = { ground: [true, true], climbing: false, sitting: false, crouching: false, turning: false };
const rules = (j: Joints, e: Expect = ok) => checkJoints(j, e).map((i) => i.rule);

describe("the rules", () => {
  it("a standing figure breaks none", () => {
    for (const p of ["idle", "read", "write", "exec", "think", "wait", "delegate", "handoff", "unknown"] as const) expect(rules(stand(p))).toEqual([]);
  });
  it("a leg asked past its reach (a foot that hangs) is caught", () => {
    const j = stand();
    expect(rules({ ...j, legN: { ...j.legN, over: 2 } })).toContain("reach");
    expect(rules({ ...j, armN: { ...j.armN, over: 2 } })).not.toContain("reach"); // an arm may swing past a raised target: its hand stops at the straight arm
    expect(rules({ ...j, armN: { ...j.armN, over: 5 } })).toContain("reach");
  });
  it("a knee that points backwards, or is folded shut, is caught", () => {
    const j = stand();
    const bent = { ...j.legN, jx: 2 * j.hipN.x - j.legN.jx + 2 * (j.legN.ex - j.hipN.x) }; // mirrored through the hip → foot line
    expect(rules({ ...j, legN: bent })).toContain("knee");
    expect(rules({ ...j, legN: { ...j.legN, jx: j.hipN.x, jy: j.hipN.y + 12, ex: j.hipN.x + 1, ey: j.hipN.y + 1 } })).toContain("fold");
  });
  it("a planted foot off the ground, or one through it, is caught; a lifted foot may be up", () => {
    const j = stand();
    expect(rules({ ...j, legN: { ...j.legN, ey: -3 } })).toContain("sole");
    expect(rules({ ...j, legN: { ...j.legN, ey: -3 } }, { ...ok, ground: [false, true] })).toEqual([]);
    expect(rules({ ...j, legN: { ...j.legN, ey: 3 } }, { ...ok, ground: [false, true] })).toContain("sole");
  });
  it("a hand in the head is caught, except a hand on a rung", () => {
    const j = stand();
    const inHead = { ...j, armN: { ...j.armN, ex: j.hx + 1, ey: j.hy } };
    expect(rules(inHead)).toContain("head");
    expect(rules(inHead, { ...ok, climbing: true })).not.toContain("head");
  });
  it("a head that is not over the hips is caught", () => {
    const j = stand();
    expect(rules({ ...j, hy: j.py + 3 })).toContain("body");
  });
});

describe("every frame of every scenario", () => {
  const all = frames();
  it("there are frames of every kind", () => {
    expect(new Set(all.map((f) => f.scenario))).toEqual(new Set(["pose at rest", "pose change", "gesture", "trip", "door"]));
    expect(all.length).toBeGreaterThan(10_000);
  });
  it("none breaks a rule (poses, gestures, pose changes, walks, ladders, doors)", () => {
    const bad = sweep(all).map((b) => `${b.frame.scenario} | ${b.frame.label} | ${b.frame.t} ms: ${b.issues.map((i) => i.detail).join("; ")}`);
    expect(bad.slice(0, 8)).toEqual([]);
  });
  it("no joint jumps more than 10 figure units in one frame (mirrored turns and what a door's cut hides aside)", () => {
    expect(jumps(all).map((j) => `${j.a.label} ${j.a.t} ${j.joint} ${j.d.toFixed(1)}`).slice(0, 8)).toEqual([]);
  });
});

describe("the raised hand and the stretch keep clear of the head", () => {
  it("the wave's hand rests beside the head, not in its circle", () => {
    const j = stand("wait");
    expect(Math.hypot(j.armN.ex - j.hx, j.armN.ey - j.hy)).toBeGreaterThan(RIG.head);
    expect(RAISED[0]).toBeGreaterThan(5.6); // it was 5.6 · 3.6 units from the head's centre
  });
  it("on the way up in a stretch a hand passes the face outside the head", () => {
    const hits = frames().filter((f) => f.label.startsWith("idle: stretch")).filter((f) => f.t > 20_000 && f.t < 22_000 && [f.joints.armN, f.joints.armF].some((a) => Math.hypot(a.ex - f.joints.hx, a.ey - f.joints.hy) < RIG.head * 0.7));
    expect(hits.map((f) => f.t)).toEqual([]);
  });
});

describe("a trip's speed", () => {
  const all = speeds();
  it("tops out at the walking pace and at the climbing pace on a door's ladder, and never changes faster than the ramps allow", () => {
    for (const s of all) {
      expect(s.maxV).toBeLessThanOrEqual(WALK_SPEED * 1.02);
      expect(s.maxAccel).toBeLessThan(0.0025); // px/ms², the steepest measured is 0.0023 (pay → api)
    }
    expect(all.find((s) => s.name.startsWith("door"))!.maxV).toBeCloseTo(0.13, 2);
  });
  it("stands a beat before setting off, and goes down to rest between the legs of a trip (walk → ladder → walk)", () => {
    const trip = all.find((s) => s.name === "web → the tray (a scaffold)")!;
    expect(trip.setOff).toBeGreaterThanOrEqual(240);
    expect(trip.dips.length).toBeGreaterThanOrEqual(2); // measured 4: each leg ends at rest and the next starts from it
    expect(all.find((s) => s.name === "a few steps on one floor")!.dips).toEqual([]);
  });
  it("a door's ladder is one steady climb: no dips", () => {
    const s = speedOf("door", planDoor(REF_K, 1, true, 1));
    expect(s.dips).toEqual([]);
  });
});

describe("the elbow never flips (EL1)", () => {
  const all = frames();
  const show = (list: ReturnType<typeof elbowJumps>) => list.slice(0, 6).map((x) => `${x.a.scenario} | ${x.a.label} | ${x.a.t} ms ${x.arm} ${x.d.toFixed(1)}`);
  it("walking, at every size and pace: an elbow moves at most 3 units in a frame (long walks over 600 frames each)", () => {
    const walks = all.filter((f) => f.label.startsWith("a long walk"));
    expect(walks.length).toBeGreaterThan(1200);
    expect(show(elbowJumps(walks, ELBOW_MAX_WALKING))).toEqual([]);
  });
  it("in every pose change, gesture, trip (grabbing a rung, hopping to the next, letting go) and door ladder: at most 7 units in a frame", () => {
    expect(show(elbowJumps(all, ELBOW_MAX))).toEqual([]);
  });
  it("a hand that crosses over the shoulder goes round it on an arc: from hanging to raised, the elbow moves on steadily", () => {
    const one = all.filter((f) => f.label === "wait → idle");
    const worst = Math.max(...elbowJumps(one, 0).map((x) => x.d), 0);
    expect(worst).toBeLessThan(6);
  });
});
