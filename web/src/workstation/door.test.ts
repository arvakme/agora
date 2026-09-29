// 进出子图 (./place.ts stateAt with `ctx.door`; web/docs/workstation.md §评论联动与进出子图): a worker whose
// file lies in a node's sub-diagram walks to that node and goes in — shrinking and fading at the node's top
// edge over DOOR_MS — and is not on this canvas while it works in there; it comes back out the same way
// before it walks on. On the sub-diagram's own canvas it comes in by the entrance (the node nearest the top
// left) and walks to its node, and leaves the same way. Before its first file a worker is where that file
// is. Still a pure function of the log and t; without `ctx.door` nothing changes.
import { describe, expect, it } from "vitest";
import { DOOR_MS, DOOR_SCALE, HANDOFF_MS, OUTSIDE, stateAt, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";
import { entranceOf } from "./scenePlaces.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string, x: Partial<RunSeg> = {}): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}), ...x });
const run = (segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id: "r", agent: "pi", name: "Pi", segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
// 2026-09-29 用户决定调慢走路: the docks were 400 px apart (a walk took ≤ 2.4 s at any distance); at the walking pace that is
// over 3 s, longer than the segments here, so they are a quarter as far apart (the walks still take 1–2 s).
const DOCK: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 100, y: -38 }, redis: { x: 100, y: 38 }, app: { x: 0, y: 0 }, users: { x: 75, y: 50 }, [OUTSIDE]: { x: 50, y: 100 } };
// The main canvas: API 服务 opens a sub-diagram (c-api) that has server/app.py and server/users.py.
const main = (runs: WorkRun[], x: Partial<Ctx> = {}): Ctx => ({
  locate: (p) =>
    p === "server/app.py"
      ? { place: "api", portal: { canvasId: "c-api", label: "应用入口" } }
      : p === "server/users.py"
        ? { place: "api", portal: { canvasId: "c-api", label: "用户模块" } }
        : p.startsWith("server/db/")
          ? { place: "db" }
          : p.startsWith("server/")
            ? { place: "api" }
            : null,
  dock: (p) => DOCK[p] ?? DOCK[OUTSIDE],
  anchor: (ids) => (ids[0] === "redis" ? { place: "redis" } : null),
  door: {},
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
  ...x,
});
// The sub-diagram's canvas: 应用入口 (app, its entrance) and 用户模块 (users); nothing else is on it.
const sub = (runs: WorkRun[], x: Partial<Ctx> = {}): Ctx => ({
  locate: (p) => (p === "server/app.py" ? { place: "app" } : p === "server/users.py" ? { place: "users" } : null),
  dock: (p) => DOCK[p] ?? DOCK[OUTSIDE],
  anchor: () => null,
  door: { entrance: "app" },
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
  ...x,
});

// Pi reads the database (MySQL, on the main canvas), writes server/users.py (in API 服务's sub-diagram),
// thinks there, and reads the database again.
const PI = run([seg("think", 0, 2), seg("read", 2, 5, "server/db/models.py"), seg("write", 5, 10, "server/users.py"), seg("think", 10, 11), seg("read", 11, 14, "server/db/x.py")]);

describe("going into a node's sub-diagram (the main canvas)", () => {
  it("walks to the node, then goes in — shrinking and fading at its top edge over DOOR_MS — and is then not on this canvas", () => {
    const c = main([PI]);
    const walking = stateAt(PI, 5.1 * S, c);
    expect(walking).toMatchObject({ present: true, at: "api", from: "db", pose: "walk", fade: 1 });
    expect(walking.portalPhase).toBeUndefined();
    const arrive = walking.trip!.t1;
    const going = stateAt(PI, arrive + DOOR_MS / 4, c);
    expect(going).toMatchObject({ present: true, at: "api", pose: "write", portalPhase: "in" });
    expect(going.fade).toBeCloseTo(0.75, 5);
    expect(going.portalScale).toBeGreaterThan(DOOR_SCALE);
    expect(going.portalScale).toBeLessThan(1);
    expect(stateAt(PI, arrive + DOOR_MS + 1, c)).toMatchObject({ present: false, at: "api", portalPhase: "behind", portal: { canvasId: "c-api", label: "用户模块" } });
    // thinking in there: still in there
    expect(stateAt(PI, 10.5 * S, c)).toMatchObject({ present: false, portalPhase: "behind" });
  });

  it("comes back out the same way at the node, and only then sets off", () => {
    const c = main([PI]);
    const out = stateAt(PI, 11 * S + DOOR_MS / 4, c);
    expect(out).toMatchObject({ present: true, at: "api", pose: "read", portalPhase: "out" });
    expect(out.fade).toBeCloseTo(0.25, 5);
    expect(out.portalScale).toBeGreaterThan(DOOR_SCALE);
    expect(out.portalScale).toBeLessThan(1);
    const walk = stateAt(PI, 11 * S + DOOR_MS + 100, c);
    expect(walk).toMatchObject({ present: true, at: "db", from: "api", pose: "walk", fade: 1 });
    expect(walk.trip!.t0).toBe(11 * S + DOOR_MS);
    expect(walk.portalPhase).toBeUndefined();
    expect(walk.portalScale ?? 1).toBe(1);
  });

  it("before its first file a worker is where that file is: a stretch that starts in a sub-diagram starts in there", () => {
    const r = run([seg("think", 0, 2), seg("read", 2, 5, "server/app.py"), seg("read", 5, 8, "server/db/a.py")]);
    const c = main([r]);
    expect(stateAt(r, 1 * S, c)).toMatchObject({ present: false, at: "api", portalPhase: "behind" });
    expect(stateAt(r, 3 * S, c)).toMatchObject({ present: false, portalPhase: "behind", portal: { label: "应用入口" } });
    expect(stateAt(r, 5 * S + DOOR_MS / 2, c)).toMatchObject({ present: true, at: "api", portalPhase: "out" });
  });

  it("a comment on the main canvas brings it out and over to the comment", () => {
    const c3 = { n: 3, anchor: ["redis"] };
    const r = run([seg("write", 0, 4, "server/users.py"), seg("think", 5, 9, undefined, { comment: c3 })]);
    const c = main([r]);
    expect(stateAt(r, 2 * S, c)).toMatchObject({ present: false, portalPhase: "behind" });
    expect(stateAt(r, 5 * S + DOOR_MS / 2, c)).toMatchObject({ present: true, at: "api", portalPhase: "out", comment: { n: 3 } });
    expect(stateAt(r, 5 * S + DOOR_MS + 50, c)).toMatchObject({ present: true, at: "redis", from: "api", pose: "walk" });
  });

  it("without doors it stands on the node, its bubble naming the sub-diagram (as before)", () => {
    const s = stateAt(PI, 8 * S, main([PI], { door: undefined }));
    expect(s).toMatchObject({ present: true, at: "api", pose: "write", fade: 1, portal: { canvasId: "c-api", label: "用户模块" } });
    expect(s.portalPhase).toBeUndefined();
  });

  it("reduced motion: no walk; the door fades without the shrinking", () => {
    const c = main([PI], { reduced: true });
    const going = stateAt(PI, 5 * S + DOOR_MS / 2, c);
    expect(going).toMatchObject({ present: true, at: "api", portalPhase: "in", trip: null });
    expect(going.fade).toBeCloseTo(0.5, 5);
    expect(going.portalScale ?? 1).toBe(1);
    expect(stateAt(PI, 5 * S + DOOR_MS + 1, c).present).toBe(false);
    const out = stateAt(PI, 11 * S + DOOR_MS / 2, c);
    expect(out).toMatchObject({ present: true, portalPhase: "out" });
    expect(out.portalScale ?? 1).toBe(1);
  });
});

describe("on the sub-diagram's own canvas", () => {
  it("comes in by the entrance — appearing and growing there — then walks to its node", () => {
    const c = sub([PI]);
    // reading the database, up on the main canvas
    expect(stateAt(PI, 3 * S, c)).toMatchObject({ present: false, at: "app", portalPhase: "behind" });
    const coming = stateAt(PI, 5 * S + DOOR_MS / 4, c);
    expect(coming).toMatchObject({ present: true, at: "app", portalPhase: "out", trip: null });
    expect(coming.fade).toBeCloseTo(0.25, 5);
    const w = stateAt(PI, 5 * S + DOOR_MS + 100, c);
    expect(w).toMatchObject({ present: true, at: "users", from: "app", pose: "walk" });
    expect(w.trip!.t0).toBe(5 * S + DOOR_MS);
    expect(stateAt(PI, w.trip!.t1 + 1, c)).toMatchObject({ at: "users", pose: "write", w: 1 });
  });

  it("leaves by the entrance: walks there and goes in", () => {
    const c = sub([PI]);
    const w = stateAt(PI, 11.1 * S, c);
    expect(w).toMatchObject({ present: true, at: "app", from: "users", pose: "walk" });
    expect(w.portalPhase).toBeUndefined();
    const arrive = w.trip!.t1;
    expect(stateAt(PI, arrive + DOOR_MS / 2, c)).toMatchObject({ present: true, at: "app", portalPhase: "in" });
    expect(stateAt(PI, arrive + DOOR_MS + 1, c)).toMatchObject({ present: false, portalPhase: "behind" });
  });

  it("the entrance is the node nearest the top left of the sub-diagram", () => {
    const box = (x: number, y: number) => ({ x, y, w: 170, h: 64 });
    expect(entranceOf(new Map([["api-routes", box(330, 120)], ["api-users", box(330, 330)], ["api-app", box(60, 120)], ["api-auth", box(620, 330)]]))).toBe("api-app");
    expect(entranceOf(new Map([["b", box(-200, 40)], ["a", box(-180, -300)]]))).toBe("a");
    expect(entranceOf(new Map())).toBeUndefined();
  });
});

describe("sub-agents and doors", () => {
  // Pi works in API 服务's sub-diagram and sends a sub-agent from there; it reads the database and reports back.
  const pi = run([seg("write", 0, 2, "server/users.py"), seg("delegate", 2, 3), seg("think", 3, 20)], { id: "pi" });
  const kid = run([seg("read", 4, 7, "server/db/x.py")], { id: "kid", parentId: "pi", spawnAt: 2.5 * S, doneAt: 8 * S });

  it("one sent from in there starts in there, and comes out to its own file", () => {
    const c = main([pi, kid]);
    expect(stateAt(kid, 3 * S, c)).toMatchObject({ present: false, at: "api", portalPhase: "behind" });
    expect(stateAt(kid, 4 * S + DOOR_MS / 2, c)).toMatchObject({ present: true, at: "api", portalPhase: "out" });
    expect(stateAt(kid, 4 * S + DOOR_MS + 50, c)).toMatchObject({ present: true, at: "db", pose: "walk" });
  });

  it("reporting back to a dispatcher in there, it walks to the node and goes in instead of handing over in view", () => {
    const c = main([pi, kid]);
    const back = stateAt(kid, 8.1 * S, c);
    expect(back).toMatchObject({ present: true, at: "api", from: "db", pose: "walk", handoff: false });
    const arrive = back.trip!.t1;
    expect(stateAt(kid, arrive + DOOR_MS / 2, c)).toMatchObject({ present: true, portalPhase: "in", handoff: false });
    expect(stateAt(kid, arrive + DOOR_MS + 1, c).present).toBe(false);
    expect(stateAt(kid, arrive + HANDOFF_MS / 2, c).handoff).toBe(false);
  });

  it("on the sub-diagram's canvas it comes back in by the entrance and hands over in view, as usual", () => {
    const c = sub([pi, kid]);
    // it read the database (up on the main canvas): it went out by the entrance
    expect(stateAt(kid, 7.5 * S, c)).toMatchObject({ present: false, at: "app", portalPhase: "behind" });
    expect(stateAt(kid, 8 * S + DOOR_MS / 4, c)).toMatchObject({ present: true, at: "app", portalPhase: "out", handoff: false });
    const back = stateAt(kid, 8 * S + DOOR_MS + 50, c);
    expect(back).toMatchObject({ present: true, at: "users", from: "app", pose: "walk", handoff: false });
    expect(stateAt(kid, back.trip!.t1 + 10, c)).toMatchObject({ present: true, handoff: true, pose: "handoff" });
  });
});

describe("doors are a pure function of the log and t", () => {
  it("jumping to a time and stepping there agree, on either canvas", () => {
    for (const mk of [main, sub]) {
      const c = mk([PI]);
      for (const t of [1, 2.2, 5.1, 5.35, 6.9, 8, 10.5, 11.1, 11.3, 11.45, 12.5, 15].map((x) => x * S)) {
        let stepped = stateAt(PI, 0, c);
        for (let u = 0; u <= t; u += 50) stepped = stateAt(PI, u, c);
        expect(stateAt(PI, t, mk([PI]))).toEqual(stateAt(PI, t, c));
        if (t % 50 === 0) expect(stepped).toEqual(stateAt(PI, t, c));
      }
    }
  });
});
