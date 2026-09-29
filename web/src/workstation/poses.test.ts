// 姿势分层 (web/docs/workstation.md §16): the standing pose (hands behind the back) and the blends between what a worker does — the raise going into an activity, the clap coming out.
import { describe, expect, it } from "vitest";
import { arc, blendHands, BLEND_MS, CLAP, durationOf, ENTER_MS, EXIT_MS, isStand, kindOf, layerStep, RAISE, STAND, standMotion, type Layer } from "./poses.ts";
import { poseTargets, type Targets } from "./rig.ts";

const K = 0.936; // the rig's arm ÷ Loom's
const T = (pose: Parameters<typeof poseTargets>[0], since = 5000): Targets => poseTargets(pose, 0, since, { still: true });

describe("the standing pose: hands behind the back", () => {
  it("both hands are behind the body, a slight lean forward, legs straight (hips a little higher than the rig's default)", () => {
    expect(STAND.near[0]).toBeLessThan(-5);
    expect(STAND.far[0]).toBeLessThan(-5);
    expect(STAND.lean).toBeGreaterThan(0);
    expect(STAND.crouch).toBeLessThan(0);
    for (const pose of ["idle", "unknown"] as const) {
      const t = T(pose);
      expect(t.near[0]).toBeLessThan(0); // x along the facing: behind
      expect(t.far[0]).toBeLessThan(t.near[0] + 1);
      expect(t.crouch).toBeLessThan(0);
      expect(t.lean).toBe(STAND.lean);
    }
  });
  it("only idle and unknown are standing; the other poses are activities", () => {
    expect(["idle", "unknown"].every(isStand)).toBe(true);
    expect(["read", "write", "exec", "think", "wait", "delegate", "handoff", "walk"].some(isStand)).toBe(false);
  });
});

describe("what standing does by itself", () => {
  const seconds = (n: number, seed = 0) => Array.from({ length: n * 60 }, (_, i) => standMotion((i * 1000) / 60, seed));
  it("breathes a fifth of a unit, sways under half a unit, tips the head at most 5°", () => {
    const a = seconds(40);
    expect(Math.max(...a.map((m) => Math.abs(m.crouch)))).toBeLessThanOrEqual(0.22 + 1e-9);
    expect(Math.max(...a.map((m) => Math.abs(m.sway)))).toBeLessThanOrEqual(0.45 + 1e-9);
    expect(Math.max(...a.map((m) => Math.abs(m.tilt)))).toBeLessThanOrEqual(5 + 1e-9);
    expect(Math.min(...a.map((m) => m.crouch))).toBeLessThan(-0.15); // it does move
    expect(Math.max(...a.map((m) => m.sway))).toBeGreaterThan(0.3);
  });
  it("looks round now and then: a glance about a seventh of the time, each one 1–2 s, never all the time", () => {
    const a = seconds(60);
    const share = a.filter((m) => m.tilt > 0).length / a.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.25);
    let runs = 0;
    a.forEach((m, i) => void (m.tilt > 0 && !(a[i - 1]?.tilt > 0) && runs++));
    expect(runs).toBeGreaterThanOrEqual(5);
    expect(runs).toBeLessThanOrEqual(9);
  });
  it("two workers do not breathe together (a seed of their own), and reduced motion holds still", () => {
    expect(standMotion(1234, 1).crouch).not.toBeCloseTo(standMotion(1234, 2).crouch, 3);
    expect(standMotion(1234, 1, true)).toEqual({ crouch: 0, sway: 0, tilt: 0, look: [0, 0] });
  });
});

describe("blending between layers", () => {
  it("a blend takes 0.25–0.3 s; going into an activity and coming out of one have a beat of their own", () => {
    expect(BLEND_MS).toBeGreaterThanOrEqual(250);
    expect(BLEND_MS).toBeLessThanOrEqual(300);
    expect(kindOf("idle", "write")).toBe("enter");
    expect(kindOf("write", "idle")).toBe("exit");
    expect(kindOf("write", "read")).toBe("swap");
    expect(kindOf("idle", "walk")).toBe("swap");
    expect(kindOf("walk", "idle")).toBe("swap");
    expect(kindOf("walk", "write")).toBe("swap");
    expect(durationOf("enter")).toBe(ENTER_MS);
    expect(durationOf("exit")).toBe(EXIT_MS);
    expect(durationOf("swap")).toBe(BLEND_MS);
  });
  it("a hand goes round the shoulder on an arc: it never comes nearer to it than the nearer end", () => {
    const a: [number, number] = [-6.4, 12.4];
    const b: [number, number] = [8.8, -1.4];
    const near = Math.min(Math.hypot(...a), Math.hypot(...b));
    for (let u = 0; u <= 1; u += 0.02) expect(Math.hypot(...arc(a, b, u))).toBeGreaterThanOrEqual(near - 1e-9);
    expect(arc(a, b, 0)[0]).toBeCloseTo(a[0], 9);
    expect(arc(a, b, 1)[1]).toBeCloseTo(b[1], 9);
  });
  it("going into an activity the hands come out to the raise first and then go to the work; coming out they go to the clap, clap once, and go back behind the back", () => {
    const back = T("idle");
    const work = T("write");
    const at = (kind: "enter" | "exit", u: number) => blendHands(kind, kind === "enter" ? back : work, kind === "enter" ? work : back, u, K);
    expect(at("enter", 0).near[0]).toBeCloseTo(back.near[0], 6);
    expect(at("enter", 0.45).near[0]).toBeCloseTo(RAISE.near[0] * K, 6);
    expect(at("enter", 0.45).near[1]).toBeCloseTo(RAISE.near[1] * K, 6);
    expect(at("enter", 1).near[0]).toBeCloseTo(work.near[0], 6);
    expect(at("exit", 0.4).near[0]).toBeCloseTo(CLAP.near[0] * K, 6);
    expect(at("exit", 0.55).near[0]).toBeCloseTo(CLAP.near[0] * K, 6);
    const clap = [0.4, 0.44, 0.475, 0.51, 0.55].map((u) => at("exit", u).near[0]);
    expect(Math.min(...clap)).toBeLessThan(CLAP.near[0] * K - 1); // the hand comes in and goes out again: one clap
    expect(at("exit", 1).near[0]).toBeCloseTo(back.near[0], 6);
    expect(at("exit", 1).far[0]).toBeCloseTo(back.far[0], 6);
  });
});

describe("layerStep", () => {
  const stand = T("idle");
  const write = T("write");
  const read = T("read");
  it("nothing is blended at first, or after a jump; a change of layer starts from what was on screen", () => {
    const first = layerStep(null, "idle", stand, null, 0, false, K);
    expect(first.T).toBe(stand);
    const l0: Layer = { key: "idle", at: -Infinity, kind: "swap", from: null };
    const s0 = layerStep(l0, "write", write, stand, 1000, false, K);
    expect(s0.layer).toMatchObject({ key: "write", at: 1000, kind: "enter" });
    expect(s0.T.near[0]).toBeCloseTo(stand.near[0], 9);
    expect(s0.T.lean).toBeCloseTo(stand.lean, 9);
    expect(layerStep(l0, "write", write, stand, 1000, true, K).T).toBe(write); // a seek: no blend
  });
  it("it is over after its duration: the new pose exactly, nothing left to blend from", () => {
    const l: Layer = { key: "write", at: 1000, kind: "enter", from: stand };
    const done = layerStep(l, "write", write, stand, 1000 + ENTER_MS, false, K);
    expect(done.T).toBe(write);
    expect(done.layer.from).toBeNull();
    const half = layerStep(l, "write", write, stand, 1000 + ENTER_MS / 2, false, K).T;
    expect(half.near[0]).not.toBeCloseTo(write.near[0], 2);
  });
  it("a blend cut short by another change goes on from where the hands are: no jump", () => {
    const l: Layer = { key: "write", at: 1000, kind: "enter", from: stand };
    const mid = layerStep(l, "write", write, stand, 1130, false, K).T; // on screen at 1130
    const next = layerStep(l, "read", read, mid, 1146, false, K); // the next frame the pose changes
    expect(next.layer.kind).toBe("swap");
    expect(next.T.near[0]).toBeCloseTo(mid.near[0], 9);
    expect(next.T.near[1]).toBeCloseTo(mid.near[1], 9);
    expect(next.T.lean).toBeCloseTo(mid.lean, 9);
  });
  it("the hands (targets) never move more than 5 units in a frame through a whole enter, exit or swap at 60 fps", () => {
    for (const [from, to] of [[stand, write], [write, stand], [stand, read], [read, write]] as const) {
      const kind = from === stand ? "enter" : to === stand ? "exit" : "swap";
      let prev = from.near;
      for (let ms = 0; ms <= durationOf(kind); ms += 16) {
        const h = blendHands(kind, from, to, ms / durationOf(kind), K).near;
        expect(Math.hypot(h[0] - prev[0], h[1] - prev[1]), `${kind} at ${ms} ms`).toBeLessThan(5);
        prev = h;
      }
    }
  });
});
