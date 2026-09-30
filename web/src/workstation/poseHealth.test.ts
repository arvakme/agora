// 姿势体检 (web/docs/workstation.md §小人 · 姿势体检): the rules themselves, and every pose, gesture, pose change, trip and door ladder held to them frame by frame.
import { describe, expect, it } from "vitest";
import { ACCEL_MAX, checkJoints, ELBOW_MAX, ELBOW_MAX_WALKING, elbowJumps, frames, gaits, HIP_SHAKE_MAX, jumps, layerJumps, RUNG_OFF_MAX, speedOf, standRange, speeds, SWAP_MAX, sweep, type Expect } from "./poseHealth.ts";
import { REF_K } from "./docks.ts";
import { ladderShape } from "./hatch.ts";
import { DOOR_H, DOOR_MS, makeSprings, planDoor, RAISED, RIG, RUNG, rungCount, solve, WALK_SPEED, type Joints } from "./rig.ts";

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
    const bent = { ...j.legN, jx: Math.min(j.hipN.x, j.legN.ex) - 4, jy: (j.hipN.y + j.legN.ey) / 2 }; // behind the hip → foot line
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
    expect(new Set(all.map((f) => f.scenario))).toEqual(new Set(["pose at rest", "pose change", "stand", "layer", "gesture", "trip", "door"]));
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

describe("a trip's speed (DR4)", () => {
  const all = speeds();
  // how long each trip took before DR4 (ms, from set-off to the last foot down): the trips may not get slower than 10 % over it — those with no ladder in them
  const BEFORE: Record<string, number> = { "web → api (a bridge)": 2048, "a few steps on one floor": 672 };
  // …and before POL3 (梯子档距放大: a ladder is climbed at 0.0625 px/ms, not 0.13, so a pair of hands and feet changes over 3 times a second, not 10–20): those with one climb over most of a ladder's length, at most 75 % longer
  // (measured: 3076 → 4048, 3076 → 4048, 3740 → 5616, 2668 → 4544, 5648 → 8256 ms; the ladder's own part of a trip about twice as long)
  const BEFORE_POL3: Record<string, number> = { "api → mysql (ladder up)": 3076, "mysql → api (ladder down)": 3076, "web → pay (bridge, then down beside api)": 3740, "pay → api (up beside api)": 2668, "web → the tray (a scaffold)": 5648 };
  it("tops out at the walking pace and, on a door's ladder, at the climbing pace (0.0625 px/ms: a pair changes over 3.1 times a second)", () => {
    for (const s of all) expect(s.maxV).toBeLessThanOrEqual(WALK_SPEED * 1.02);
    expect(all.find((s) => s.name.startsWith("door"))!.maxV).toBeCloseTo(0.0625, 3);
  });
  it("never changes speed faster than 1200 px/s² (0.0012 px/ms²): a start, a stop and the change between walking and climbing all ease", () => {
    expect(all.filter((s) => s.maxAccel > ACCEL_MAX).map((s) => `${s.name} ${(s.maxAccel * 1000).toFixed(0)}`)).toEqual([]);
  });
  it("goes from walking to climbing and back without stopping: no dip to rest inside a trip (it stands only before the first step and at the end)", () => {
    expect(all.filter((s) => s.dips.length).map((s) => `${s.name} ${s.dips}`)).toEqual([]);
    for (const s of all.filter((x) => !x.name.startsWith("door"))) expect(s.setOff).toBeGreaterThanOrEqual(240);
  });
  it("no frame changes the speed by more than 0.019 px/ms (the 1200 px/s² limit over one 16 ms frame)", () => {
    for (const s of all) for (let i = 1; i < s.samples.length; i++) expect(Math.abs(s.samples[i].v - s.samples[i - 1].v), `${s.name} @${s.samples[i].t}`).toBeLessThanOrEqual(0.0195);
  });
  it("a trip is not slower than before: at most 10 % longer without a ladder, at most 75 % longer with one (POL3)", () => {
    const took = (s: (typeof all)[number]) => s.samples[s.samples.length - 1].t - s.samples[0].t;
    for (const s of all) {
      if (BEFORE[s.name]) expect(took(s), s.name).toBeLessThanOrEqual(BEFORE[s.name] * 1.1);
      if (BEFORE_POL3[s.name]) expect(took(s), s.name).toBeLessThanOrEqual(BEFORE_POL3[s.name] * 1.75);
    }
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

describe("the standing pose and the layers (DR4)", () => {
  const all = frames();
  it("standing, both hands are behind the torso's back edge, in every frame of 24 s of breathing, shifting and glancing (and never drawn over the body in front)", () => {
    const st = all.filter((f) => f.scenario === "stand");
    expect(st.length).toBeGreaterThan(2400);
    expect(st.every((f) => f.expect.handsBack)).toBe(true);
    expect(sweep(st).map((b) => b.issues.map((i) => i.detail))).toEqual([]);
  });
  it("the rule sees a hand in front of the back edge", () => {
    const j = stand("idle");
    const hand = { ...j.armN, ex: j.px + 1, ey: j.py - 2 };
    expect(rules({ ...j, armN: hand }, { ...ok, handsBack: true })).toContain("behind");
  });
  it("its own motion is small: the hips move under 1.5 units, the body sways under 2.5, the head tips under 10° (lean and glance)", () => {
    const r = standRange(all.filter((f) => f.scenario === "stand" && f.label.startsWith("idle")));
    expect(r.hips).toBeLessThan(1.5);
    expect(r.hips).toBeGreaterThan(0.1); // it breathes
    expect(r.sway).toBeLessThan(2.5);
    expect(r.tilt).toBeLessThan(10);
  });
  it("into an activity and out of it (raise, clap, back behind the back), and from one activity to another: no joint jumps more than 5 units in a frame, and the hands are behind the back again once it stands", () => {
    const layers = all.filter((f) => f.scenario === "layer");
    expect(layers.length).toBeGreaterThan(5000);
    expect(layerJumps(all).map((x) => `${x.a.label} ${x.a.t} ${x.joint} ${x.d.toFixed(1)}`)).toEqual([]);
    expect(layers.some((f) => f.expect.handsBack)).toBe(true);
    expect(sweep(layers).map((b) => `${b.frame.label} ${b.frame.t} ${b.issues[0].detail}`).slice(0, 4)).toEqual([]);
  });
});

describe("the gait on a ladder (POL3)", () => {
  const all = gaits();
  it("covers the trips with a ladder and every door, both ways", () => {
    expect(all.length).toBeGreaterThanOrEqual(13);
    expect(all.every((g) => g.swaps.length >= 2)).toBe(true);
  });
  it("a diagonal pair of hands and feet changes over at most SWAP_MAX (3.2) times a second, on every ladder", () => {
    expect(all.filter((g) => g.maxRate > SWAP_MAX).map((g) => `${g.name} ${g.maxRate.toFixed(1)}/s`)).toEqual([]);
  });
  it("hands and feet on a rung are on the drawn rung (within 1 figure unit), and the hips do not shake (0.6)", () => {
    expect(all.filter((g) => g.offRung > RUNG_OFF_MAX).map((g) => `${g.name} ${g.offRung.toFixed(2)}`)).toEqual([]);
    expect(all.filter((g) => g.hipShake > HIP_SHAKE_MAX).map((g) => `${g.name} ${g.hipShake.toFixed(2)}`)).toEqual([]);
  });
  it("a door's whole trip (in or out) takes at most 1.3 s", () => {
    expect(DOOR_MS).toBeLessThanOrEqual(1300);
    expect(DOOR_MS).toBeGreaterThan(1000); // not hurried back to a scurry
  });
  it("a door's ladder is drawn with the rungs its hands and feet hold: the same count, at most RUNG apart, and a limb reaches 4 of them a move", () => {
    const shape = ladderShape(1);
    const sp = shape.rungs[0] - shape.rungs[1];
    expect(sp).toBeCloseTo(DOOR_H / rungCount(DOOR_H), 9);
    expect(sp).toBeLessThanOrEqual(RUNG);
    expect(sp).toBeGreaterThan(7);
    expect(rungCount(DOOR_H / REF_K * REF_K)).toBe(rungCount(DOOR_H)); // whatever the figure's size
  });
});
