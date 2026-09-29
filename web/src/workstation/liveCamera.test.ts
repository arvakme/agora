// The camera follows the main agent by default (web/docs/workstation.md §10 默认跟随): who it follows (a played
// turn first, then the one the person chose, then the main agent — the top-level run of the session the person is
// looking at, else the top-level run most recently at work), when it holds still (the agent is idle), when
// the person's own doing pauses it and what resumes it. Pure.
import { describe, expect, it } from "vitest";
import { followsWhere, nextPaused, pickFollow, whereOf, ENTER_MS, HOME_AFTER_MS, isWorking, lastWorkStart, liveStep, MOUNT_GRACE_MS, newLiveMachine, type LiveIn, type Top } from "./liveCamera.ts";

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

// ── the camera only follows work on the diagram, and goes home when it is done (§10 默认跟随) ──
const OUT = "\u0000outside";
const st = (o: Partial<Parameters<typeof whereOf>[0]> = {}) => ({ present: true, at: "n1", trip: null, w: 1, seg: { path: "a.go" }, ...o });

describe("whereOf / followsWhere: does the camera push in?", () => {
  it("on a node: yes", () => {
    expect(whereOf(st(), OUT, true)).toBe("node");
    expect(followsWhere("node")).toBe(true);
  });
  it("on the way (a trip in progress): yes", () => {
    expect(whereOf(st({ trip: {}, w: 0.4 }), OUT, true)).toBe("route");
    expect(followsWhere("route")).toBe(true);
  });
  it("going through a door of a sub-diagram: yes", () => {
    expect(whereOf(st({ present: false, portalPhase: "behind" }), OUT, true)).toBe("node");
    expect(whereOf(st({ portalPhase: "in" }), OUT, true)).toBe("node");
  });
  it("in the tray outside the diagram: no", () => {
    expect(whereOf(st({ at: OUT }), OUT, true)).toBe("tray");
    expect(followsWhere("tray")).toBe(false);
  });
  it("thinking on a node with no file in hand: the camera does not move (frame level) — it is neither a reason to go home nor to go in (see liveStep)", () => {
    expect(whereOf(st({ seg: null }), OUT, true)).toBe("think");
    expect(whereOf(st({ seg: {} }), OUT, true)).toBe("think");
    expect(followsWhere("think")).toBe(false);
  });
  it("idle (the run is not at work): no", () => {
    expect(whereOf(st(), OUT, false)).toBe("idle");
    expect(followsWhere("idle")).toBe(false);
  });
});

describe("isWorking / lastWorkStart: one standard for the strip and the camera", () => {
  const run = (running: boolean, segs: [number, number][]) => ({ running, segs: segs.map(([start, end]) => ({ start, end })) });
  it("the turn is running: working, whatever the calls", () => expect(isWorking(run(true, []), 10)).toBe(true));
  it("a call in progress: working", () => expect(isWorking(run(false, [[5, 20]]), 10)).toBe(true));
  it("turn over, no call in progress: idle", () => expect(isWorking(run(false, [[5, 8]]), 10)).toBe(false));
  it("the latest call's start", () => {
    expect(lastWorkStart(run(false, [[5, 8], [12, 15]]), 10)).toBe(5);
    expect(lastWorkStart(run(false, []), 10)).toBeNull();
  });
});

// ── the live camera's state machine, fed a time series ──
describe("liveStep: the camera's decisions over time", () => {
  const base: LiveIn = { now: 0, working: true, lastWorkStart: 1000, openedAt: 0, want: "home", shown: "home", home: "home", cur: "home", busy: false, manual: false, displaced: false };
  /** Feeds one tick per `dt` ms; `f(t)` gives that tick's changes; returns the actions that were not "none", with their times. */
  const run = (seconds: number, f: (t: number) => Partial<LiveIn>, dt = 200) => {
    const m = newLiveMachine();
    const acts: { t: number; type: string; to?: string }[] = [];
    const cur = { ...base };
    for (let t = 0; t <= seconds * 1000; t += dt) {
      Object.assign(cur, { now: t }, f(t));
      const a = liveStep(m, { ...cur });
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
    const acts = run(30, (t) => ({ want: t >= 1000 ? "child" : "home", working: true, lastWorkStart: 1000 }));
    expect(acts).toEqual([{ t: 4000, type: "go", to: "child" }]);
  });
  it("several files written in a sub-diagram in a row: one way in, none out until the turn ends", () => {
    const acts = run(40, (t) => ({ want: t >= 1000 && t < 30000 ? "child" : "home", working: t < 30000, lastWorkStart: 1000 + Math.floor(t / 4000) * 4000 }));
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
  it("just opened the page: work that began before it is not followed; work after it is", () => {
    const acts = run(20, (t) => ({ openedAt: 5000, lastWorkStart: t >= 12000 ? 12000 : 1000, want: "child" }));
    expect(acts).toEqual([{ t: 15000, type: "go", to: "child" }]);
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
    const m = newLiveMachine();
    expect(liveStep(m, { ...base, busy: true, want: "child", now: 99999 })).toEqual({ type: "none" });
  });
});
