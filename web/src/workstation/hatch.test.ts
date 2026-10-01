// 父图上「在下面」的样子 (./hatch.ts; web/docs/workstation.md §10 父图入口): while an agent is in a node's sub-diagram, that node's
// top edge keeps the hole it went down through — the ladder's upper end shows, and one head looks out of it: the traced one's,
// else the followed one's, else the one that went in last. Which hatch is drawn, whose head, and when it rises and ducks:
// all a pure function of the runs and t.
import { describe, expect, it } from "vitest";
import { DOOR_MS } from "./place.ts";
import { doorClimb, HATCH_IN_MS, HATCH_OUT_MS, hatchesAt, hatchVisAt, hatchVisSoon, holeVisAt, PEEK_MS, peekerOf, peekRise, SINK_MS } from "./hatch.ts";
import { enterAfter, stateAt, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const run = (id: string, segs: RunSeg[]): WorkRun => ({ id, agent: "pi", name: id, segs, receipts: [], running: false, lastAt: 0, children: [] });
const DOCK: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 100, y: -38 }, app: { x: 0, y: 0 }, users: { x: 75, y: 50 } };
const main = (runs: WorkRun[], x: Partial<Ctx> = {}): Ctx => ({
  locate: (p) => (p === "server/users.py" ? { place: "api", portal: { canvasId: "c-api", label: "用户模块" } } : p.startsWith("server/db/") ? { place: "db" } : null),
  dock: (p) => DOCK[p],
  door: {},
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
  ...x,
});
const sub = (runs: WorkRun[], outer: Ctx): Ctx => ({ locate: (p) => (p === "server/users.py" ? { place: "users" } : null), dock: (p) => DOCK[p], door: { entrance: "app", enter: enterAfter(() => outer) }, reduced: false, run: (id) => runs.find((r) => r.id === id) });

// A goes into API 服务's sub-diagram at 5 s and stays; B goes in at 9 s and stays.
const A = run("a", [seg("read", 0, 2, "server/db/m.py"), seg("write", 5, 30, "server/users.py")]);
const B = run("b", [seg("read", 0, 2, "server/db/m.py"), seg("write", 9, 30, "server/users.py")]);
const view = (c: Ctx, runs: WorkRun[], t: number, o: { traced?: string | null; followed?: string | null } = {}) => hatchesAt(runs.map((r) => r.id), (id, u) => stateAt(runs.find((r) => r.id === id)!, u, c), t, o);
const behindAt = (r: WorkRun, c: Ctx) => stateAt(r, 40 * S, c).doorsIn[0] + DOOR_MS;

describe("who looks out of the hole", () => {
  it("the traced one, else the followed one, else the one that went in last", () => {
    const cands = [{ id: "a", since: 6000 }, { id: "b", since: 9500 }];
    expect(peekerOf(cands, {})).toBe("b");
    expect(peekerOf(cands, { followed: "a" })).toBe("a");
    expect(peekerOf(cands, { followed: "a", traced: "b" })).toBe("b");
    expect(peekerOf(cands, { traced: "zzz", followed: "zzz" })).toBe("b"); // not below: no say
    expect(peekerOf([], { traced: "a" })).toBeNull();
  });

  it("two agents below the same node: one hole, one head — the trace's, whichever went in last otherwise", () => {
    const runs = [A, B];
    const c = main(runs);
    const t = 20 * S;
    expect(view(c, runs, t).hatches).toEqual([{ place: "api", side: "below", ids: ["a", "b"] }]);
    expect(view(c, runs, t).peeks).toEqual([{ place: "api", id: "b" }]);
    expect(view(c, runs, t, { traced: "a" }).peeks).toEqual([{ place: "api", id: "a" }]);
    expect(view(c, runs, t, { followed: "a" }).peeks).toEqual([{ place: "api", id: "a" }]);
  });
});

describe("when the hatch is there and when the head shows", () => {
  const runs = [A];
  const c = main(runs);
  const behind = behindAt(A, c);

  it("nothing until the agent is about to go in; the ladder is there before it starts down", () => {
    expect(view(c, runs, 1 * S).hatches).toEqual([]);
    const inAt = stateAt(A, 40 * S, c).doorsIn[0];
    expect(view(c, runs, inAt - 100).hatches).toEqual([{ place: "api", side: "below", ids: ["a"] }]);
    expect(view(c, runs, inAt - 100).peeks).toEqual([]); // not down there yet
  });

  it("all the way down it stays as long as it is in there: the hole and its head — and no ladder standing on the head while it only rests (FX7)", () => {
    for (const t of [behind + 1, behind + 5 * S, 25 * S]) {
      expect(view(c, runs, t).hatches).toEqual([{ place: "api", side: "below", ids: ["a"] }]);
      expect(view(c, runs, t).peeks).toEqual([{ place: "api", id: "a" }]);
      expect(holeVisAt(stateAt(A, t, c), "api", "below")).toBe(1);
    }
    for (const t of [behind + HATCH_OUT_MS + 100, behind + 5 * S, 25 * S]) expect(hatchVisAt(stateAt(A, t, c), "api", "below", t)).toBe(0);
  });

  it("the ladder is there when it is on it: as it goes down, and a moment before it starts up (not for the whole rest in between)", () => {
    const r = run("c", [seg("read", 0, 2, "server/db/m.py"), seg("write", 5, 10, "server/users.py"), seg("read", 20, 30, "server/db/x.py")]);
    const cc = main([r]);
    const st = (t: number) => stateAt(r, t, cc);
    const outAt = st(20 * S + 1).doors.find((d) => !d.into)!.t;
    expect(hatchVisAt(st(15 * S), "api", "below", 15 * S)).toBe(0); // resting in there
    expect(hatchVisAt(st(outAt - HATCH_IN_MS - 50), "api", "below", outAt - HATCH_IN_MS - 50)).toBe(0);
    const soon = (t: number) => hatchVisSoon(st(t), st(t + HATCH_IN_MS), "api", "below", t);
    expect(soon(15 * S)).toBe(0);
    expect(soon(outAt - HATCH_IN_MS - 50)).toBe(0);
    expect(soon(outAt - HATCH_IN_MS / 2)).toBeGreaterThan(0.3);
    expect(hatchVisAt(st(outAt + DOOR_MS / 2), "api", "below", outAt + DOOR_MS / 2)).toBe(1);
    const inAt = st(15 * S).doorsIn[0];
    expect(hatchVisAt(st(inAt + DOOR_MS / 2), "api", "below", inAt + DOOR_MS / 2)).toBe(1);
  });

  it("the head rises once it is all the way down (from hidden to showing over PEEK_MS), and ducks as it comes out", () => {
    const st = (t: number) => stateAt(A, t, c);
    expect(peekRise(st(behind + 1), false)).toBeLessThan(0.05);
    expect(peekRise(st(behind + PEEK_MS / 2), false)).toBeGreaterThan(0.2);
    expect(peekRise(st(behind + PEEK_MS / 2), false)).toBeLessThan(0.9);
    expect(peekRise(st(behind + PEEK_MS + 1), false)).toBe(1);
    // no head while it goes in
    const inAt = st(40 * S).doorsIn[0];
    expect(peekRise(st(inAt + DOOR_MS / 2), false)).toBe(0);
  });

  it("through the door and out again: the ladder is drawn a little after it is up, then gone", () => {
    const r = run("c", [seg("write", 0, 10, "server/users.py"), seg("read", 10, 20, "server/db/x.py")]);
    const cc = main([r]);
    const outAt = stateAt(r, 10 * S + 1, cc).doors.find((d) => !d.into)!.t;
    expect(view(cc, [r], outAt + DOOR_MS / 2).hatches.length).toBe(1);
    expect(view(cc, [r], outAt + DOOR_MS / 2).peeks).toEqual([]); // it is coming out: no head, the figure itself climbs
    expect(view(cc, [r], outAt + DOOR_MS + HATCH_OUT_MS / 2).hatches.length).toBe(1);
    expect(view(cc, [r], outAt + DOOR_MS + HATCH_OUT_MS + 600).hatches).toEqual([]);
  });

  it("the head is continuous through the moment it starts to come out: it ducks from where it was, however long it looked out", () => {
    const r = run("c", [seg("write", 0, 10, "server/users.py"), seg("read", 10.1, 20, "server/db/x.py")]);
    const cc = main([r]);
    const outAt = stateAt(r, 11 * S, cc).doors.find((d) => !d.into)!.t;
    const st = (t: number) => stateAt(r, t, cc);
    const before = peekRise(st(outAt - 1), false);
    const after = peekRise(st(outAt + 1), false);
    expect(Math.abs(before - after)).toBeLessThan(0.02);
    expect(peekRise(st(outAt + SINK_MS + 1), false)).toBe(0);
  });

  it("reduced motion: the head is just there or not, no rising, and no ladder is climbed", () => {
    const rc = main([A], { reduced: true });
    const st = (t: number) => stateAt(A, t, rc);
    const inAt = st(40 * S).doorsIn[0];
    expect(peekRise(st(inAt + DOOR_MS + 1), true)).toBe(1);
    expect(peekRise(st(2 * S), true)).toBe(0);
    expect(holeVisAt(st(inAt + DOOR_MS + 1), "api", "below")).toBe(1);
    expect(hatchVisAt(st(inAt + DOOR_MS + 1), "api", "below", inAt + DOOR_MS + 1, true)).toBe(0); // no ladder at all: nothing is climbed
    expect(hatchVisAt(st(inAt + DOOR_MS / 2), "api", "below", inAt + DOOR_MS / 2, true)).toBe(0);
  });

  it("an agent that has left the canvas (idle for over a minute) is no longer in the hole", () => {
    const r = run("d", [seg("write", 0, 2, "server/users.py")]);
    const cc = main([r]);
    expect(view(cc, [r], 30 * S).peeks).toEqual([{ place: "api", id: "d" }]);
    expect(view(cc, [r], 200 * S).peeks).toEqual([]);
    // unless its route is on the canvas: then it stays where it finished, and so does its head
    expect(view(main([r], { stay: new Set(["d"]) }), [r], 200 * S, { traced: "d" }).peeks).toEqual([{ place: "api", id: "d" }]);
  });
});

describe("which climb a state is drawn on", () => {
  const c = main([A]);
  const inAt = stateAt(A, 40 * S, c).doorsIn[0];
  it("going in on the parent canvas: the ladder goes down, and the figure leaves; nothing else is on a ladder", () => {
    expect(doorClimb(stateAt(A, inAt + 100, c), false)).toEqual({ dir: 1, leaving: true, t: 100 });
    expect(doorClimb(stateAt(A, inAt - 100, c), false)).toBeNull(); // still walking
    expect(doorClimb(stateAt(A, inAt + DOOR_MS + 100, c), false)).toBeNull(); // in there
  });
  it("on the sub-diagram's canvas: coming in, the ladder goes up from the floor", () => {
    const outer = main([A]);
    const behind = inAt + DOOR_MS;
    const c = doorClimb(stateAt(A, behind + 50, sub([A], outer)), false);
    expect(c).toMatchObject({ dir: -1, leaving: false });
    expect(c!.t).toBeCloseTo(50, 6);
  });
  it("reduced motion has no ladder", () => {
    const rc = main([A], { reduced: true });
    expect(doorClimb(stateAt(A, stateAt(A, 40 * S, rc).doorsIn[0] + 100, rc), true)).toBeNull();
  });
});

describe("on the sub-diagram's own canvas", () => {
  it("the ladder hangs at the entrance while someone comes down it, and no head looks out of anything", () => {
    const runs = [A];
    const outer = main(runs);
    const c = sub(runs, outer);
    const behind = behindAt(A, outer);
    expect(view(c, runs, 2 * S).hatches).toEqual([]);
    const v = view(c, runs, behind + DOOR_MS / 2);
    expect(v.hatches).toEqual([{ place: "app", side: "above", ids: ["a"] }]);
    expect(v.peeks).toEqual([]);
    expect(view(c, runs, behind + DOOR_MS + HATCH_OUT_MS + 600).hatches).toEqual([]);
  });
});
