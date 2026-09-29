// One canvas, one camera, one agent followed at a time (workstation/followChoice.ts, liveCamera.ts `pickFollow`): the person's
// choice (a bubble's 「跟随」, the avatar on a sub-diagram's entrance) beats the default, choosing another drops the first, and
// the one status line above the canvas says three things only.
import { describe, expect, it } from "vitest";
import { choose, chosenRun, followStatus, NONE } from "./followChoice.ts";
import { pickFollow, type Top } from "./liveCamera.ts";

const top = (id: string, o: Partial<Top> = {}): Top => ({ id, sessionId: `s-${id}`, working: false, lastWorkAt: 0, ...o });
const base = { on: true, playing: null, chosen: null, focusedSession: null, tops: [] as Top[] };
const exists = () => true;

describe("whom the camera follows: exactly one", () => {
  it("the agent of the session the person is talking to, by default", () => {
    const tops = [top("a", { working: true }), top("b")];
    expect(pickFollow({ ...base, tops, focusedSession: "s-b" })).toEqual({ run: "b", why: "main" });
  });
  it("a choice (「跟随」 in a bubble, the avatar on an entrance) beats the default", () => {
    const tops = [top("a", { working: true }), top("b")];
    expect(pickFollow({ ...base, tops, focusedSession: "s-a", chosen: "kid" })).toEqual({ run: "kid", why: "chosen" });
  });
  it("choosing someone else drops the first: only the latest choice is followed", () => {
    let c = choose(NONE, "a", "s-x");
    c = choose(c, "b", "s-x");
    expect(chosenRun(c, { focusedSession: "s-x", exists })).toBe("b");
    expect(pickFollow({ ...base, tops: [top("a", { working: true })], chosen: chosenRun(c, { focusedSession: "s-x", exists }) })).toEqual({ run: "b", why: "chosen" });
  });
  it("a played turn is still followed first (it was asked for)", () => {
    expect(pickFollow({ ...base, playing: "p", chosen: "b", tops: [top("b")] })).toEqual({ run: "p", why: "play" });
  });
  it("the switch 「镜头跟随」 off: nothing is followed but a played turn, a choice included", () => {
    expect(pickFollow({ ...base, on: false, chosen: "b", tops: [top("b")] })).toBeNull();
  });
  it("a choice is forgotten when the person turns to another session, or the run is gone", () => {
    const c = choose(NONE, "b", "s-a");
    expect(chosenRun(c, { focusedSession: "s-a", exists })).toBe("b");
    expect(chosenRun(c, { focusedSession: "s-other", exists })).toBeNull();
    expect(chosenRun(c, { focusedSession: "s-a", exists: () => false })).toBeNull();
  });
});

describe("the one status above the canvas", () => {
  const o = { name: "Devin", paused: false, working: true, drawn: true };
  it("following: 「跟着 Devin」, nothing to press", () => {
    expect(followStatus(o)).toEqual({ text: "跟着 Devin", resume: false });
  });
  it("after the person moved the canvas: 「跟着 Devin · 已暂停」 and 「继续」", () => {
    expect(followStatus({ ...o, paused: true })).toEqual({ text: "跟着 Devin · 已暂停", resume: true });
  });
  it("idle or gone, or not to be seen on this canvas: nothing at all", () => {
    expect(followStatus({ ...o, working: false })).toBeNull();
    expect(followStatus({ ...o, paused: true, working: false })).toBeNull();
    expect(followStatus({ ...o, drawn: false })).toBeNull();
  });
});
