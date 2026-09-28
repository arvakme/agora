// 子视图 (./subview.ts; web/docs/workstation.md §10): where a file lies below the canvas the person
// looks at — 总架构 › API 服务 › 用户模块, any depth, loops cut — and where each agent stands at t,
// whether it came below to work there (and when), and which newcomers the follow pane should react
// to. Pure functions of the scenes, the run logs and t.
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene";
import type { Scenes } from "../nested/graph";
import type { RunSeg, WorkRun } from "./runs/types.ts";
import { arrivals, levelsOf, presenceAt, subviewCtx, type Level, type Presence } from "./subview.ts";

const el = (x: Record<string, unknown>): El => ({ angle: 0, isDeleted: false, groupIds: [], boundElements: [], x: 0, y: 0, width: 120, height: 60, ...x }) as unknown as El;
/** A linked node with its label; `child` = the canvas it opens. */
const node = (id: string, label: string, globs: string[], child?: string): El[] => [
  el({ id, type: "rectangle", customData: { codePaths: globs, ...(child ? { childCanvas: child } : {}) }, boundElements: [{ id: `${id}-t`, type: "text" }] }),
  el({ id: `${id}-t`, type: "text", text: label, containerId: id }),
];

// 总架构 → API 服务 (a child canvas) → 用户模块 (a grandchild).
const TREE: [string, El[]][] = [
  ["c1", [...node("web", "Web 前端", ["web/**"]), ...node("api", "API 服务", ["server/**"], "c-api"), ...node("mysql", "MySQL", ["server/db/**"])]],
  ["c-api", [...node("app", "应用入口", ["server/app.py"]), ...node("routes", "路由", ["server/routes/**"]), ...node("users", "用户模块", ["server/users.py", "server/users/**"], "c-users"), ...node("auth", "鉴权", ["server/auth/**"])]],
  ["c-users", [...node("model", "模型", ["server/users/models.py"]), ...node("views", "接口", ["server/users/views.py"])]],
];
const SCENES: Scenes = new Map(TREE);
const TITLES = { c1: "总架构", "c-api": "API 服务", "c-users": "用户细节" };
const hops = (ls: Level[] | null) => ls && ls.map((l) => `${l.canvasId}/${l.node}`);

describe("levelsOf: where a file lies from the main canvas down", () => {
  it("a file the parent node claims only through its child canvas goes one level down, to the node there that has it", () => {
    expect(levelsOf("server/app.py", "c1", SCENES, TITLES)).toEqual([
      { canvasId: "c1", title: "总架构", node: "api", label: "API 服务" },
      { canvasId: "c-api", title: "API 服务", node: "app", label: "应用入口" },
    ]);
  });

  it("goes as deep as the nesting does", () => {
    expect(hops(levelsOf("server/users/models.py", "c1", SCENES, TITLES))).toEqual(["c1/api", "c-api/users", "c-users/model"]);
    expect(levelsOf("server/users/models.py", "c1", SCENES, TITLES)!.map((l) => l.label)).toEqual(["API 服务", "用户模块", "模型"]);
    // a node's own path keeps the file on that level, even when the node opens a child
    expect(hops(levelsOf("server/users.py", "c1", SCENES, TITLES))).toEqual(["c1/api", "c-api/users"]);
  });

  it("a file the main canvas claims itself stays on it; a more specific node there wins; nothing claims it → null (图外)", () => {
    expect(hops(levelsOf("server/config.py", "c1", SCENES, TITLES))).toEqual(["c1/api"]);
    expect(hops(levelsOf("server/db/models.py", "c1", SCENES, TITLES))).toEqual(["c1/mysql"]);
    expect(levelsOf("tests/test_users.py", "c1", SCENES, TITLES)).toBeNull();
  });

  it("counts from whichever canvas is the main one; what only a canvas above claims is outside it", () => {
    expect(hops(levelsOf("server/users/models.py", "c-api", SCENES, TITLES))).toEqual(["c-api/users", "c-users/model"]);
    expect(hops(levelsOf("server/users/models.py", "c-users", SCENES, TITLES))).toEqual(["c-users/model"]);
    expect(levelsOf("server/app.py", "c-users", SCENES, TITLES)).toBeNull();
  });

  it("a child canvas that is gone: the node that pointed at it is as deep as it gets", () => {
    const gone: Scenes = new Map(TREE.filter(([id]) => id !== "c-users"));
    expect(hops(levelsOf("server/users/models.py", "c1", gone, TITLES))).toEqual(["c1/api", "c-api/users"]);
  });

  it("a loop (a grandchild opening the top canvas again) is cut: every answer is finite and each canvas appears once", () => {
    const loop: Scenes = new Map([...TREE.slice(0, 2), ["c-users", [...TREE[2][1], ...node("up", "上层", [], "c1")]]]);
    expect(hops(levelsOf("server/users/models.py", "c1", loop, TITLES))).toEqual(["c1/api", "c-api/users", "c-users/model"]);
    expect(hops(levelsOf("server/app.py", "c1", loop, TITLES))).toEqual(["c1/api", "c-api/app"]);
    expect(hops(levelsOf("web/app.ts", "c-users", loop, TITLES))).toEqual(["c-users/up", "c1/web"]);
    for (const p of ["server/whatever.py", "server/users/views.py", "web/x.ts", "server/db/a.py"])
      for (const main of ["c1", "c-api", "c-users"]) {
        const ls = levelsOf(p, main, loop, TITLES) ?? [];
        expect(new Set(ls.map((l) => l.canvasId)).size, `${p} from ${main}`).toBe(ls.length);
      }
  });
});

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const run = (id: string, segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id, agent: "pi", name: id, segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
const ctxOf = (runs: WorkRun[], main = "c1") => subviewCtx(main, SCENES, TITLES, (id) => runs.find((r) => r.id === id));
const at = (r: WorkRun, sec: number, runs: WorkRun[] = [r], main = "c1") => presenceAt(r, sec * S, ctxOf(runs, main));

describe("presenceAt: where an agent is below the main canvas at t, and since when it works there", () => {
  // Pi as in the test project's script: reads app.py (API's detail), reads models.py (MySQL, on the
  // main canvas), then writes deep down, glances at MySQL and moves on inside the sub-view.
  const pi = run("pi", [
    seg("think", 0, 3),
    seg("read", 3, 6.5, "server/app.py"),
    seg("read", 6.5, 9.5, "server/db/models.py"),
    seg("think", 9.5, 12),
    seg("write", 12, 19, "server/users/models.py"),
    seg("read", 19, 20, "server/db/schema.py"),
    seg("write", 20, 24, "server/auth/token.py"),
  ]);

  it("before its first file it already stands where that file is (below), but has not come to work there yet", () => {
    expect(at(pi, -1)).toBeNull();
    expect(at(pi, 2)).toMatchObject({ entered: null, ended: false });
    expect(hops(at(pi, 2)!.levels)).toEqual(["c1/api", "c-api/app"]);
  });

  it("working on a file below the main canvas: entered = when that work started", () => {
    const p = at(pi, 4)!;
    expect(hops(p.levels)).toEqual(["c1/api", "c-api/app"]);
    expect(p.entered).toBe(3 * S);
  });

  it("walking out to a node of the main canvas ends the stay; coming back is a new entry", () => {
    expect(at(pi, 7)).toMatchObject({ entered: null, ended: false });
    expect(hops(at(pi, 7)!.levels)).toEqual(["c1/mysql"]);
    expect(at(pi, 10)!.entered).toBeNull();
    expect(hops(at(pi, 13)!.levels)).toEqual(["c1/api", "c-api/users", "c-users/model"]);
    expect(at(pi, 13)!.entered).toBe(12 * S);
  });

  it("a glance at the main canvas does not end the stay; moving between sub-views keeps the entry time", () => {
    expect(hops(at(pi, 19.5)!.levels)).toEqual(["c1/api", "c-api/users", "c-users/model"]);
    expect(at(pi, 19.5)!.entered).toBe(12 * S);
    expect(hops(at(pi, 21)!.levels)).toEqual(["c1/api", "c-api/auth"]);
    expect(at(pi, 21)!.entered).toBe(12 * S);
  });

  it("idle after its work: ended", () => {
    expect(at(pi, 25)).toMatchObject({ ended: true });
  });

  it("relative to the main canvas: with 用户细节 itself as the main canvas, working there is not below it", () => {
    const p = at(pi, 13, [pi], "c-users")!;
    expect(hops(p.levels)).toEqual(["c-users/model"]);
    expect(p.entered).toBeNull();
    expect(at(pi, 21, [pi], "c-users")).toMatchObject({ levels: null, entered: null });
  });

  it("a sub-agent: sent to where its dispatcher works (below) it stands there; its own file there is its entry; 图外 is outside; reporting back ends it", () => {
    const boss = run("boss", [seg("write", 0, 10, "server/users.py")]);
    const sub = run("sub", [seg("read", 4, 6, "server/users.py"), seg("write", 6, 8, "tests/test_users.py")], { parentId: "boss", spawnAt: 2 * S, doneAt: 9 * S });
    const all = [boss, sub];
    expect(at(sub, 1, all)).toBeNull();
    expect(hops(at(sub, 3, all)!.levels)).toEqual(["c1/api", "c-api/users"]);
    expect(at(sub, 3, all)).toMatchObject({ entered: null, ended: false });
    expect(at(sub, 5, all)!.entered).toBe(4 * S);
    expect(at(sub, 7, all)).toMatchObject({ levels: null, entered: null, ended: false });
    expect(at(sub, 9.2, all)).toMatchObject({ entered: null, ended: true });
  });

  it("is a pure function of the logs and t: stepping there and jumping there agree", () => {
    const c = ctxOf([pi]);
    for (const t of [2, 4, 7, 13, 19.5, 21, 25].map((x) => x * S)) {
      let stepped = presenceAt(pi, 0, c);
      for (let u = 0; u <= t; u += 250) stepped = presenceAt(pi, u, c);
      expect(presenceAt(pi, t, ctxOf([pi]))).toEqual(presenceAt(pi, t, c));
      if (t % 250 === 0) expect(stepped).toEqual(presenceAt(pi, t, c));
    }
  });
});

describe("arrivals: whom the follow pane reacts to", () => {
  const below = (entered: number | null, ended = false): Presence => ({ levels: [{ canvasId: "c1", title: "总架构", node: "api", label: "API 服务" }, { canvasId: "c-api", title: "API 服务", node: "users", label: "用户模块" }], entered, ended });
  const ps = new Map<string, Presence | null>([
    ["pi", below(3 * S)],
    ["cc", below(12 * S)],
    ["codex", below(null)],
    ["gone", null],
    ["top", { levels: [{ canvasId: "c1", title: "总架构", node: "web", label: "Web 前端" }], entered: null, ended: false }],
  ]);

  it("everyone who came below to work and has not been reacted to, the most recent first", () => {
    expect(arrivals(ps, new Map())).toEqual(["cc", "pi"]);
  });

  it("an entry already reacted to does not come back (closing the pane keeps it closed); a new entry does", () => {
    expect(arrivals(ps, new Map([["pi", 3 * S], ["cc", 12 * S]]))).toEqual([]);
    expect(arrivals(ps, new Map([["pi", 3 * S], ["cc", 5 * S]]))).toEqual(["cc"]);
  });
});
