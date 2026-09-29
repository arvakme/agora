// The camera follows the main agent by default (web/docs/workstation.md §10 默认跟随): who it follows (a played
// turn first, then the one the person chose, then the main agent — the top-level run of the session the person is
// looking at, else the top-level run most recently at work), when it holds still (the agent is idle), when
// the person's own doing pauses it and what resumes it. Pure.
import { describe, expect, it } from "vitest";
import { canvasStep, ENTER_MS, HOME_AFTER_MS, isWorking, MOUNT_GRACE_MS, newCanvasMachine, newSpell, nextPaused, pickFollow, SPELL_FIRST_SIGHT_MS, spellStep, type CanvasIn, type Top } from "./liveCamera.ts";

const top = (id: string, o: Partial<Top> = {}): Top => ({ id, sessionId: `s-${id}`, working: false, lastWorkAt: 0, ...o });
const base = { on: true, playing: null, chosen: null, focusedSession: null, tops: [] as Top[] };

describe("pickFollow: whom the camera follows", () => {
  it("nobody when the switch is off (the canvas does not move) — except for a played turn, which the person asked for", () => {
    expect(pickFollow({ ...base, on: false, tops: [top("a", { working: true })] })).toBeNull();
    expect(pickFollow({ ...base, on: false, playing: "a", tops: [top("a")] })).toEqual({ run: "a", why: "play" });
  });
  it("a played turn beats a chosen agent beats the main agent", () => {
    const tops = [top("a", { working: true }), top("b", { working: true })];
    expect(pickFollow({ ...base, tops, playing: "b", chosen: "a" })).toEqual({ run: "b", why: "play" });
    expect(pickFollow({ ...base, tops, chosen: "b" })).toEqual({ run: "b", why: "chosen" });
    expect(pickFollow({ ...base, tops })).toMatchObject({ why: "main" });
  });
  it("the main agent is the top-level run of the session the person is looking at", () => {
    const tops = [top("a", { working: true, lastWorkAt: 900 }), top("b", { working: false, lastWorkAt: 100 })];
    expect(pickFollow({ ...base, tops, focusedSession: "s-b" })).toEqual({ run: "b", why: "main" });
  });
  it("without a session in focus: the top-level run most recently at work", () => {
    const tops = [top("a", { lastWorkAt: 100 }), top("b", { lastWorkAt: 800 }), top("c", { lastWorkAt: 300 })];
    expect(pickFollow({ ...base, tops })).toEqual({ run: "b", why: "main" });
  });
  it("one at work now beats one that only worked more recently", () => {
    const tops = [top("a", { working: true, lastWorkAt: 100 }), top("b", { lastWorkAt: 800 })];
    expect(pickFollow({ ...base, tops })).toEqual({ run: "a", why: "main" });
  });
  it("a focused session that is not on the page (no run) falls back to the most recent one", () => {
    expect(pickFollow({ ...base, tops: [top("a", { lastWorkAt: 5 })], focusedSession: "s-gone" })).toEqual({ run: "a", why: "main" });
  });
  it("a chosen sub-agent is followed as well (the chosen one, whoever it is)", () => {
    expect(pickFollow({ ...base, tops: [top("a", { working: true })], chosen: "kid" })).toEqual({ run: "kid", why: "chosen" });
  });
  it("nobody at all: nobody", () => {
    expect(pickFollow(base)).toBeNull();
  });
});

describe("nextPaused: the person's own doing pauses the camera; only the button resumes it", () => {
  it("panning, zooming, selecting or editing an element, opening comments and Esc pause it", () => {
    for (const ev of ["pan", "zoom", "select", "edit", "comment", "escape"] as const) expect(nextPaused(false, ev)).toBe(true);
  });
  it("stays paused however much happens until the button", () => {
    expect(nextPaused(true, "pan")).toBe(true);
    expect(nextPaused(true, "agent-moves")).toBe(true);
    expect(nextPaused(true, "resume")).toBe(false);
  });
  it("things that are not the person's doing leave it as it is", () => {
    expect(nextPaused(false, "agent-moves")).toBe(false);
  });
  it("a fresh page starts unpaused (a pause is not a switch: it is not kept)", () => {
    expect(nextPaused(false, "agent-moves")).toBe(false);
  });
});

describe("isWorking: one standard for the strip and the camera", () => {
  const run = (running: boolean, segs: [number, number][]) => ({ running, segs: segs.map(([start, end]) => ({ start, end })) });
  it("the turn is running: working, whatever the calls", () => expect(isWorking(run(true, []), 10)).toBe(true));
  it("a call in progress: working", () => expect(isWorking(run(false, [[5, 20]]), 10)).toBe(true));
  it("turn over, no call in progress: idle", () => expect(isWorking(run(false, [[5, 8]]), 10)).toBe(false));
});

// ── the live camera's state machine, fed a time series ──
describe("canvasStep: which canvas the camera shows, over time", () => {
  const base: CanvasIn = { now: 0, working: true, want: "home", shown: "home", home: "home", cur: "home", busy: false, manual: false, displaced: false };
  /** Feeds one tick per `dt` ms; `f(t)` gives that tick's changes; returns the actions that were not "none", with their times. */
  const run = (seconds: number, f: (t: number) => Partial<CanvasIn>, dt = 200) => {
    const m = newCanvasMachine();
    const acts: { t: number; type: string; to?: string }[] = [];
    const cur = { ...base };
    for (let t = 0; t <= seconds * 1000; t += dt) {
      Object.assign(cur, { now: t }, f(t));
      const a = canvasStep(m, { ...cur });
      if (a.type !== "none") {
        acts.push({ t, type: a.type, to: "to" in a ? a.to : undefined });
        // the world follows the action: the canvas is shown (and mounted), the person's canvas is where they went
        if (a.type === "go") ((cur.shown = a.to), (cur.cur = a.to), (cur.displaced = a.to !== cur.home));
        if (a.type === "home") ((cur.shown = cur.home), (cur.cur = cur.home), (cur.displaced = false));
        if (a.type === "user-moved") ((cur.shown = a.to), (cur.home = a.to), (cur.displaced = false));
      }
    }
    return acts;
  };
  it("thinking for 20 s inside a sub-diagram: nothing — no home, no going in and out", () => {
    // it went in at 4 s (wanted there for 3 s), then thinks (still running, no calls) for 20 s
    const acts = run(30, (t) => ({ want: t >= 1000 ? "child" : "home", working: true }));
    expect(acts).toEqual([{ t: 4000, type: "go", to: "child" }]);
  });
  it("several files written in a sub-diagram in a row: one way in, none out until the turn ends", () => {
    const acts = run(40, (t) => ({ want: t >= 1000 && t < 30000 ? "child" : "home", working: t < 30000 }));
    expect(acts.map((a) => a.type)).toEqual(["go", "home"]);
    expect(acts[1].t).toBeGreaterThanOrEqual(30000 + HOME_AFTER_MS);
  });
  it("it does not go in for a door it is only passing (wanted there for less than a few seconds)", () => {
    const acts = run(20, (t) => ({ want: t >= 2000 && t < 2000 + ENTER_MS - 400 ? "child" : "home" }));
    expect(acts).toEqual([]);
  });
  it("coming back out to the home canvas mid-turn also waits (no big switch for a short trip)", () => {
    const acts = run(40, (t) => ({ want: t >= 1000 && t < 20000 ? "child" : t >= 20000 && t < 20000 + ENTER_MS - 400 ? "home" : "child" }));
    expect(acts.map((a) => a.type)).toEqual(["go"]);
  });
  it("home only when the turn has ended, about 3 s after — and once", () => {
    const acts = run(20, (t) => (t === 0 ? { working: true, want: "child", displaced: true, shown: "child", cur: "child" } : { working: t < 6000 }));
    expect(acts.filter((a) => a.type === "home")).toHaveLength(1);
    expect(acts.find((a) => a.type === "home")!.t).toBeGreaterThanOrEqual(6000 + HOME_AFTER_MS);
  });
  it("a new turn starting before the 3 s are up cancels going home", () => {
    const acts = run(20, (t) => (t === 0 ? { displaced: true, shown: "child", cur: "child", want: "child" } : { working: !(t >= 6000 && t < 8000) }));
    expect(acts.some((a) => a.type === "home")).toBe(false);
  });
  it("paused: nothing happens; resumed: the machine goes on from there", () => {
    const acts = run(30, (t) => ({ manual: t >= 2000 && t < 15000, want: "child" }));
    expect(acts.every((a) => a.t >= 15000)).toBe(true);
    expect(acts[0]).toMatchObject({ type: "go", to: "child" });
  });
  it("the person changes canvas: told once it holds for two ticks", () => {
    const acts = run(6, (t) => ({ cur: t >= 2000 ? "other" : "home", want: "home", working: false }));
    expect(acts).toEqual([{ t: 2200, type: "user-moved", to: "other" }]);
  });
  it("a canvas that is slow to mount after the camera's own switch is not the person's doing", () => {
    // the camera goes in at 4 s; the canvas in front of the person is still the old one (or not there) for 5 s
    const acts = run(20, (t) => ({ want: "child", cur: t < 4000 + 5000 ? (t % 400 === 0 ? "home" : null) : "child" }));
    expect(acts.map((a) => a.type)).toEqual(["go"]);
    expect(MOUNT_GRACE_MS).toBeGreaterThan(5000);
  });
  it("a switch in progress: nothing", () => {
    const m = newCanvasMachine();
    expect(canvasStep(m, { ...base, busy: true, want: "child", now: 99999 })).toEqual({ type: "none" });
  });
});

// ── whether the camera has a turn to follow (replayLive.ts feeds it one tick at a time) ──
describe("spellStep: a turn is followed from the moment it begins", () => {
  const OPENED = 100_000;
  const ticks = (f: (t: number) => { working: boolean; lastWorkStart?: number | null; chosen?: boolean }, from: number, to: number) => {
    let s = newSpell();
    const out: [number, boolean][] = [];
    for (let now = from; now <= to; now += 200) {
      const i = f(now);
      s = spellStep(s, { working: i.working, lastWorkStart: i.lastWorkStart ?? null, openedAt: OPENED, now, chosen: !!i.chosen });
      out.push([now, s.followed]);
    }
    return out;
  };
  it("the person sends a message: it is followed at once — before the run has begun a single call (FL2 root cause 1)", () => {
    const at = OPENED + 30_000;
    const r = ticks((t) => ({ working: t >= at, lastWorkStart: 5 }), OPENED + 20_000, OPENED + 40_000);
    expect(r.find(([, f]) => f)![0]).toBe(at);
  });
  it("and keeps following through thinking, the tray and waiting: the turn is what counts, not a call in hand", () => {
    const at = OPENED + 30_000;
    const r = ticks((t) => ({ working: t >= at && t < at + 60_000, lastWorkStart: null }), OPENED + 20_000, OPENED + 100_000);
    expect(r.filter(([t]) => t >= at && t < at + 60_000).every(([, f]) => f)).toBe(true);
    expect(r.filter(([t]) => t >= at + 60_000).every(([, f]) => !f)).toBe(true);
  });
  it("a turn already running when the page opened is not followed until it does something new", () => {
    const r = ticks((t) => ({ working: true, lastWorkStart: t >= OPENED + 4000 ? OPENED + 4000 : 5 }), OPENED, OPENED + 6000);
    expect(r.find(([, f]) => f)![0]).toBe(OPENED + 4000);
  });
  it("a run first seen a long time after the page opened is a new turn (a session that had nothing yet): followed at once", () => {
    const now = OPENED + SPELL_FIRST_SIGHT_MS + 1000;
    expect(spellStep(newSpell(), { working: true, lastWorkStart: null, openedAt: OPENED, now, chosen: false }).followed).toBe(true);
    expect(spellStep(newSpell(), { working: true, lastWorkStart: null, openedAt: OPENED, now: OPENED + 500, chosen: false }).followed).toBe(false);
  });
  it("the person chose this agent: followed while it works", () => {
    expect(spellStep(newSpell(), { working: true, lastWorkStart: null, openedAt: OPENED, now: OPENED + 500, chosen: true }).followed).toBe(true);
  });
});
