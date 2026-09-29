// The camera follows the main agent by default (web/docs/workstation.md §10 默认跟随): who it follows (a played
// turn first, then a traced agent, then the main agent — the top-level run of the session the person is
// looking at, else the top-level run most recently at work), when it holds still (the agent is idle), when
// the person's own doing pauses it and what resumes it, and whether the follow tab should still open for
// an agent the camera is already following. Pure.
import { describe, expect, it } from "vitest";
import { followsWhere, mayOpenFollowTab, nextPaused, pickFollow, whereOf, goHomeDue, HOME_AFTER_MS, type Top } from "./liveCamera.ts";

const top = (id: string, o: Partial<Top> = {}): Top => ({ id, sessionId: `s-${id}`, working: false, lastWorkAt: 0, ...o });
const base = { on: true, playing: null, traced: null, focusedSession: null, tops: [] as Top[] };

describe("pickFollow: whom the camera follows", () => {
  it("nobody when the switch is off (the canvas does not move) — except for a played turn, which the person asked for", () => {
    expect(pickFollow({ ...base, on: false, tops: [top("a", { working: true })] })).toBeNull();
    expect(pickFollow({ ...base, on: false, playing: "a", tops: [top("a")] })).toEqual({ run: "a", why: "play" });
  });
  it("a played turn beats a traced agent beats the main agent", () => {
    const tops = [top("a", { working: true }), top("b", { working: true })];
    expect(pickFollow({ ...base, tops, playing: "b", traced: "a" })).toEqual({ run: "b", why: "play" });
    expect(pickFollow({ ...base, tops, traced: "b" })).toEqual({ run: "b", why: "trace" });
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
  it("a traced sub-agent is followed as well (the traced one, whoever it is)", () => {
    expect(pickFollow({ ...base, tops: [top("a", { working: true })], traced: "kid" })).toEqual({ run: "kid", why: "trace" });
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

describe("mayOpenFollowTab: the follow tab for an agent the camera already follows is not needed", () => {
  const cam = { on: true, paused: false, run: "main" };
  it("not for the main agent while the camera follows it", () => {
    expect(mayOpenFollowTab("main", true, cam)).toBe(false);
  });
  it("for a sub-agent, as before", () => {
    expect(mayOpenFollowTab("kid", false, cam)).toBe(true);
    expect(mayOpenFollowTab("kid", false, { ...cam, run: "kid" })).toBe(true);
  });
  it("for the main agent once the camera is paused or switched off, as before", () => {
    expect(mayOpenFollowTab("main", true, { ...cam, paused: true })).toBe(true);
    expect(mayOpenFollowTab("main", true, { ...cam, on: false })).toBe(true);
  });
  it("for another top-level agent than the one followed", () => {
    expect(mayOpenFollowTab("other", true, cam)).toBe(true);
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
  it("thinking on a node with no file in hand (a reply that touches nothing): no", () => {
    expect(whereOf(st({ seg: null }), OUT, true)).toBe("think");
    expect(whereOf(st({ seg: {} }), OUT, true)).toBe("think");
    expect(followsWhere("think")).toBe(false);
  });
  it("idle (the run is not at work): no", () => {
    expect(whereOf(st(), OUT, false)).toBe("idle");
    expect(followsWhere("idle")).toBe(false);
  });
});

describe("goHomeDue: when the camera goes back to the view it started from", () => {
  const base = { holdFor: HOME_AFTER_MS, paused: false, displaced: true };
  it("about 3 s after the work on the diagram stopped", () => {
    expect(HOME_AFTER_MS).toBe(3000);
    expect(goHomeDue(base)).toBe(true);
    expect(goHomeDue({ ...base, holdFor: HOME_AFTER_MS - 1 })).toBe(false);
  });
  it("not while it is still at work (no hold)", () => {
    expect(goHomeDue({ ...base, holdFor: null })).toBe(false);
  });
  it("not when you paused or took it over: your view is yours", () => {
    expect(goHomeDue({ ...base, paused: true })).toBe(false);
  });
  it("nothing to go back from when it never moved", () => {
    expect(goHomeDue({ ...base, displaced: false })).toBe(false);
  });
});
