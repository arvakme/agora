// The director's figure half (workstation/director.ts): what each figure shows at `now` — the world of `now − delay` (live: LOOKAHEAD_MS behind, so what
// is about to happen is already known when it is drawn; a replay: no delay) — with no jump anywhere: a worker starts from where it stood and walks, or,
// over CUT_DISTANCE, is cut across (one fades out where it was as it fades in where it goes). Pure: scanned frame by frame here.
import { describe, expect, it } from "vitest";
import { CUT_DISTANCE, CUT_MS, OUTSIDE, stateAt, type Ctx } from "./place.ts";
import { directorFrame, figureAt, LOOKAHEAD_MS, type FigureFrame } from "./director.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const run = (segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id: "r", agent: "claude", name: "Claude Code", segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
const DOCKS: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 400, y: 0 }, far: { x: 2600, y: 200 }, [OUTSIDE]: { x: 200, y: 400 } };
const ctx = (runs: WorkRun[]): Ctx => ({
  locate: (p) => (p.startsWith("far/") ? { place: "far" } : p.startsWith("server/db/") ? { place: "db" } : p.startsWith("server/") ? { place: "api" } : null),
  dock: (p) => DOCKS[p] ?? DOCKS[OUTSIDE],
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
});
const FRAME = 1000 / 60;
const scan = (r: WorkRun, c: Ctx, from: number, to: number, delay = 0): FigureFrame[] => {
  const out: FigureFrame[] = [];
  for (let now = from; now <= to; now += FRAME) out.push(directorFrame({ runs: [r], now, delay, ctx: c }).figures[0]);
  return out.filter(Boolean);
};

describe("a session that thinks first, then reads a file that is far away (the real Claude of FL2)", () => {
  const r = run([seg("think", 0, 6), seg("read", 6, 9, "far/queue.py"), seg("write", 9, 12, "far/queue.py"), seg("read", 12, 15, "server/app.py")], { running: true });
  const c = ctx([r]);
  it("stands at the tray while it thinks — where it was, not where its first file will be", () => {
    const f = directorFrame({ runs: [r], now: 3 * S, delay: 0, ctx: c }).figures[0];
    expect(f.state).toMatchObject({ present: true, at: OUTSIDE, pose: "think" });
  });
  it("its state at a moment does not depend on work that has not started by then (a live run does not have it yet)", () => {
    for (const t of [1, 3, 5.9, 6.05, 6.2, 7, 10, 13].map((x) => x * S)) {
      const known = run(r.segs.filter((g) => g.start <= t), { running: true });
      expect(stateAt(known, t, ctx([known]))).toEqual(stateAt(r, t, c));
    }
  });
  it("(c) the first file starts a cut from the tray (the far node is over CUT_DISTANCE): from where it stood", () => {
    const st = stateAt(r, 6.1 * S, c);
    expect(st).toMatchObject({ at: "far", from: OUTSIDE, w: 1, trip: null });
    expect(st.cut).toMatchObject({ from: OUTSIDE, to: "far" });
  });
  it("(a) no frame moves the figure by more than the speed limit, except across a cut", () => {
    const fr = scan(r, c, 0, 20 * S);
    const MAX = 400 / 60; // world units a frame: a walk is 130–220 a second, a held-back walk 1.5× that, with room for the ladder
    let cuts = 0;
    for (let i = 1; i < fr.length; i++) {
      const a = figureAt(fr[i - 1], c);
      const b = figureAt(fr[i], c);
      const across = !!fr[i].ghost || !!fr[i - 1].ghost || (fr[i].state.cut && fr[i - 1].state.at !== fr[i].state.at);
      if (across) {
        cuts++;
        continue;
      }
      expect(Math.hypot(b.x - a.x, b.y - a.y), `frame ${i} at ${Math.round(fr[i].t)}`).toBeLessThan(MAX);
    }
    expect(cuts).toBeGreaterThan(0);
  });
  it("(b) in a cut the two positions cross-fade: the two opacities add up to the fade, and never are both full", () => {
    const fr = scan(r, c, 5.9 * S, 6.6 * S).filter((f) => f.ghost);
    expect(fr.length).toBeGreaterThan(10);
    for (const f of fr) {
      const nowA = f.alpha * f.state.fade;
      const oldA = f.ghost!.alpha * f.state.fade;
      expect(nowA + oldA).toBeCloseTo(f.state.fade, 5);
      expect(nowA >= 0.999 && oldA >= 0.999).toBe(false);
    }
    expect(fr[0].ghost!.place).toBe(OUTSIDE);
    expect(fr[0].alpha).toBeLessThan(0.2);
    expect(fr.at(-1)!.alpha).toBeGreaterThan(0.8);
    // and after CUT_MS there is one figure, fully there
    const after = directorFrame({ runs: [r], now: 6 * S + CUT_MS + 50, delay: 0, ctx: c }).figures[0];
    expect(after.ghost).toBeUndefined();
    expect(after.alpha).toBe(1);
  });
  it("a call that reached the page late (`seen`: when it did) still cuts across from when it was seen — not from its log time, which is already past", () => {
    const late = run([seg("think", 0, 6), { ...seg("read", 6, 9, "far/queue.py"), seen: 6.9 * S }], { running: true });
    const cl = ctx([late]);
    // shown LOOKAHEAD_MS behind: the frame at 7.6 s is the world of 7.0 s, 100 ms after it was seen
    const f = directorFrame({ runs: [late], now: 6.9 * S + LOOKAHEAD_MS + 100, delay: LOOKAHEAD_MS, ctx: cl }).figures[0];
    expect(f.ghost?.place).toBe(OUTSIDE);
    expect(f.alpha).toBeLessThan(0.5);
    expect(f.alpha + f.ghost!.alpha).toBeCloseTo(1, 5);
    // a call seen long after it began (a page that just opened with the log already there) is not delayed: it is history
    const old = run([seg("think", 0, 6), { ...seg("read", 6, 9, "far/queue.py"), seen: 6 * S + 60_000 }]);
    expect(stateAt(old, 6.1 * S, ctx([old])).cut).toBeDefined();
  });
  it("a move under CUT_DISTANCE is walked, not cut: api → db (400) is a trip", () => {
    expect(Math.hypot(DOCKS.db.x - DOCKS.api.x, DOCKS.db.y - DOCKS.api.y)).toBeLessThan(CUT_DISTANCE);
    const near = run([seg("read", 0, 3, "server/app.py"), seg("write", 5, 8, "server/db/m.py")]);
    const st = stateAt(near, 5.3 * S, ctx([near]));
    expect(st.pose).toBe("walk");
    expect(st.cut).toBeUndefined();
    expect(st.trip).not.toBeNull();
  });
});

describe("(d) the delay buffer", () => {
  const r = run([seg("think", 0, 2), seg("read", 2, 6, "server/app.py"), seg("write", 6, 9, "server/db/m.py")], { running: true });
  const c = ctx([r]);
  it("shows the world of now − delay", () => {
    const out = directorFrame({ runs: [r], now: 7 * S, delay: LOOKAHEAD_MS, ctx: c });
    expect(out.t).toBe(7 * S - LOOKAHEAD_MS);
    expect(out.figures[0].state).toEqual(stateAt(r, 7 * S - LOOKAHEAD_MS, c));
  });
  it("an event that reached the director at `now` is on screen `delay` later, but known at once", () => {
    const start = 6 * S;
    const at = directorFrame({ runs: [r], now: start + 100, delay: LOOKAHEAD_MS, ctx: c });
    expect(at.figures[0].state.seg?.kind).not.toBe("write"); // not drawn yet
    expect(at.known.map((k) => k.seg.kind)).toContain("write"); // the director already has it
    expect(at.known.find((k) => k.seg.kind === "write")?.place).toBe("db");
    const later = directorFrame({ runs: [r], now: start + LOOKAHEAD_MS + 50, delay: LOOKAHEAD_MS, ctx: c });
    expect(later.figures[0].state.seg?.kind).toBe("write"); // now shown
    expect(later.known.map((k) => k.seg.kind)).not.toContain("write"); // no longer "ahead"
  });
  it("a replay has no delay: what is at the playhead is drawn, and nothing is ahead", () => {
    const out = directorFrame({ runs: [r], now: 7 * S, delay: 0, ctx: c });
    expect(out.t).toBe(7 * S);
    expect(out.known).toEqual([]);
  });
});

describe("(e) scrubbing: time going back, and standing still", () => {
  const r = run([seg("think", 0, 2), seg("read", 2, 6, "far/q.py"), seg("read", 8, 12, "server/app.py")]);
  const c = ctx([r]);
  it("the same moment gives the same frame whichever way it is reached", () => {
    const forward = [1, 3, 5, 9, 11].map((s) => directorFrame({ runs: [r], now: s * S, delay: 0, ctx: c }));
    const backward = [11, 9, 5, 3, 1].map((s) => directorFrame({ runs: [r], now: s * S, delay: 0, ctx: c })).reverse();
    expect(backward).toEqual(forward);
  });
  it("paused (the same now again and again) is the same frame; before the first work there is nobody", () => {
    const a = directorFrame({ runs: [r], now: 3.3 * S, delay: 0, ctx: c });
    expect(directorFrame({ runs: [r], now: 3.3 * S, delay: 0, ctx: c })).toEqual(a);
    expect(directorFrame({ runs: [r], now: -5 * S, delay: 0, ctx: c }).figures.filter((f) => f.state.present)).toEqual([]);
    expect(() => directorFrame({ runs: [r], now: 1e12, delay: LOOKAHEAD_MS, ctx: c })).not.toThrow();
  });
});

describe("a run that is still going does not go home", () => {
  it("no work for over a minute while the turn is running: it stays; when the turn is over the old rule applies", () => {
    const going = run([seg("read", 0, 3, "server/app.py")], { running: true });
    const done = run([seg("read", 0, 3, "server/app.py")]);
    expect(stateAt(going, 200 * S, ctx([going])).present).toBe(true);
    expect(stateAt(done, 200 * S, ctx([done])).present).toBe(false);
  });
});

// ── the camera: a rate-limited carrot and a critically damped spring, in shots (hold / follow / cut) ──
import { pickFollow } from "./liveCamera.ts";
import { CAMERA_OMEGA, cameraResume, inShot, SHOT_REACH, switchView, cameraStart, cameraStep, CARROT_SPEED, centreOf, CUT_COOLDOWN_MS, viewAt, ZOOM_MAX, ZOOM_MIN, type CameraGoal, type CameraState } from "./director.ts";
import { viewProblems, type ViewSample } from "./cameraCurve.ts";

const PANE = { w: 900, h: 700 };
const goalAt = (x: number, y: number, zoom = 1, move = true): CameraGoal => ({ view: viewAt({ x, y }, zoom, PANE), move });
type Rec = { t: number; state: CameraState; out: ReturnType<typeof cameraStep> };
/** Run the camera at 60 fps for `secs`; `goal(t)` is what the shot wants at t (ms). */
function film(secs: number, start: { x: number; y: number; zoom?: number }, goal: (t: number) => CameraGoal, opts: { manual?: (t: number) => boolean } = {}): Rec[] {
  let s = cameraStart(viewAt(start, start.zoom ?? 1, PANE), PANE);
  const out: Rec[] = [];
  for (let t = 0; t <= secs * 1000; t += FRAME) {
    const o = cameraStep(s, goal(t), { dt: FRAME, now: t, pane: PANE, manual: opts.manual?.(t) ?? false });
    s = o.state;
    out.push({ t, state: s, out: o });
  }
  return out;
}
const samples = (fr: Rec[]): ViewSample[] => fr.map((f) => ({ t: f.t, canvas: "c1", zoom: f.out.view.zoom, sx: f.out.view.scrollX, sy: f.out.view.scrollY }));
const speed = (a: Rec, b: Rec) => Math.hypot(b.state.at.x - a.state.at.x, b.state.at.y - a.state.at.y) / (FRAME / 1000);

describe("(a) the camera eases in and out", () => {
  const fr = film(4, { x: 0, y: 0 }, () => goalAt(500, 0));
  it("the first frame after a goal appears is slow: at most 20% of the peak speed", () => {
    const v = fr.slice(1).map((f, i) => speed(fr[i], f));
    const peak = Math.max(...v);
    expect(peak).toBeGreaterThan(200);
    expect(v[0]).toBeLessThanOrEqual(0.2 * peak);
  });
  it("never faster than the carrot could take it (with the spring's overshoot allowed a little) and it arrives without overshooting", () => {
    const v = fr.slice(1).map((f, i) => speed(fr[i], f));
    expect(Math.max(...v)).toBeLessThan(CARROT_SPEED * 1.05);
    expect(Math.max(...fr.map((f) => f.state.at.x))).toBeLessThan(500 + 5);
    expect(fr.at(-1)!.state.at.x).toBeCloseTo(500, 0);
  });
  it("the acceleration is bounded: no frame changes the speed by more than the spring and the carrot allow", () => {
    const v = fr.slice(1).map((f, i) => speed(fr[i], f));
    for (let i = 1; i < v.length; i++) expect(Math.abs(v[i] - v[i - 1]), `frame ${i}`).toBeLessThan(CARROT_SPEED * CAMERA_OMEGA * (FRAME / 1000) * 1.2);
  });
});

describe("(b) no snap in the speed except across a cut", () => {
  it("a goal that jumps around within a shot is followed without one frame of jerk", () => {
    const fr = film(8, { x: 0, y: 0 }, (t) => goalAt(t < 2000 ? 400 : t < 4000 ? 100 : 600, t < 4000 ? 0 : 200));
    const p = viewProblems(samples(fr), { snapPx: 12 });
    expect(p.snaps).toEqual([]);
    expect(p.switches).toEqual([]);
    expect(fr.some((f) => f.out.cut)).toBe(false);
  });
});

describe("(c) far away is a cut: one, decided once, and no going back and forth", () => {
  it("a goal over CUT_DISTANCE away cuts at once: the view is at the goal on that frame, and it says so", () => {
    const fr = film(3, { x: 0, y: 0 }, (t) => goalAt(2000, 300));
    const cuts = fr.filter((f) => f.out.cut);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].out.mode).toBe("cut");
    expect(centreOf(cuts[0].out.view, PANE).x).toBeCloseTo(2000, 0);
    expect(fr.at(-1)!.state.at.x).toBeCloseTo(2000, 0);
  });
  it("inside a shot (a goal wandering a few hundred units) there is no second cut, even if it wanders over CUT_DISTANCE from where the camera was before the cut", () => {
    const fr = film(6, { x: 0, y: 0 }, (t) => goalAt(t < 1000 ? 2000 : 2000 + 500 * Math.sin(t / 700), 300));
    expect(fr.filter((f) => f.out.cut)).toHaveLength(1);
  });
  it("a second far goal, after the cooldown, is a second cut; before it the camera does not cut back", () => {
    const fr = film(6, { x: 0, y: 0 }, (t) => (t < 1000 ? goalAt(2000, 0) : t < 1000 + CUT_COOLDOWN_MS / 2 ? goalAt(0, 0) : goalAt(-2000, 0)));
    const cuts = fr.filter((f) => f.out.cut).map((f) => f.t);
    expect(cuts.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i] - cuts[i - 1]).toBeGreaterThanOrEqual(CUT_COOLDOWN_MS);
  });
});

describe("(c) the camera's cut and the figure's cut are one cross-fade: both start together, the figure is never left outside the new picture", () => {
  // FL2's session (thinks 6 s in the tray, then a file 2400 away), live: the figures show now − LOOKAHEAD_MS
  const r = run([seg("think", 0, 6), seg("read", 6, 9, "far/queue.py"), seg("write", 9, 12, "far/queue.py"), seg("read", 12, 15, "server/app.py")], { running: true });
  const c = ctx([r]);
  const film2 = () => {
    let s = cameraStart(viewAt(DOCKS[OUTSIDE], 1, PANE), PANE);
    const rows: { t: number; f: FigureFrame; out: ReturnType<typeof cameraStep>; d: number }[] = [];
    for (let now = 0; now <= 16 * S; now += FRAME) {
      const f = directorFrame({ runs: [r], now, delay: LOOKAHEAD_MS, ctx: c }).figures[0];
      if (!f) continue;
      const p = figureAt(f, c);
      const out = cameraStep(s, { view: viewAt(p, 1, PANE), move: Math.hypot(centreOf(viewAt(p, 1, PANE), PANE).x - s.at.x, centreOf(viewAt(p, 1, PANE), PANE).y - s.at.y) > 40 }, { dt: FRAME, now, pane: PANE });
      s = out.state;
      rows.push({ t: now, f, out, d: Math.hypot(p.x - s.at.x, p.y - s.at.y) });
    }
    return rows;
  };
  it("the camera cuts in the same frames the figure does (its fade-in has just begun), once", () => {
    const rows = film2();
    const cuts = rows.filter((x) => x.out.cut);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].f.ghost).toBeTruthy(); // the figure is mid cross-fade
    expect(cuts[0].f.alpha).toBeLessThan(0.3); // and has just begun to fade in
  });
  it("no other frame moves the camera by a jump; the figure is in the middle of the pane while it is still", () => {
    const rows = film2();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].out.cut) continue;
      const a = rows[i - 1].out.state.at;
      const b = rows[i].out.state.at;
      expect(Math.hypot(b.x - a.x, b.y - a.y) / (FRAME / 1000)).toBeLessThan(CARROT_SPEED * 1.05);
    }
    const after = rows.filter((x) => x.t > 7.5 * S && x.t < 9.5 * S);
    expect(Math.max(...after.map((x) => x.d))).toBeLessThan(60);
  });
});

// N: FL2's figure stands at the tray, 1800–2500 away from the view the person had: a cut, so frame 1. A figure 500 away (the widest a shot holds, SHOT_REACH) is 500 / 780 =
// 0.64 s of carrot plus the spring's catch-up (about 1/ω = 0.3 s) → within 1.2 s = 72 frames. Under the dead zone (near the middle) it holds.
describe("(d) after a message is sent the followed figure gets into the middle of the pane, fast", () => {
  const centred = (f: Rec, p: { x: number; y: number }) => {
    const c = centreOf(f.out.view, PANE);
    return Math.abs(c.x - p.x) < PANE.w * 0.25 && Math.abs(c.y - p.y) < PANE.h * 0.25;
  };
  it("the figure at the far tray (FL2's start: 1800 away): the very first frame — a cut", () => {
    const fr = film(2, { x: 400, y: 300 }, () => goalAt(500, 1900));
    expect(centred(fr[0], { x: 500, y: 1900 })).toBe(true);
  });
  it("the figure 500 away: within 1.2 s (72 frames)", () => {
    const fr = film(3, { x: 400, y: 300 }, () => goalAt(400, 800));
    const n = fr.findIndex((f) => centred(f, { x: 400, y: 800 }));
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(72);
  });
  it("a figure already in the middle: the camera stays (hold)", () => {
    const fr = film(2, { x: 400, y: 300 }, () => goalAt(420, 310, 1, false));
    expect(fr.every((f) => f.out.mode === "hold")).toBe(true);
    expect(Math.hypot(fr.at(-1)!.state.at.x - 400, fr.at(-1)!.state.at.y - 300)).toBeLessThan(1);
  });
});

describe("(f) the person moves the canvas: the camera lets go; 「继续」 hands it back without a jump", () => {
  it("while manual nothing moves, whatever the goal", () => {
    const fr = film(3, { x: 0, y: 0 }, () => goalAt(500, 0), { manual: () => true });
    expect(fr.every((f) => f.out.mode === "manual")).toBe(true);
    expect(fr.at(-1)!.state.at).toEqual(fr[0].state.at);
  });
  it("resuming starts from the view the person left it in: the next frame is no further than one frame's worth of motion", () => {
    let s = cameraStart(viewAt({ x: 0, y: 0 }, 1, PANE), PANE);
    const theirs = viewAt({ x: 700, y: -300 }, 0.85, PANE); // the person panned and zoomed
    s = cameraResume(s, theirs, PANE);
    const o = cameraStep(s, goalAt(1000, -300, 0.85), { dt: FRAME, now: 0, pane: PANE });
    const a = centreOf(theirs, PANE);
    const b = centreOf(o.view, PANE);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(CARROT_SPEED * (FRAME / 1000) * 0.5);
    expect(Math.abs(o.view.zoom - theirs.zoom)).toBeLessThan(0.02);
    expect(o.cut).toBe(false);
  });
});

describe("zoom: only inside [ZOOM_MIN, ZOOM_MAX], smooth, and never 0.3", () => {
  it("a goal outside the range is brought into it, gradually", () => {
    const fr = film(4, { x: 0, y: 0, zoom: 0.3 }, () => goalAt(0, 0, 0.3));
    expect(fr.at(-1)!.out.view.zoom).toBeGreaterThanOrEqual(ZOOM_MIN - 1e-3); // a view from outside the range approaches it from below
    expect(fr.at(-1)!.out.view.zoom).toBeLessThanOrEqual(ZOOM_MAX + 1e-6);
    expect(viewProblems(samples(fr.slice(2)), { zoomStep: 0.03 }).zoomJumps).toEqual([]);
  });
  it("across a cut the zoom does not change by more than a frame's worth either (no fit of the whole diagram on the way)", () => {
    const fr = film(3, { x: 0, y: 0, zoom: 0.85 }, () => goalAt(3000, 0, 0.85));
    expect(viewProblems(samples(fr), { zoomStep: 0.03 }).zoomJumps).toEqual([]);
    expect(Math.min(...fr.map((f) => f.out.view.zoom))).toBeGreaterThanOrEqual(ZOOM_MIN);
  });
});

describe("(g) two agents at work: one is followed, the other cannot take the camera", () => {
  const tops = (bWorking: boolean) => [
    { id: "a", sessionId: "sa", working: true, lastWorkAt: 1 },
    { id: "b", sessionId: "sb", working: bWorking, lastWorkAt: bWorking ? 99 : 0 },
  ];
  it("while the person is talking to a, b starting to work and walking through the middle changes nothing: the camera stays on a", () => {
    const at = { a: { x: 300, y: 300 }, b: { x: 2000, y: 100 } };
    let s = cameraStart(viewAt(at.a, 1, PANE), PANE);
    let worst = 0;
    for (let t = 0; t <= 12000; t += FRAME) {
      const b = { x: 2000 - t * 0.3, y: 300 }; // b walks across the whole diagram, through a's place, from 3 s on
      const p = pickFollow({ on: true, playing: null, chosen: null, focusedSession: "sa", tops: tops(t > 3000) })!;
      const target = p.run === "a" ? at.a : b;
      expect(p.run).toBe("a");
      const o = cameraStep(s, { view: viewAt(target, 1, PANE), move: true }, { dt: FRAME, now: t, pane: PANE });
      s = o.state;
      worst = Math.max(worst, Math.hypot(s.at.x - at.a.x, s.at.y - at.a.y));
    }
    expect(worst).toBeLessThan(1);
  });
  it("the person chooses b (a click on its figure): the camera goes to b once, and stays with b whoever works", () => {
    const p = pickFollow({ on: true, playing: null, chosen: "b", focusedSession: "sa", tops: tops(false) })!;
    expect(p.run).toBe("b");
  });
});

describe("root cause 6: switching canvas never flashes the whole diagram (zoom 1 → 0.3 in one frame)", () => {
  const fit03 = { zoom: 0.3, scrollX: 20, scrollY: 40 }; // a large diagram fitted to the pane
  const home = viewAt({ x: 300, y: 200 }, 1, PANE);
  it("live, paused, no view to give back: the shot's view, else the canvas's fit held to the zoom range", () => {
    const shot = viewAt({ x: 900, y: 500 }, 0.9, PANE);
    expect(switchView({ live: true, restore: false, home: false, homeView: null, follow: shot, fit: fit03, pane: PANE })).toEqual(shot);
    const v = switchView({ live: true, restore: false, home: false, homeView: null, follow: null, fit: fit03, pane: PANE })!;
    expect(v.zoom).toBeGreaterThanOrEqual(ZOOM_MIN);
    expect(v.zoom).toBeLessThanOrEqual(ZOOM_MAX);
  });
  it("live, coming home without a remembered view: still not the whole diagram", () => {
    const v = switchView({ live: true, restore: true, home: true, homeView: null, follow: null, fit: fit03, pane: PANE })!;
    expect(v.zoom).toBeGreaterThanOrEqual(ZOOM_MIN);
  });
  it("live, coming home: the view the person left", () => {
    expect(switchView({ live: true, restore: true, home: true, homeView: home, follow: null, fit: fit03, pane: PANE })).toEqual(home);
  });
  it("a play may still show the whole diagram (its overview and its summary)", () => {
    expect(switchView({ live: false, restore: false, home: false, homeView: null, follow: null, fit: fit03, pane: PANE })).toEqual(fit03);
  });
  it("across the whole switch the zoom the person sees never drops below the range", () => {
    // from a followed view (zoom 1) to a canvas that has only its fit: the zoom on the new canvas
    const to = switchView({ live: true, restore: false, home: false, homeView: null, follow: null, fit: fit03, pane: PANE })!;
    expect(1 - to.zoom).toBeLessThanOrEqual(1 - ZOOM_MIN + 1e-9);
  });
});

describe("(e) the turn ends: three seconds on, the camera eases back to the view the person had", () => {
  it("from the followed place it travels home under the same speed and acceleration limits, and arrives", () => {
    const home = viewAt({ x: 0, y: 0 }, 1, PANE);
    const fr = film(4, { x: 400, y: 300 }, () => ({ view: home, move: true }));
    expect(fr.some((f) => f.out.cut)).toBe(false);
    const c = centreOf(fr.at(-1)!.out.view, PANE);
    expect(Math.hypot(c.x, c.y)).toBeLessThan(3);
    expect(fr.at(-1)!.out.mode).toBe("hold"); // arrived
    expect(Math.max(...fr.slice(1).map((f, i) => speed(fr[i], f)))).toBeLessThanOrEqual(CARROT_SPEED * 1.05);
    expect(viewProblems(samples(fr), { snapPx: 12 }).snaps).toEqual([]);
  });
});

describe("zoom from outside the range eases in (a play's overview leaves the view at 0.3)", () => {
  it("no frame changes the zoom by a jump, the first included", () => {
    const fr = film(4, { x: 0, y: 0, zoom: 0.3 }, () => goalAt(0, 0, 1));
    expect(viewProblems(samples(fr), { zoomStep: 0.03 }).zoomJumps).toEqual([]);
    expect(fr.at(-1)!.out.view.zoom).toBeGreaterThan(0.95);
  });
});

describe("the shot: the place the figure is going to is framed with it only when it is near (SHOT_REACH)", () => {
  const node = { x: 1000, y: 100, w: 200, h: 100 };
  it("within SHOT_REACH of the figure: framed together", () => expect(inShot({ x: 700, y: 150 }, node)).toBe(true));
  it("further (a cut or a long walk): the figure only — the view does not zoom out to hold both (FL2 after DR3: zoom 1 → 0.88 before a cut)", () => {
    expect(inShot({ x: 100, y: 150 }, node)).toBe(false);
    expect(SHOT_REACH).toBe(520);
  });
});

// ── the build replay's hop (web/docs/share-build-replay.md): a call that says its move is a cut, whatever the distance ──
describe("a call marked `cut` (the build replay skips a long walk): the move to it is a cut, drawn as one cross-fade", () => {
  const r = (cut: boolean) => run([seg("write", 0, 2, "server/app.py"), { ...seg("write", 2, 4, "server/db/x.py"), ...(cut ? { cut: true as const } : {}) }]);
  it("marked: at the new place from the moment it sets off, a cut for CUT_MS, no trip", () => {
    const c = ctx([r(true)]);
    const st = stateAt(r(true), 2.1 * S, c);
    expect(st).toMatchObject({ at: "db", from: "api", trip: null, w: 1 });
    expect(st.cut).toMatchObject({ from: "api", to: "db" });
    expect(stateAt(r(true), 2 * S + CUT_MS + 5, c).cut).toBeUndefined();
  });
  it("the two opacities add up to the fade all through it, and the old place is where it stood", () => {
    const c = ctx([r(true)]);
    const fr = scan(r(true), c, 1.9 * S, 2.6 * S).filter((f) => f.ghost);
    expect(fr.length).toBeGreaterThan(10);
    for (const f of fr) expect(f.alpha * f.state.fade + f.ghost!.alpha * f.state.fade).toBeCloseTo(f.state.fade, 5);
    expect(fr[0].ghost!.place).toBe("api");
  });
  it("not marked: the same 400 is a walk (under CUT_DISTANCE), so the mark is what makes the cut", () => {
    const st = stateAt(r(false), 2.1 * S, ctx([r(false)]));
    expect(st.cut).toBeUndefined();
    expect(st.trip).not.toBeNull();
  });
  it("reduced motion walks nowhere at all: never a cut", () => {
    const c = { ...ctx([r(true)]), reduced: true };
    expect(stateAt(r(true), 2.1 * S, c).cut).toBeUndefined();
  });
});

describe("the camera's zoom range can be widened (the build replay fits a whole diagram: 0.55)", () => {
  it("a goal at 0.6 is reached with `zoom` {min: 0.55}; without it the range is [0.7, 1]", () => {
    let s = cameraStart(viewAt({ x: 0, y: 0 }, 1, PANE), PANE);
    let t = 0;
    for (let i = 0; i < 60 * 5; i++, t += FRAME) s = cameraStep(s, goalAt(0, 0, 0.6), { dt: FRAME, now: t, pane: PANE, zoom: { min: 0.55, max: 1 } }).state;
    expect(s.at.zoom).toBeCloseTo(0.6, 2);
    let d = cameraStart(viewAt({ x: 0, y: 0 }, 1, PANE), PANE);
    for (let i = 0; i < 60 * 5; i++, t += FRAME) d = cameraStep(d, goalAt(0, 0, 0.6), { dt: FRAME, now: t, pane: PANE }).state;
    expect(d.at.zoom).toBeCloseTo(0.7, 2);
  });
});

describe("a cut the caller asks for (the figure was cut across: the build replay's hop)", () => {
  it("the shot changes with it whatever the distance and however soon after the last cut; the view is at the shot from that frame", () => {
    let s = cameraStart(viewAt({ x: 0, y: 0 }, 1, PANE), PANE);
    const near = goalAt(300, 100);
    const a = cameraStep(s, near, { dt: FRAME, now: 0, pane: PANE, cut: true });
    expect(a).toMatchObject({ cut: true, mode: "cut" });
    expect(centreOf(a.view, PANE)).toEqual({ x: 300, y: 100 });
    s = a.state;
    const b = cameraStep(s, goalAt(700, 100), { dt: FRAME, now: 500, pane: PANE, cut: true }); // 500 ms later: a cut again — the figure was
    expect(b.cut).toBe(true);
    const c = cameraStep(b.state, goalAt(900, 100), { dt: FRAME, now: 520, pane: PANE }); // and without the ask, the distance rule and its cool-down still hold
    expect(c.cut).toBe(false);
  });
});
