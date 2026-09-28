// Gestures over a pose (web/docs/workstation.md §小人, the 工位视图 brief P7): what each one does and
// when, that none jumps from one frame to the next, that a moment on the timeline always gives the
// same timeline gestures (replay), and that with reduced motion nothing animates — only a lasting
// state (sitting) shows.
import { describe, expect, it } from "vitest";
import { gesture, type Gesture, type GestureIn } from "./gestures.ts";
import type { Pose } from "./rig.ts";

const T = 600_000; // a moment on the timeline
const W = 9_000_000; // a moment on the animation clock
const base: GestureIn = { pose: "think", since: 4000, t: T, wall: W, still: false };
const g = (x: Partial<GestureIn>) => gesture({ ...base, ...x });
/** One gesture per frame (16 ms) over [a, b] ms. */
const frames = (a: number, b: number, f: (ms: number) => Gesture) => {
  const out: Gesture[] = [];
  for (let ms = a; ms <= b; ms += 16) out.push(f(ms));
  return out;
};
/** Nothing added over the pose. */
const quiet = (x: Gesture) =>
  !(x.nearW ?? 0) && !(x.farW ?? 0) && !(x.nearAdd?.some(Boolean) ?? false) && !(x.farAdd?.some(Boolean) ?? false) && !(x.lean ?? 0) && !(x.tilt ?? 0) && !(x.crouch ?? 0) && !(x.sit?.w ?? 0) && !x.face && !x.turn && x.prop === undefined && !(x.bump ?? 0) && (x.scale ?? 1) === 1 && !(x.lift ?? 0) && !x.look && !(x.flash ?? 0);

describe("dispatched: the sub-agent lands beside its dispatcher", () => {
  const land = (ms: number) => g({ spawnAt: T, t: T + ms, since: 0 });
  it("appears small and a little above the ground, and stands full size on the ground by about 400 ms", () => {
    expect(land(0).scale).toBeLessThan(0.75);
    expect(land(0).lift).toBeGreaterThan(2);
    const done = land(420);
    expect(done.scale ?? 1).toBeCloseTo(1, 5);
    expect(done.lift ?? 0).toBeCloseTo(0, 5);
    expect(done.crouch ?? 0).toBeCloseTo(0, 5);
  });
  it("bends its knees once it touches down, then straightens", () => {
    const f = frames(0, 420, land);
    const deepest = f.reduce((a, b) => ((b.crouch ?? 0) > (a.crouch ?? 0) ? b : a));
    expect(deepest.crouch).toBeGreaterThan(2);
    expect(deepest.lift ?? 0).toBeCloseTo(0, 5); // on the ground by then
  });
});

describe("arriving at its node it looks down at it first, then works", () => {
  const arrive = (ms: number, pose: Pose = "write") => g({ pose, arrivedAt: T, t: T + ms, since: ms + 1500 });
  it("head tipped down at the node for about 300 ms, the hands still low", () => {
    for (const ms of [120, 280]) {
      const x = arrive(ms);
      expect(x.tilt).toBeGreaterThan(10);
      expect(x.nearW).toBeGreaterThan(0.9);
      expect(x.near![1]).toBeGreaterThan(14); // hanging, not yet at the keyboard
    }
  });
  it("then the pose takes over", () => {
    expect(quiet(arrive(600))).toBe(true);
  });
  it("a sub-agent back to hand over does not stop to look", () => {
    expect(arrive(150, "handoff").tilt ?? 0).toBe(0);
  });
});

describe("handing over: the page goes from the sub-agent's hand to its dispatcher's, who nods", () => {
  const giver = (ms: number) => g({ pose: "handoff", arrivedAt: T, t: T + ms, since: ms });
  const taker = (ms: number, dx = 18) => g({ pose: "think", receive: { at: T, dx }, t: T + ms });
  it("the dispatcher reaches out toward the sub-agent", () => {
    const x = taker(450);
    expect(x.nearW).toBeGreaterThan(0.9);
    expect(x.near![0]).toBeGreaterThan(7);
  });
  it("the page is in exactly one hand at a time: the sub-agent's, then the dispatcher's", () => {
    for (let ms = 0; ms < 1100; ms += 16) expect(giver(ms).prop !== null).not.toBe(taker(ms).prop === "carry");
    expect(giver(1000).prop).toBe(null);
    expect(taker(1000).prop).toBe("carry");
  });
  it("and nods once it has it", () => {
    expect(Math.max(...frames(560, 1100, (ms) => taker(ms)).map((x) => x.tilt ?? 0))).toBeGreaterThan(6);
    expect(Math.max(...frames(0, 540, (ms) => taker(ms)).map((x) => x.tilt ?? 0))).toBeLessThan(1);
  });
  it("turns to a sub-agent that stands behind it", () => {
    expect(taker(300, -18).face).toBe(-1);
    expect(taker(300, 18).face ?? 1).toBe(1);
  });
  it("nothing before it or long after", () => {
    expect(quiet(taker(-40))).toBe(true);
    expect(quiet(taker(3000))).toBe(true);
  });
});

describe("waiting for the person: a small wave now and then", () => {
  const wait = (wall: number, x: Partial<GestureIn> = {}) => g({ pose: "wait", wall, ...x });
  const waveX = (x: Gesture) => x.nearAdd?.[0] ?? 0;
  /** The waves over [a, b] of the animation clock: [start, end, largest swing]. */
  const waves = (a: number, b: number, x: Partial<GestureIn> = {}) => {
    const out: [number, number, number][] = [];
    for (let ms = a; ms <= b; ms += 20) {
      const v = Math.abs(waveX(wait(ms, x)));
      if (v <= 0.05) continue;
      const last = out[out.length - 1];
      if (last && ms - last[1] < 300) {
        last[1] = ms;
        last[2] = Math.max(last[2], v);
      } else out.push([ms, ms, v]);
    }
    return out;
  };
  it("every 6–8 s a short small wave; the hand is still in between", () => {
    const w = waves(W, W + 60_000);
    expect(w.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < w.length; i++) {
      expect(w[i][0] - w[i - 1][0]).toBeGreaterThanOrEqual(5900);
      expect(w[i][0] - w[i - 1][0]).toBeLessThanOrEqual(8100);
    }
    for (const [a, b, amp] of w) {
      expect(b - a).toBeLessThanOrEqual(1500);
      expect(amp).toBeLessThanOrEqual(2.5);
    }
  });
  it("when the page comes back into view it waves at the screen for about 1.2 s, bigger", () => {
    // a moment clear of the small waves
    let at = W;
    while (waves(at - 200, at + 2200).length) at += 250;
    const big = waves(at, at + 2000, { attentionAt: at });
    expect(big.length).toBe(1);
    expect(big[0][2]).toBeGreaterThan(2.5);
    expect(big[0][1] - at).toBeGreaterThan(900);
    expect(big[0][1] - at).toBeLessThanOrEqual(1300);
  });
  it("only a worker that is waiting waves when the page comes back", () => {
    expect(quiet(g({ pose: "think", attentionAt: W, wall: W + 500 }))).toBe(true);
  });
});

describe("idle a long while", () => {
  const idle = (ms: number, still = false) => g({ pose: "idle", idleFor: ms, since: 0, still });
  it("after 20 s it stretches: both hands up over its head, then down again", () => {
    expect(quiet(idle(19_000))).toBe(true);
    const top = frames(20_000, 22_000, idle).find((x) => (x.nearW ?? 0) > 0.8 && (x.farW ?? 0) > 0.8);
    expect(top).toBeDefined();
    expect(top!.near![1]).toBeLessThan(-10);
    expect(top!.far![1]).toBeLessThan(-10);
    expect(quiet(idle(23_000))).toBe(true);
  });
  it("after 40 s it sits on the node's top edge: hips down at the edge, feet over it, hands propped behind", () => {
    expect(idle(39_000).sit?.w ?? 0).toBe(0);
    const s = idle(42_000);
    expect(s.sit?.w).toBe(1);
    expect(s.sit!.hip).toBeLessThan(6);
    expect(s.sit!.feet.every((p) => p.y > 5)).toBe(true);
    expect(s.nearW).toBeGreaterThan(0.9);
    expect(s.near![0]).toBeLessThan(0);
  });
  it("gets up first when new work comes (within half a second)", () => {
    const up = (ms: number) => g({ pose: "write", roseAt: T, t: T + ms, since: ms });
    expect(up(0).sit?.w).toBeCloseTo(1, 5);
    expect(up(500).sit?.w ?? 0).toBe(0);
  });
  it("with reduced motion it still sits (a state) but does not stretch", () => {
    expect(idle(45_000, true).sit?.w).toBe(1);
    expect(quiet(idle(20_700, true))).toBe(true);
  });
});

describe("the person's pointer and words", () => {
  it("hovered, it looks at the pointer", () => {
    expect(g({ hover: { x: 40, y: -70 } }).look).toEqual({ x: 40, y: -70 });
  });
  it("hovered with no pointer position, it looks up out of the picture", () => {
    expect(g({ hover: true }).look!.y).toBeLessThan(-60);
  });
  it("clicked, it waves back for about 1.2 s", () => {
    const x = g({ clickAt: W, wall: W + 500 });
    expect(x.nearW).toBeGreaterThan(0.8);
    expect(x.near![1]).toBeLessThan(-10);
    const swing = frames(0, 1200, (ms) => g({ clickAt: W, wall: W + ms })).map((y) => y.nearAdd?.[0] ?? 0);
    expect(Math.max(...swing) - Math.min(...swing)).toBeGreaterThan(2);
    expect(quiet(g({ clickAt: W, wall: W + 1500 }))).toBe(true);
  });
  it("talked to, it turns round and nods", () => {
    expect(g({ talkAt: W, wall: W + 300 }).turn).toBe(true);
    expect(Math.max(...frames(0, 1300, (ms) => g({ talkAt: W, wall: W + ms })).map((y) => y.tilt ?? 0))).toBeGreaterThan(6);
    expect(quiet(g({ talkAt: W, wall: W + 2200 }))).toBe(true);
  });
  it("at its desk it nods without turning away from the desk", () => {
    expect(g({ pose: "write", talkAt: W, wall: W + 300 }).turn ?? false).toBe(false);
  });
});

describe("two writers on one file", () => {
  const clash = (ms: number) => g({ pose: "write", conflict: { at: T, dx: -30 }, t: T + ms });
  it("first look at each other, then recoil", () => {
    const early = clash(250);
    expect(early.look!.x).toBeLessThan(0);
    expect(early.bump ?? 0).toBe(0);
    expect(Math.max(...frames(500, 1700, clash).map((x) => x.bump ?? 0))).toBeGreaterThan(0.8);
    expect(clash(2600).bump ?? 0).toBe(0);
  });
});

describe("a file written", () => {
  const saved = (ms: number, pose: Pose = "think") => g({ pose, savedAt: T, t: T + ms, since: ms });
  it("the hands come off the keyboard and the screen flashes, the desk staying up for it", () => {
    const x = saved(150);
    expect(x.flash).toBeGreaterThan(0.5);
    expect(x.prop).toBe("laptop");
    expect(x.nearAdd![1]).toBeLessThan(0);
    expect(quiet(saved(700))).toBe(true);
  });
  it("not when it walks off at once", () => {
    expect(saved(150, "walk").flash ?? 0).toBe(0);
  });
});

describe("no gesture jumps from one frame to the next", () => {
  // The hands, lean and tilt go through springs; the whole-figure scale and lift, the hips, sitting,
  // the flash and the recoil do not, so those must already be smooth.
  const mix = (a: number, b: number, u: number) => a + (b - a) * u;
  const REST = [0, 17];
  const eff = (x: Gesture) => ({
    nx: mix(REST[0], x.near?.[0] ?? REST[0], x.nearW ?? 0) + (x.nearAdd?.[0] ?? 0),
    ny: mix(REST[1], x.near?.[1] ?? REST[1], x.nearW ?? 0) + (x.nearAdd?.[1] ?? 0),
    fx: mix(REST[0], x.far?.[0] ?? REST[0], x.farW ?? 0) + (x.farAdd?.[0] ?? 0),
    fy: mix(REST[1], x.far?.[1] ?? REST[1], x.farW ?? 0) + (x.farAdd?.[1] ?? 0),
    lean: x.lean ?? 0,
    tilt: x.tilt ?? 0,
    crouch: x.crouch ?? 0,
    sit: x.sit?.w ?? 0,
    scale: x.scale ?? 1,
    lift: x.lift ?? 0,
    flash: x.flash ?? 0,
    bump: x.bump ?? 0,
  });
  const LIMIT: Record<keyof ReturnType<typeof eff>, number> = { nx: 6, ny: 6, fx: 6, fy: 6, lean: 6, tilt: 6, crouch: 0.8, sit: 0.07, scale: 0.08, lift: 1.3, flash: 0.3, bump: 0.12 };
  const cases: [string, (ms: number) => Gesture, number, number][] = [
    ["landing", (ms) => g({ spawnAt: T, t: T + ms }), -100, 700],
    ["arrival", (ms) => g({ pose: "write", arrivedAt: T, t: T + ms }), -64, 800],
    ["handing over", (ms) => g({ pose: "handoff", arrivedAt: T, t: T + ms }), 0, 1100],
    ["taking the page", (ms) => g({ receive: { at: T, dx: 18 }, t: T + ms }), -64, 2400],
    ["waiting", (ms) => g({ pose: "wait", wall: W + ms }), 0, 20_000],
    ["page back in view", (ms) => g({ pose: "wait", attentionAt: W, wall: W + ms }), -64, 1800],
    ["stretching", (ms) => g({ pose: "idle", idleFor: 19_600 + ms }), 0, 3000],
    ["sitting down", (ms) => g({ pose: "idle", idleFor: 39_600 + ms }), 0, 3000],
    ["getting up", (ms) => g({ pose: "write", roseAt: T, t: T + ms }), 0, 900],
    ["clicked", (ms) => g({ clickAt: W, wall: W + ms }), -64, 1800],
    ["talked to", (ms) => g({ talkAt: W, wall: W + ms }), -64, 2400],
    ["two writers", (ms) => g({ pose: "write", conflict: { at: T, dx: -30 }, t: T + ms }), -64, 2600],
    ["saved", (ms) => g({ savedAt: T, t: T + ms }), -64, 900],
  ];
  it.each(cases)("%s", (_name, f, a, b) => {
    const s = frames(a, b, f).map(eff);
    for (let i = 1; i < s.length; i++)
      for (const k of Object.keys(LIMIT) as (keyof typeof LIMIT)[]) {
        const d = Math.abs(s[i][k] - s[i - 1][k]);
        if (d > LIMIT[k]) throw new Error(`${k} jumps by ${d.toFixed(3)} at frame ${i} (${a + i * 16} ms)`);
      }
  });
});

describe("replay: a moment on the timeline gives the same gestures whatever the animation clock says", () => {
  const timeline: [string, Partial<GestureIn>][] = [
    ["landing", { spawnAt: T - 200 }],
    ["arrival", { pose: "write", arrivedAt: T - 150 }],
    ["handing over", { pose: "handoff", arrivedAt: T - 600 }],
    ["taking the page", { receive: { at: T - 700, dx: 18 } }],
    ["stretching", { pose: "idle", idleFor: 20_500 }],
    ["sitting", { pose: "idle", idleFor: 40_600 }],
    ["getting up", { pose: "write", roseAt: T - 200 }],
    ["two writers", { pose: "write", conflict: { at: T - 900, dx: 25 } }],
    ["saved", { savedAt: T - 120 }],
  ];
  it.each(timeline)("%s", (_name, x) => {
    expect(g({ ...x, wall: W })).toEqual(g({ ...x, wall: W + 12_345 }));
  });
});

describe("reduced motion: nothing animates, lasting states still show", () => {
  const s = (x: Partial<GestureIn>) => g({ ...x, still: true });
  it("no landing, look-down, reach or nod, waves, stretch, turn or flash", () => {
    for (const x of [
      { spawnAt: T, t: T + 100 },
      { pose: "write" as Pose, arrivedAt: T, t: T + 100 },
      { pose: "wait" as Pose, attentionAt: W, wall: W + 400 },
      { clickAt: W, wall: W + 400 },
      { talkAt: W, wall: W + 400 },
      { pose: "idle" as Pose, idleFor: 20_700 },
      { savedAt: T, t: T + 150 },
      { pose: "write" as Pose, conflict: { at: T, dx: 20 }, t: T + 900 },
    ])
      expect(quiet(s(x))).toBe(true);
    for (let wall = W; wall < W + 20_000; wall += 250) expect(quiet(s({ pose: "wait", wall }))).toBe(true);
  });
  it("the page still changes hands, and a long rest is still spent sitting", () => {
    expect(s({ receive: { at: T, dx: 18 }, t: T + 800 }).prop).toBe("carry");
    expect(s({ pose: "handoff", arrivedAt: T, t: T + 800 }).prop).toBe(null);
    expect(s({ pose: "idle", idleFor: 45_000 }).sit?.w).toBe(1);
  });
});

describe("a command finished: the terminal lights up ✓ or ✗ for about a second (./outcome.ts's verdict)", () => {
  const ran = (ms: number, ok: boolean, x: Partial<GestureIn> = {}) => g({ pose: "think", ran: { at: T, ok }, t: T + ms, ...x });
  it("✓ when it passed, ✗ when it failed, the terminal staying up for it", () => {
    expect(ran(300, true).result).toEqual(expect.objectContaining({ ok: true }));
    expect(ran(300, true).result!.a).toBeGreaterThan(0.9);
    expect(ran(300, false).result).toEqual(expect.objectContaining({ ok: false }));
    expect(ran(300, true).prop).toBe("terminal");
    expect(quiet(ran(1300, true)) && !ran(1300, true).result).toBe(true);
  });
  it("not when it walks off at once", () => {
    expect(ran(300, true, { pose: "walk" }).result).toBeFalsy();
  });
  it("fades in and out (no jump)", () => {
    const a = frames(-64, 1300, (ms) => ran(ms, true)).map((x) => x.result?.a ?? 0);
    for (let i = 1; i < a.length; i++) expect(Math.abs(a[i] - a[i - 1])).toBeLessThanOrEqual(0.3);
  });
  it("with reduced motion the verdict still shows (a state), without fading", () => {
    expect(ran(300, false, { still: true }).result).toEqual({ ok: false, a: 1 });
  });
});
