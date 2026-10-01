// 两边同一时刻 at the entrance itself (./place.ts `step`; web/docs/workstation.md §评论联动与进出子图): when the work it comes back to
// is at the very node it went in by (a file of the entrance itself), the sub-diagram's canvas must still wait until the worker has
// walked to the door on the canvas outside and gone down it — it may not show it there while the main canvas still has it walking.
// (The other sync tests are ./doorsync.test.ts; there the work lies at another node of the sub-diagram.)
import { describe, expect, it } from "vitest";
import { DOOR_MS, enterAfter, leaveAfter, stateAt, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const PI: WorkRun = {
  id: "r",
  agent: "pi",
  name: "Pi",
  // in the sub-diagram from the start (server/app.py is the entrance), out to the database, back to the entrance's own file
  segs: [seg("write", 0, 2, "server/app.py"), seg("read", 3, 6, "server/db/m.py"), seg("write", 8, 14, "server/app.py"), seg("read", 20, 24, "server/db/x.py")],
  receipts: [],
  running: false,
  lastAt: 0,
  children: [],
};
const MAIN_DOCK: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 350, y: 0 } }; // (POL3: a door takes 1.3 s now, so the docks are half as far apart as they were: the walks still fit between the segments)
const SUB_DOCK: Record<string, { x: number; y: number }> = { app: { x: 0, y: 0 }, users: { x: 150, y: 0 } };
const main: Ctx = {
  locate: (p) => (p === "server/app.py" || p === "server/users.py" ? { place: "api", portal: { canvasId: "c-api", label: "应用入口" } } : p.startsWith("server/db/") ? { place: "db" } : null),
  dock: (p) => MAIN_DOCK[p],
  door: { leave: leaveAfter((id) => (id === "c-api" ? sub : undefined)) },
  reduced: false,
  run: () => PI,
};
const sub: Ctx = {
  locate: (p) => (p === "server/app.py" ? { place: "app" } : p === "server/users.py" ? { place: "users" } : null),
  dock: (p) => SUB_DOCK[p],
  door: { entrance: "app", enter: enterAfter(() => main) },
  reduced: false,
  run: () => PI,
};
const M = (t: number) => stateAt(PI, t, main);
const C = (t: number) => stateAt(PI, t, sub);

describe("coming back to the entrance's own file", () => {
  const walk = M(8.1 * S).trip!; // db → api: over 2 s
  const inAt = M(walk.t1 + 1).doorsIn.find((x) => x >= 8 * S)!;

  it("the main canvas has it walking and going in; the sub-diagram's canvas has nobody until it is through the door", () => {
    expect(inAt).toBe(walk.t1);
    expect(M(inAt - 100)).toMatchObject({ present: true, pose: "walk" });
    expect(M(inAt + DOOR_MS / 2)).toMatchObject({ present: true, portalPhase: "in" });
    for (let t = 8 * S; t < inAt + DOOR_MS; t += 50) expect(C(t).present, `+${t} ms`).toBe(false);
    expect(C(inAt + DOOR_MS + 1)).toMatchObject({ present: true, at: "app", portalPhase: "out" });
  });

  it("never both canvases at once", () => {
    for (let t = 0; t < 26 * S; t += 50) {
      const both = M(t).present && C(t).present;
      expect(both, `both at ${t} ms`).toBe(false);
    }
  });
});

describe("and then on to another node of the sub-diagram", () => {
  it("it sets off only once it is out of the door — not part way along a walk that began while the door was still closed", () => {
    // its work at the entrance itself is over in a moment (8 – 9 s); the next node's begins right after
    const run: WorkRun = { ...PI, segs: [seg("write", 0, 2, "server/app.py"), seg("read", 3, 6, "server/db/m.py"), seg("read", 8, 8.2, "server/app.py"), seg("write", 8.2, 14, "server/users.py")] };
    const M2 = (t: number) => stateAt(run, t, { ...main, run: () => run });
    const C2 = (t: number) => stateAt(run, t, { ...sub, run: () => run });
    const outAt = C2(30 * S).doors.filter((d) => !d.into)[0].t;
    expect(outAt).toBeGreaterThan(M2(9 * S).doorsIn.find((x) => x >= 8 * S)!);
    expect(C2(outAt + DOOR_MS / 2)).toMatchObject({ present: true, at: "app", portalPhase: "out" });
    const walk = C2(outAt + DOOR_MS + 200);
    expect(walk).toMatchObject({ present: true, at: "users", from: "app", pose: "walk" });
    expect(walk.trip!.t0).toBeGreaterThanOrEqual(outAt + DOOR_MS);
  });
});

describe("more work behind the same door while it is still walking to it", () => {
  it("it goes in when it gets there — not when the second piece of work begins", () => {
    // 48 s: sets off for the entrance's node; 51 s (long before it is there): the next file behind the same door
    const run: WorkRun = { ...PI, segs: [seg("read", 0, 2, "server/db/x.py"), seg("read", 2, 5, "server/app.py"), seg("write", 5, 12, "server/users.py")] };
    const far = { ...main, dock: (p: string) => (p === "db" ? { x: 700, y: 0 } : MAIN_DOCK[p]) }; // a long way
    const walk = stateAt(run, 2.1 * S, { ...far, run: () => run }).trip!;
    expect(walk.t1 - walk.t0).toBeGreaterThan(3 * S); // over 3 s: the second piece of work starts (5 s) while it is still on the way
    const st = (t: number) => stateAt(run, t, { ...far, run: () => run });
    expect(walk.t1).toBeGreaterThan(5.4 * S);
    expect(st(5.3 * S).doorsIn).toEqual([walk.t1]);
    expect(st(5.3 * S).pose).toBe("walk");
    expect(st(walk.t1 + DOOR_MS / 2)).toMatchObject({ portalPhase: "in" });
  });
});
