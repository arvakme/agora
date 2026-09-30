// 按轮追踪 (./trace.ts; web/docs/workstation.md §11): the trace limited to one turn of a session, the tool
// calls at each stop, and the way between a stop and its row in the session's trajectory.
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { OUTSIDE, type Ctx } from "./place.ts";
import { route, walkMap } from "./route.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";
import { itemOfStop, latestTurnWindow, spanOf, stopForItem, traceAt, turnWindowOf } from "./trace.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, x: Partial<RunSeg> = {}): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...x });
const run = (id: string, segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id, agent: "pi", name: id, segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
const pts = (...n: number[]) => n.filter((_, i) => i % 2 === 0).map((x, i) => ({ x, y: n[2 * i + 1] }));

const BOX: Record<string, Box> = {
  web: { x: 40, y: 230, w: 170, h: 72 },
  api: { x: 330, y: 230, w: 200, h: 72 },
  db: { x: 680, y: 120, w: 160, h: 64 },
  [OUTSIDE]: { x: 620, y: 470, w: 200, h: 56 },
};
const map = walkMap(new Map(Object.entries(BOX)), [
  { from: "web", to: "api", pts: pts(210, 266, 330, 266) },
  { from: "api", to: "db", pts: pts(530, 252, 610, 252, 610, 152, 680, 152) },
]);
const dock = (p: string) => ({ x: BOX[p].x + 24, y: BOX[p].y });
const ctx = (runs: WorkRun[]): Ctx => ({
  locate: (p) => (p.startsWith("server/db/") ? { place: "db" } : p.startsWith("server/") ? { place: "api" } : p.startsWith("web/") ? { place: "web" } : null),
  dock,
  route: (a, b) => route(map, a, b),
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
});

// A session with two turns. Turn 1: reads server/app.py (API 服务), writes server/db/models.py (MySQL).
// Turn 2: runs the tests, sends Codex (which writes on its own and hands back), writes notes.md (no node claims it:
// the 图外 tray), looks at a scratch file outside the project.
const codex = run("codex", [seg("write", 26, 30, { path: "web/a.ts", itemId: "c-w" })], { parentId: "pi", name: "Codex", task: "补测试", spawnAt: 24 * S, doneAt: 34 * S });
const pi = run(
  "pi",
  [
    seg("read", 1, 3, { path: "server/app.py", itemId: "r1", turn: 1 }),
    seg("write", 4, 8, { path: "server/db/models.py", itemId: "w1", turn: 1 }),
    seg("think", 9, 10, { turn: 1 }),
    seg("exec", 20, 22, { cmd: "pytest tests/ -q", itemId: "e1", turn: 2 }),
    seg("delegate", 24, 25, { child: "codex", itemId: "d1", turn: 2 }),
    seg("read", 36, 37, { path: "/tmp/scratchpad/shot.png", itemId: "r2", turn: 2 }),
    seg("write", 38, 42, { path: "notes.md", itemId: "w2", turn: 2 }),
  ],
  { running: true, children: [codex] },
);
const runs = [pi, codex];
const c = ctx(runs);
const win1 = spanOf(turnWindowOf(pi, 1)!, 0);
const win2 = spanOf(turnWindowOf(pi, 2)!, 50 * S);
const calls = (tr: ReturnType<typeof traceAt>, place: string) => tr.stops.filter((s) => s.place === place).flatMap((s) => s.calls.map((x) => x.label));

describe("the window of a turn", () => {
  it("runs from its first segment to its last; the latest turn of a running run is open-ended", () => {
    expect(turnWindowOf(pi, 1)).toEqual({ n: 1, start: 1 * S, end: 10 * S }); // thinking counts: it is part of the turn
    expect(turnWindowOf(pi, 2)).toEqual({ n: 2, start: 20 * S, end: null });
    expect(turnWindowOf(pi, 3)).toBeNull();
    expect(turnWindowOf({ ...pi, running: false }, 2)).toEqual({ n: 2, start: 20 * S, end: 42 * S });
  });
  it("tracing a figure starts on its current or latest turn; a run without turn numbers has none", () => {
    expect(latestTurnWindow(pi)!.n).toBe(2);
    expect(latestTurnWindow(run("x", [seg("read", 0, 1, { path: "web/a.ts" })]))).toBeNull();
  });
  it("a running turn ends now", () => {
    expect(spanOf({ n: 2, start: 5, end: null }, 100)).toEqual({ start: 5, end: 100 });
    expect(spanOf({ n: 2, start: 5, end: 9 }, 100)).toEqual({ start: 5, end: 9 });
  });
});

describe("traceAt over one turn: stops and the tool calls at each", () => {
  it("turn 1 has only turn 1's stops, each with the calls made there, in order", () => {
    const tr = traceAt(pi, 50 * S, c, Infinity, win1);
    expect(tr.stops.map((s) => s.place)).toEqual(["api", "db"]);
    expect(calls(tr, "api")).toEqual(["Read server/app.py"]);
    expect(calls(tr, "db")).toEqual(["Edit server/db/models.py"]);
    expect(tr.stops.flatMap((s) => s.calls).map((x) => x.itemId)).toEqual(["r1", "w1"]); // thinking is not a call
    expect(tr.subs).toEqual([]);
  });

  it("turn 2 has the tests, the dispatch, the hand-back and the 图外 tray as a stop of its own", () => {
    const tr = traceAt(pi, 50 * S, c, Infinity, win2);
    const all = tr.stops.flatMap((s) => s.calls);
    expect(all.map((x) => x.label)).toEqual(["Bash pytest tests/ -q", "派出 Codex：补测试", "Read /tmp/scratchpad/shot.png", "Edit notes.md", "Codex 交回"].sort((a, b) => all.findIndex((x) => x.label === a) - all.findIndex((x) => x.label === b)));
    expect(all.map((x) => x.kind).filter((k) => k !== "tool")).toEqual(["spawn", "back"]);
    const tray = tr.stops.filter((s) => s.place === OUTSIDE);
    expect(tray.length).toBeGreaterThan(0);
    expect(tray.flatMap((s) => s.calls.map((x) => x.label))).toContain("Edit notes.md");
    // a file outside the project moves nobody: the read of the scratch file is at the stop the agent stood at
    const scratch = tr.stops.find((s) => s.calls.some((x) => x.itemId === "r2"))!;
    expect(scratch).toBe(tr.stops.find((s) => s.calls.some((x) => x.itemId === "e1"))); // no stop of its own, and not the tray
    // the turn-1 calls are not here
    expect(all.some((x) => x.itemId === "r1" || x.itemId === "w1")).toBe(false);
  });

  it("a turn inside a longer burst of work starts where the agent stood as it began, not with the turns before", () => {
    // turn 1 and turn 2 run back to back (one burst): turn 2's trace must not begin with turn 1's walk
    const a = run("a", [seg("read", 1, 3, { path: "web/a.ts", turn: 1 }), seg("write", 4, 8, { path: "server/db/models.py", turn: 1 }), seg("write", 9, 12, { path: "server/app.py", turn: 2, itemId: "x" })], { running: false });
    const tr = traceAt(a, 50 * S, ctx([a]), Infinity, spanOf(turnWindowOf(a, 2)!, 0));
    expect(tr.stops.map((s) => s.place)).toEqual(["db", "api"]);
    expect(tr.stops.every((s, i) => i === 0 || s.t0 >= 9 * S)).toBe(true);
  });

  it("a dispatch that does not name its run claims the one sent right after it (no second, duplicate line)", () => {
    const kid = run("kid", [], { parentId: "p", name: "Kid", task: "看看", spawnAt: 5.5 * S, doneAt: 9 * S });
    const p = run("p", [seg("delegate", 5, 6, { itemId: "d", turn: 1 }), seg("exec", 7, 8, { cmd: "ls", turn: 1 })], { children: [kid] });
    const tr = traceAt(p, 20 * S, ctx([p, kid]), Infinity, { start: 4 * S, end: 10 * S });
    expect(tr.stops.flatMap((s) => s.calls).map((x) => `${x.kind}:${x.label}`)).toEqual(["spawn:派出 Kid：看看", "tool:Bash ls", "back:Kid 交回"]);
  });

  it("the sub-agent's errand is in the trace, with its own stops and calls", () => {
    const tr = traceAt(pi, 50 * S, c, Infinity, win2);
    expect(tr.subs.map((k) => k.id)).toEqual(["codex"]);
    expect(tr.subs[0].stops.flatMap((s) => s.calls).map((x) => x.itemId)).toEqual(["c-w"]);
  });

  it("only what has happened by `known` is listed (a live turn grows call by call)", () => {
    const early = traceAt(pi, 23 * S, c, 23 * S, win2);
    expect(early.stops.flatMap((s) => s.calls).map((x) => x.itemId)).toEqual(["e1"]);
    const later = traceAt(pi, 39 * S, c, 39 * S, win2);
    expect(later.stops.flatMap((s) => s.calls).map((x) => x.itemId)).toEqual(expect.arrayContaining(["e1", "d1", "r2", "w2"]));
  });

  it("without a window it is the old stretch of work (no turn in the way)", () => {
    const old = traceAt(pi, 21 * S, c);
    expect(old.stops.length).toBeGreaterThan(0);
  });
});

describe("a trajectory row ↔ its stop", () => {
  const tr = traceAt(pi, 50 * S, c, Infinity, win2);
  it("finds the stop of a row, the traced run's or a sub-agent's", () => {
    const at = stopForItem(tr, "w2")!;
    expect(at.run).toBe("pi");
    expect(tr.stops[at.index].calls.some((x) => x.itemId === "w2")).toBe(true);
    expect(stopForItem(tr, "c-w")).toMatchObject({ run: "codex" });
    expect(stopForItem(tr, "r1")).toBeNull(); // a row of another turn
    expect(stopForItem(tr, "nope")).toBeNull();
  });
  it("finds the row of a stop: its first call that has one", () => {
    const at = stopForItem(tr, "w2")!;
    expect(itemOfStop(tr, at.run, at.index)).toBe(tr.stops[at.index].calls.find((x) => x.itemId)!.itemId);
    expect(itemOfStop(tr, "codex", stopForItem(tr, "c-w")!.index)).toBe("c-w");
    expect(itemOfStop(tr, "codex", 0)).toBeNull(); // where the errand began: nothing done there
    expect(itemOfStop(tr, "pi", 99)).toBeNull();
    expect(itemOfStop(tr, "ghost", 0)).toBeNull();
  });
});
