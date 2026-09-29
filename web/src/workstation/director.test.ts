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
