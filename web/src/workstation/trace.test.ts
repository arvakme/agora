// 追踪 (./trace.ts traceAt; web/docs/workstation.md §追踪): one agent's way over the canvas up to t — the
// places it went to in order (numbered on the canvas: a glance is not a visit, a second visit is a new
// stop), reached when the figure stops walking there; each walk between two of them along the route the
// walk takes (the legs its bridges and ladders come from), walked up to where the walker is; the
// sub-diagram entry it went through; where each sub-agent was sent from and handed back. Only the stretch
// of work t is in; in replay what comes after t is listed, not yet reached.
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { OUTSIDE, stateAt, type Ctx } from "./place.ts";
import { tripAt } from "./rig.ts";
import { route, walkMap } from "./route.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";
import { itemOfStop, itemsOfStop, pointAt, spanOf, stopForItem, traceAt, turnWindowOf, walkedAt, type Trace } from "./trace.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const run = (id: string, segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id, agent: "pi", name: id, segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
const pts = (...n: number[]) => n.filter((_, i) => i % 2 === 0).map((x, i) => ({ x, y: n[2 * i + 1] }));

// The prototype's diagram (as in trip.test.ts): Web 前端 — HTTP bridge — API 服务 — the SQL arrow, upright at
// x = 610 — MySQL; the 图外 tray below. API 服务 opens a sub-diagram (c-api) that claims server/app.py and
// server/users.py.
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
const ctx = (runs: WorkRun[], reduced = false): Ctx => ({
  locate: (p) =>
    p === "server/app.py"
      ? { place: "api", portal: { canvasId: "c-api", label: "应用入口" } }
      : p === "server/users.py"
        ? { place: "api", portal: { canvasId: "c-api", label: "用户模块" } }
        : p.startsWith("server/db/")
          ? { place: "db" }
          : p.startsWith("server/")
            ? { place: "api" }
            : p.startsWith("web/")
              ? { place: "web" }
              : null,
  dock,
  route: (a, b) => route(map, a, b),
  reduced,
  run: (id) => runs.find((r) => r.id === id),
});

// Pi: at API 服务 (reading in its sub-diagram), up the ladder to MySQL (with a glance back at API 服务), back
// down to write, a glance at Web 前端, over a scaffold to the 图外 tray and back. It sends Codex (which walks
// to the tray and back to hand over) and worker-3 (known only by its receipts).
const codex = run("codex", [seg("read", 21, 24, "server/users.py"), seg("write", 24, 30, "tests/test_users.py"), seg("exec", 30, 33)], { parentId: "pi", spawnAt: 19.6 * S, doneAt: 33.6 * S });
const w3 = run("w3", [], { parentId: "pi", coarse: true, spawnAt: 20.5 * S, doneAt: 38 * S });
const pi = run(
  "pi",
  [
    // (a stretch that starts with a call that has a place appears there; one that starts with a thought starts at the tray — ./director.test.ts)
    seg("read", 0, 6.5, "server/app.py"),
    seg("read", 6.5, 9.5, "server/db/models.py"),
    seg("read", 9.5, 10.5, "server/app.py"),
    seg("think", 10.5, 12),
    seg("write", 12, 19, "server/users.py"),
    seg("delegate", 19, 20),
    seg("read", 20, 21, "web/src/api.ts"),
    seg("write", 21, 25, "server/users.py"),
    // 2026-09-29 用户决定调慢走路: was read 25–29, write 29–36 — a walk to the tray is now ~4.8 s, so it stands there a while before walking back
    seg("read", 25, 33, "docs/notes.md"),
    seg("write", 33, 40, "server/users.py"),
  ],
  { children: [codex, w3] },
);
const all = [pi, codex, w3];
const C = ctx(all);
const places = (tr: Trace) => tr.stops.map((s) => s.place);

describe("traceAt (追踪)", () => {
  it("lists the places it went to in order, from where it appeared: a glance is not a visit, a second visit to a node is a new stop", () => {
    const tr = traceAt(pi, 40 * S, C);
    expect(tr.id).toBe("pi");
    expect(places(tr)).toEqual(["api", "db", "api", OUTSIDE, "api"]);
    expect(tr.stops.map((s) => s.t0 / S)).toEqual([0, 6.5, 12, 25, 33]);
    expect(tr.stops.every((s) => s.done)).toBe(true);
    expect(tr.ways.map((w) => [w.from, w.to])).toEqual([[0, 1], [1, 2], [2, 3], [3, 4]]);
  });

  it("a stop is reached when the figure stops walking there; up to t only those are reached, and in replay the ones after t are listed, not yet reached", () => {
    const tr = traceAt(pi, 40 * S, C);
    for (const s of tr.stops.slice(1)) {
      expect(stateAt(pi, s.at - 1, C).pose, s.place).toBe("walk");
      expect(stateAt(pi, s.at, C).pose, s.place).not.toBe("walk");
      expect(stateAt(pi, s.at, C).at).toBe(s.place);
    }
    const mid = traceAt(pi, 7 * S, C); // on the way up to MySQL
    expect(places(mid)).toEqual(places(tr));
    expect(mid.stops.map((s) => s.done)).toEqual([true, false, false, false, false]);
    expect(traceAt(pi, 20 * S, C).stops.map((s) => s.done)).toEqual([true, true, true, false, false]);
  });

  it("each walk follows the route the figure walks: legs end to end from the dock it left to the dock it goes to, and every bridge and ladder the walk draws lies on them", () => {
    const tr = traceAt(pi, 40 * S, C);
    for (const w of tr.ways) {
      const from = tr.stops[w.from].place;
      const to = tr.stops[w.to].place;
      expect(w.legs[0].a, `${from} → ${to}`).toEqual(dock(from));
      expect(w.legs.at(-1)!.b, `${from} → ${to}`).toEqual(dock(to));
      w.legs.slice(1).forEach((l, i) => expect(l.a).toEqual(w.legs[i].b));
      expect(w.len).toBeCloseTo(w.legs.reduce((n, l) => n + Math.abs(l.b.x - l.a.x) + Math.abs(l.b.y - l.a.y), 0), 6);
      for (const b of w.trip!.bridges) expect(w.legs.some((l) => l.kind === "bridge" && l.a.x === b.a.x && l.b.x === b.b.x && l.a.y === b.a.y)).toBe(true);
      for (const d of w.trip!.ladders) expect(w.legs.some((l) => l.kind === "climb" && l.a.x === d.x && Math.min(l.a.y, l.b.y) >= d.top - 1e-6 && Math.max(l.a.y, l.b.y) <= d.bottom + 1e-6)).toBe(true);
    }
    // API 服务 → MySQL: up the ladder where the SQL arrow runs upright
    expect(tr.ways[0].legs.some((l) => l.kind === "climb" && l.a.x === 610)).toBe(true);
    expect(tr.ways[0].trip!.ladders.map((d) => d.x)).toContain(610);
  });

  it("the walked part of a walk grows with the walker: none before it sets off, all once it is there, never shrinking or jumping, its end at the walker's feet", () => {
    const w = traceAt(pi, 40 * S, C).ways[0]; // API 服务 → MySQL, up the ladder
    expect(walkedAt(w, w.t0 - 100)).toBe(0);
    expect(walkedAt(w, w.t1)).toBe(w.len);
    expect(walkedAt(w, w.t1 + 500)).toBe(w.len);
    let prev = 0;
    for (let t = w.t0; t <= w.t1; t += 4) {
      const d = walkedAt(w, t);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(d - prev).toBeLessThan(4);
      // a climber keeps 4 figure units (4.8 px) off the ladder, so round the ladder's foot the end of
      // the line is off its feet by that much across and up: under 4.8·√2
      const p = pointAt(w.legs, d);
      const feet = tripAt(w.trip!, t).root;
      expect(Math.hypot(p.x - feet.x, p.y - feet.y), `t = ${t - w.t0} ms`).toBeLessThan(7);
      prev = d;
    }
  });

  it("with reduced motion there is no walk: a stop is reached as the figure sets off (it fades across), and its way is there whole from then", () => {
    const tr = traceAt(pi, 40 * S, ctx(all, true));
    expect(places(tr)).toEqual(["api", "db", "api", OUTSIDE, "api"]);
    for (const s of tr.stops) expect(s.at).toBe(s.t0);
    for (const w of tr.ways) {
      expect(w.trip).toBeNull();
      expect(walkedAt(w, w.t0 - 1)).toBe(0);
      expect(walkedAt(w, w.t0)).toBe(w.len);
    }
  });

  it("a stop where it worked on files its node claims through a sub-diagram carries that entry: the canvas and the nodes it went to in there, in order; a glance from elsewhere does not count", () => {
    const tr = traceAt(pi, 40 * S, C);
    expect(tr.stops.map((s) => s.portal ?? null)).toEqual([
      { canvasId: "c-api", labels: ["应用入口"] },
      null, // MySQL (the glance back at server/app.py was from there)
      { canvasId: "c-api", labels: ["用户模块"] },
      null,
      { canvasId: "c-api", labels: ["用户模块"] },
    ]);
    const both = run("both", [seg("read", 0, 3, "server/app.py"), seg("write", 3, 6, "server/users.py"), seg("read", 6, 9, "server/app.py")]);
    expect(traceAt(both, 10 * S, ctx([both])).stops).toMatchObject([{ place: "api", portal: { canvasId: "c-api", labels: ["应用入口", "用户模块"] } }]);
  });

  it("sub-agents: each is sent from where its dispatcher stood and hands back where the dispatcher is when it is done, through the places it went; one known only by its receipts never walks and has no way to show", () => {
    const tr = traceAt(pi, 40 * S, C);
    expect(tr.subs.map((s) => s.id)).toEqual(["codex"]);
    const s = tr.subs[0];
    expect(s.sent).toMatchObject({ place: "api", t0: 19.6 * S, done: true });
    expect(s.stops.map((x) => x.place)).toEqual(["api", OUTSIDE, "api"]);
    expect(s.back).toMatchObject({ place: "api", t0: 33.6 * S, done: true });
    expect(s.back!.at).toBeGreaterThan(33.6 * S);
    expect(stateAt(codex, s.back!.at, C)).toMatchObject({ at: "api", pose: "handoff" });
    // before it is done it has not handed back; before it is sent it is not there
    const mid = traceAt(pi, 30 * S, C).subs[0];
    expect(mid.back).toBeNull();
    expect(mid.stops.map((x) => x.done)).toEqual([true, true, false]);
    expect(traceAt(pi, 19 * S, C).subs).toEqual([]);
  });

  it("only the stretch of work t is in: after a minute with nothing going on the worker leaves, and when work starts again the trace starts over where it reappears", () => {
    const r = run("r", [seg("write", 0, 5, "server/app.py"), seg("read", 5, 10, "server/db/models.py"), seg("read", 80, 85, "web/src/api.ts"), seg("write", 85, 90, "server/users.py")]);
    const c = ctx([r]);
    expect(places(traceAt(r, 9 * S, c))).toEqual(["api", "db"]);
    const later = traceAt(r, 82 * S, c);
    expect(places(later)).toEqual(["web", "api"]);
    expect(later.stops.map((s) => [s.t0 / S, s.done])).toEqual([[80, true], [85, false]]);
  });
});

// ——— a real session: s-7xzd5n5 of the 圆桌 AI copy (Claude Code, 8 turns; E1, 2026-09-29) ———
// The trajectory rows and the trace's stops are two views of the same transcript items: the row's id is the
// tool call's `toolu_…` id, the stop's call carries the lane segment's `itemId` — they must be the same string.
// Segments below are the ones the server's /api/agent/runs gave (turn 1: reads, edits, `go vet`; turn 2: `sleep 20`,
// reads; turn 8: a comment's reads), times relative to the first.
const T_REAL = 1_790_659_665_879;
const REAL: [RunSeg["kind"], number, number, string | null, string, number][] = [
  ["read", 0, 300, "controlplane/internal/a2aext/a2aext.go", "toolu_01QdGvYyTrXrXaztrs47TsVe", 1],
  ["read", 425, 725, "webapp/src/start.ts", "toolu_01B1XoZUWzVsfSaPLPugTcY4", 1],
  ["write", 3910, 4772, "controlplane/internal/a2aext/a2aext.go", "toolu_01EbbCnv139vtC2uDCSjXnJN", 1],
  ["write", 4753, 5053, "webapp/src/start.ts", "toolu_01GhJ4E9XkxqM5CgPRnGEhWS", 1],
  ["exec", 6572, 40616, "controlplane/internal/a2aext", "toolu_01Hnky9CqJtzig3G9cfZB9Tx", 1],
  ["exec", 295252, 316442, null, "toolu_01M2xQkeJX21SkoFPKCLBCqk", 2],
  ["read", 318681, 318981, "controlplane/internal/a2aext/a2aext.go", "toolu_01B3DHcS2MZghMjsnoXeiNuF", 2],
  ["read", 318862, 319162, "webapp/src/start.ts", "toolu_0185XPCkDGZfGpXbP3qViyzk", 2],
  ["exec", 320803, 341840, null, "toolu_01N3rJwgGEcYydGneasyVo7X", 2],
  ["read", 722422, 723651, null, "toolu_01QuHZnXk2Pp5hYEJDaXAoE5", 8],
  ["read", 726406, 727480, "controlplane/internal/ratelimit/ratelimit.go", "toolu_01RBpPKmdfeNH6hQ76JedVMs", 8],
  ["read", 730265, 731405, "controlplane/internal/auth/ratelimit.go", "toolu_01Q7VVS9zvfWSm37AnMqzZhg", 8],
];
const realRun = run(
  "claude:6680fa1f",
  REAL.map(([kind, s, e, path, itemId, turn]) => ({ kind, start: T_REAL + s, end: T_REAL + e, label: kind, ...(path ? { path } : {}), itemId, turn })),
);
const RBOX: Record<string, Box> = { controlplane: { x: 300, y: 300, w: 200, h: 72 }, webapp: { x: 40, y: 100, w: 200, h: 72 }, [OUTSIDE]: { x: 620, y: 470, w: 200, h: 56 } };
const rctx: Ctx = {
  locate: (p) => (p.startsWith("controlplane/") ? { place: "controlplane" } : p.startsWith("webapp/") ? { place: "webapp" } : null),
  dock: (p) => ({ x: RBOX[p].x + 24, y: RBOX[p].y }),
  reduced: false,
  run: () => realRun,
};

describe("a real session: trajectory rows ↔ stops (E1)", () => {
  const turn = (n: number) => turnWindowOf(realRun, n)!;
  const trace = (n: number) => traceAt(realRun, T_REAL + 900_000, rctx, Date.now(), spanOf(turn(n), T_REAL + 900_000));

  it("every tool call of a turn is on a stop, and its row (the item id) leads to exactly that stop and back", () => {
    for (const n of [1, 2, 8]) {
      const tr = trace(n);
      for (const [, , , , itemId, t] of REAL.filter((x) => x[5] === n)) {
        const at = stopForItem(tr, itemId);
        expect(at, `turn ${t} ${itemId}`).not.toBeNull();
        expect(tr.stops[at!.index].calls.some((c) => c.itemId === itemId)).toBe(true);
        const first = itemOfStop(tr, at!.run, at!.index)!;
        expect(stopForItem(tr, first)).toEqual(at);
      }
    }
  });

  it("turn 1: reads/edits of the two files are on their nodes' stops (controlplane, then webapp); a command with no file stays on the stop it was run at", () => {
    const tr = trace(1);
    // (the server's segment for `go vet` names the package folder, so it is a third stop, back at controlplane)
    expect(tr.stops.map((s) => s.place)).toEqual(["controlplane", "webapp", "controlplane"]);
    expect(stopForItem(tr, "toolu_01QdGvYyTrXrXaztrs47TsVe")).toMatchObject({ index: 0 });
    expect(stopForItem(tr, "toolu_01GhJ4E9XkxqM5CgPRnGEhWS")).toMatchObject({ index: 1 });
    // the turn-2 `sleep 20` has no file and no node: it is where the worker stood
    const t2 = trace(2);
    expect(stopForItem(t2, "toolu_01M2xQkeJX21SkoFPKCLBCqk")).not.toBeNull();
  });

  it("a stop's whole set of calls (the rows that light together when it is clicked), in time order, only those with a transcript item", () => {
    const tr = trace(1);
    const edit = stopForItem(tr, "toolu_01EbbCnv139vtC2uDCSjXnJN")!;
    const all = itemsOfStop(tr, tr.id, edit.index);
    expect(all).toContain("toolu_01EbbCnv139vtC2uDCSjXnJN");
    expect(itemsOfStop(tr, tr.id, 0)).toContain("toolu_01QdGvYyTrXrXaztrs47TsVe");
    for (let i = 0; i < tr.stops.length; i++) {
      const ids = itemsOfStop(tr, tr.id, i);
      expect(new Set(ids).size).toBe(ids.length);
      expect(itemOfStop(tr, tr.id, i)).toBe(ids[0] ?? null);
    }
    expect(itemsOfStop(tr, tr.id, 99)).toEqual([]);
    expect(itemsOfStop(tr, "nobody", 0)).toEqual([]);
  });

  it("the second turn's stops point at the second turn's rows, not the first's", () => {
    const t2 = trace(2);
    const rows = new Set(REAL.filter((x) => x[5] === 2).map((x) => x[4]));
    for (let i = 0; i < t2.stops.length; i++) for (const id of itemsOfStop(t2, t2.id, i)) expect(rows.has(id)).toBe(true);
  });
});
