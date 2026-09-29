// 进出子图的两边同一时刻 (./place.ts `door.enter` / `door.leave`; web/docs/workstation.md §评论联动与进出子图):
// the main canvas and the sub-diagram's canvas show the same moment at a door. A worker comes out on the child's
// canvas (by its entrance) only once it is through the door on the main canvas — however long the walk to that door
// takes (2026-09-29 用户决定调慢走路: several seconds) — and shows again on the main canvas only once it is through
// the door at the child's entrance. Each canvas asks the other for its door times; pure, ≤ t data only.
import { describe, expect, it } from "vitest";
import { subviewCtx, presenceAt } from "./subview.ts";
import type { El } from "../canvas/scene";
import type { Scenes } from "../nested/graph";
import { DOOR_MS, enterAfter, leaveAfter, stateAt, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const run = (segs: RunSeg[]): WorkRun => ({ id: "r", agent: "pi", name: "Pi", segs, receipts: [], running: false, lastAt: 0, children: [] });
// MySQL is far from API 服务 on the main canvas (a walk of over 4 s); on the sub-diagram 应用入口 and 用户模块 are close.
const MAIN_DOCK: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 900, y: 0 } };
const SUB_DOCK: Record<string, { x: number; y: number }> = { app: { x: 0, y: 0 }, users: { x: 200, y: 0 } };
const SYNC = !process.env.NO_DOOR_SYNC;
const PI = run([seg("read", 0, 5, "server/db/m.py"), seg("write", 5, 14, "server/users.py"), seg("think", 14, 15), seg("read", 15, 20, "server/db/x.py")]);
const main: Ctx = {
  locate: (p) => (p === "server/users.py" ? { place: "api", portal: { canvasId: "c-api", label: "用户模块" } } : p.startsWith("server/db/") ? { place: "db" } : null),
  dock: (p) => MAIN_DOCK[p],
  door: { ...(SYNC ? { leave: leaveAfter((id) => (id === "c-api" ? sub : undefined)) } : {}) },
  reduced: false,
  run: () => PI,
};
const sub: Ctx = {
  locate: (p) => (p === "server/users.py" ? { place: "users" } : null),
  dock: (p) => SUB_DOCK[p],
  door: { entrance: "app", ...(SYNC ? { enter: enterAfter(() => main) } : {}) },
  reduced: false,
  run: () => PI,
};
const M = (t: number) => stateAt(PI, t, main);
const C = (t: number) => stateAt(PI, t, sub);

describe("both sides of a door show the same moment", () => {
  const walk = M(6 * S).trip!; // db → api, over 4 s
  const inAt = M(walk.t1 + 1).doorsIn[0]; // through the door: it starts going in when the walk ends
  const behindAt = inAt + DOOR_MS;

  it("the walk to the door takes over 4 s; on the main canvas it goes in when it gets there", () => {
    expect(walk.t1 - walk.t0).toBeGreaterThan(4 * S);
    expect(inAt).toBe(walk.t1);
    expect(M(inAt - 50)).toMatchObject({ present: true, pose: "walk" });
    expect(M(inAt + DOOR_MS / 2)).toMatchObject({ present: true, portalPhase: "in" });
    expect(M(behindAt + 1)).toMatchObject({ present: false, portalPhase: "behind" });
  });

  it("the sub-diagram's canvas has it from the moment it is through the door, not from the moment the work started: absent until then", () => {
    for (let t = 5 * S; t < behindAt; t += 100) expect(C(t).present, `+${t} ms`).toBe(false);
    expect(C(behindAt + DOOR_MS / 4)).toMatchObject({ present: true, at: "app", portalPhase: "out", trip: null });
    const w = C(behindAt + DOOR_MS + 100);
    expect(w).toMatchObject({ present: true, at: "users", from: "app", pose: "walk" });
    expect(w.trip!.t0).toBe(behindAt + DOOR_MS);
  });

  it("the other way: it shows on the main canvas again only once it is through the door at the entrance, after walking there", () => {
    const back = C(15.1 * S);
    expect(back).toMatchObject({ present: true, at: "app", from: "users", pose: "walk" });
    const inAtEntrance = back.trip!.t1; // through the door at the entrance
    const gone = inAtEntrance + DOOR_MS;
    expect(inAtEntrance).toBeGreaterThan(15 * S + 500);
    expect(C(gone + 1)).toMatchObject({ present: false, portalPhase: "behind" });
    // on the main canvas: still in there until then
    for (let t = 15 * S; t < gone; t += 100) expect(M(t).present, `+${t} ms`).toBe(false);
    expect(M(gone + DOOR_MS / 4)).toMatchObject({ present: true, at: "api", portalPhase: "out" });
    expect(M(gone + DOOR_MS + 100)).toMatchObject({ present: true, at: "db", from: "api", pose: "walk" });
  });

  it("never on both canvases at once, and pure: the same t gives the same answer, in any order of asking", () => {
    const ts = [4, 8, behindAt / S + 0.1, 12, 15.2, 16].map((x) => x * S);
    const a = ts.map((t) => [M(t), C(t)]);
    const b = [...ts].reverse().map((t) => [stateAt(PI, t, { ...main }), stateAt(PI, t, { ...sub })]).reverse();
    expect(b).toEqual(a);
    // a door is one place at one moment: when one canvas has it (even fading), the other does not
    for (let t = 0; t < 22 * S; t += 50) expect(M(t).present && C(t).present, `+${t} ms`).toBe(false);
  });
});

// The follow pane (./subview.ts presenceAt with the main canvas's context): below the main canvas from the moment
// the worker is through the door there — the pane opens then — and back on it from the moment it is out again.
describe("the follow pane and the main canvas agree", () => {
  const el = (x: Record<string, unknown>): El => ({ angle: 0, isDeleted: false, groupIds: [], boundElements: [], x: 0, y: 0, width: 120, height: 60, ...x }) as unknown as El;
  const node = (id: string, label: string, globs: string[], child?: string): El[] => [
    el({ id, type: "rectangle", customData: { codePaths: globs, ...(child ? { childCanvas: child } : {}) }, boundElements: [{ id: `${id}-t`, type: "text" }] }),
    el({ id: `${id}-t`, type: "text", text: label, containerId: id }),
  ];
  const SCENES: Scenes = new Map([
    ["c1", [...node("api", "API 服务", ["server/**"], "c-api"), ...node("mysql", "MySQL", ["server/db/**"])]],
    ["c-api", [...node("users", "用户模块", ["server/users.py"]), ...node("app", "应用入口", ["server/app.py"])]],
  ]);
  const c = subviewCtx("c1", SCENES, {}, () => PI, () => main);
  const P = (t: number) => presenceAt(PI, t, c)!;
  const inAt = M(6 * S).trip!.t1;
  const behindAt = inAt + DOOR_MS;
  const back = C(15.1 * S).trip!.t1 + DOOR_MS; // through the door at the entrance
  const outAt = back;

  it("walking to the door it is not below yet (no entry, the pane stays shut); through the door it is, entered at that moment", () => {
    for (let t = 5 * S; t < behindAt; t += 250) expect(P(t), `+${t} ms`).toMatchObject({ entered: null, ended: false });
    expect(P(5 * S).levels).toHaveLength(1);
    expect(P(behindAt + 1)).toMatchObject({ entered: behindAt });
    expect(P(behindAt + 1).levels).toHaveLength(2);
    expect(P(12 * S).entered).toBe(behindAt);
  });

  it("leaving, it stays below until it is out at the entrance and through the door; then it is back on the main canvas", () => {
    for (let t = 15 * S; t < outAt; t += 250) expect(P(t).levels?.length, `+${t} ms`).toBe(2);
    expect(P(outAt + 1).levels).toHaveLength(1);
    expect(M(outAt + 1)).toMatchObject({ present: true });
  });
});
