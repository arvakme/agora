// Nodes as places for canvas edits (runs/nodePath.ts, runs/touch.ts): a node the agent drew has no code link, yet the figure goes to it — on the
// canvas it is on (geometry.ts `locate`), or one down through the node that opens its canvas (subview.ts `levelsOf`, the door). Pure.
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene";
import type { Scenes } from "../nested/graph";
import { buildGeometry } from "./geometry.ts";
import { nodePath } from "./runs/nodePath.ts";
import { touches } from "./runs/touch.ts";
import { levelsOf, subviewCtx } from "./subview.ts";
import { directorFrame, figureAt } from "./director.ts";
import { mergeTouches } from "./runs/touch.ts";
import { CUT_DISTANCE, OUTSIDE, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const el = (x: Record<string, unknown>): El => ({ angle: 0, isDeleted: false, groupIds: [], boundElements: [], x: 0, y: 0, width: 160, height: 64, ...x }) as unknown as El;
/** A node with its label, drawn by an agent: no code link. */
const drawn = (id: string, label: string, x: number, child?: string): El[] => [
  el({ id, type: "rectangle", x, ...(child ? { customData: { childCanvas: child } } : {}), boundElements: [{ id: `${id}-t`, type: "text" }] }),
  el({ id: `${id}-t`, type: "text", text: label, containerId: id, x, width: 100, height: 20 }),
];
const SCENES: Scenes = new Map<string, El[]>([
  ["c1", [...drawn("web", "前端", 0), ...drawn("api", "API", 500, "c-api")]],
  ["c-api", [...drawn("app", "入口", 0), ...drawn("users", "用户", 400, "c-users")]],
  ["c-users", [...drawn("model", "模型", 0)]],
]);
const geo = (canvas: string) => {
  const els = SCENES.get(canvas)!;
  return buildGeometry(canvas, els, new Map(els.map((e) => [e.id, e])), SCENES, () => undefined);
};

describe("geometry: a node an agent touched is a place", () => {
  it("without a touch nothing claims it (it is no place, as before)", () => {
    touches.clear();
    expect(geo("c1").boxes.has("web")).toBe(false);
    expect(geo("c1").locate(nodePath("c1", "web"))).toBeNull();
  });
  it("touched: its box is a place and its node path locates it", () => {
    touches.clear();
    touches.record({ session: "s", canvas: "c1", at: 1, until: 1, say: "改图", nodes: [{ id: "web", x: 80, y: 32 }] });
    const g = geo("c1");
    expect(g.boxes.has("web")).toBe(true);
    expect(g.locate(nodePath("c1", "web"))).toEqual({ place: "web" });
    expect(g.locate(nodePath("c1", "api"))).toBeNull(); // not touched: no place
    expect(g.locate(nodePath("elsewhere", "web"))).toBeNull(); // another canvas that is not below this one
  });
  it("a node one or two canvases down: the worker stands on the node that opens the way, the door is named", () => {
    touches.clear();
    touches.record({ session: "s", canvas: "c-api", at: 1, until: 1, say: "改图", nodes: [{ id: "app", x: 0, y: 0 }] });
    touches.record({ session: "s", canvas: "c-users", at: 2, until: 2, say: "改图", nodes: [{ id: "model", x: 0, y: 0 }] });
    // "api" opens c-api and only nodes of it were touched: it has to be a place too — it is a node the worker stands on
    expect(geo("c1").locate(nodePath("c-api", "app"))?.portal?.canvasId).toBe("c-api");
    expect(geo("c1").locate(nodePath("c-api", "app"))?.place).toBe("api");
    expect(geo("c1").locate(nodePath("c-users", "model"))).toMatchObject({ place: "api", portal: { canvasId: "c-api" } });
    expect(geo("c-api").locate(nodePath("c-users", "model"))).toMatchObject({ place: "users", portal: { canvasId: "c-users" } });
    touches.clear();
  });
});

describe("subview: the levels of a node path from the main canvas down", () => {
  it("on the main canvas: one level; below: the chain through the nodes that open the canvases, the node itself last", () => {
    expect(levelsOf(nodePath("c1", "web"), "c1", SCENES, { c1: "总" })!.map((l) => `${l.canvasId}/${l.node}`)).toEqual(["c1/web"]);
    expect(levelsOf(nodePath("c-users", "model"), "c1", SCENES)!.map((l) => `${l.canvasId}/${l.node}`)).toEqual(["c1/api", "c-api/users", "c-users/model"]);
    expect(levelsOf(nodePath("c-users", "model"), "c1", SCENES)!.map((l) => l.label)).toEqual(["API", "用户", "模型"]);
  });
  it("a canvas that is not below the main one (or does not exist) is outside it", () => {
    expect(levelsOf(nodePath("c1", "web"), "c-api", SCENES)).toBeNull();
    expect(levelsOf(nodePath("nowhere", "x"), "c1", SCENES)).toBeNull();
  });
  it("the subview context places a node path like a file (its key), so a run's presence works on it", () => {
    const c = subviewCtx("c1", SCENES, {}, () => undefined);
    const k = c.place(nodePath("c-api", "app"));
    expect(c.levels(k)!.map((l) => l.node)).toEqual(["api", "app"]);
  });
});

describe("a whole diagram drawn at once (30 nodes, one `agora canvas apply`): what the figure does, frame by frame", () => {
  const T0 = 1_800_000_000_000;
  const FRAME = 1000 / 60;
  // 6 × 5 nodes, 260 apart, nothing linked to any file
  const grid: El[] = Array.from({ length: 30 }, (_, i) => drawn(`g${i}`, `节点${i}`, (i % 6) * 260)[0]).map((e, i) => ({ ...e, y: Math.floor(i / 6) * 200 }) as El);
  const scenes: Scenes = new Map([["cg", [...grid]]]);
  const map = new Map(grid.map((e) => [e.id, e]));
  const nodes = grid.map((e) => ({ id: e.id, x: e.x + e.width / 2, y: e.y + e.height / 2 }));
  const setup = (reduced = false) => {
    touches.clear();
    touches.record({ session: "s1", canvas: "cg", at: T0, until: T0, say: "画整张图", nodes });
    const geom = buildGeometry("cg", grid, map, scenes, () => undefined);
    const exec: RunSeg = { kind: "exec", start: T0 - 800, end: T0 + 600, label: "跑 agora", cmd: "agora canvas apply --plan plan.json" };
    const base: WorkRun = { id: "s1", agent: "claude", name: "Claude Code", sessionId: "s1", segs: [{ kind: "think", start: T0 - 6000, end: T0 - 800, label: "想" }, exec], receipts: [], running: true, lastAt: T0, children: [] };
    const r = mergeTouches(base, touches.of("s1"));
    const ctx: Ctx = { locate: geom.locate, dock: geom.dock, route: geom.route, reduced, run: (id) => (id === r.id ? r : undefined) };
    return { r, ctx, geom };
  };
  it("it goes to a few stops, not 30, and each is a node of the grid", () => {
    const { r } = setup();
    const writes = r.segs.filter((g) => g.kind === "write");
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.length).toBeLessThan(12);
    expect(writes.at(-1)!.end - writes[0].start).toBeLessThanOrEqual(8000);
    touches.clear();
  });
  it("walking nowhere it was not asked to: no frame moves the figure by a jump, except across a cut, and it ends standing at work", () => {
    const { r, ctx, geom } = setup();
    const end = r.segs.filter((g) => g.kind === "write").at(-1)!.end;
    let prev: { x: number; y: number } | null = null;
    const places = new Set<string>();
    let writing = 0;
    for (let now = T0 - 500; now <= end + 500; now += FRAME) {
      const f = directorFrame({ runs: [r], now, delay: 0, ctx }).figures[0];
      if (!f) continue;
      places.add(f.state.at);
      if (f.state.pose === "write" && f.state.w >= 1) writing++;
      const p = figureAt(f, ctx);
      if (prev && !f.ghost && !f.state.cut) expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThan(400 / 60);
      prev = p;
    }
    expect(places.has(OUTSIDE)).toBe(true); // it came from the tray
    expect([...places].filter((x) => x !== OUTSIDE).length).toBeLessThanOrEqual(12);
    expect(writing / 60).toBeGreaterThan(1); // and it worked: more than a second of write, standing at a node
    expect(geom.boxes.size).toBe(30);
    touches.clear();
  });
  it("reduced motion: it is at each stop, nothing walks", () => {
    const { r, ctx } = setup(true);
    const w = r.segs.filter((g) => g.kind === "write");
    for (const g of w) {
      const st = directorFrame({ runs: [r], now: g.start + 50, delay: 0, ctx }).figures[0].state;
      expect(st.trip).toBeNull();
      expect(st.cut).toBeUndefined();
      expect(st.at).not.toBe(OUTSIDE);
    }
    expect(CUT_DISTANCE).toBe(650);
    touches.clear();
  });
});

describe("FX4 · P2 #6: a node that was deleted below is no place, in the parent's geometry either", () => {
  const scenes: Scenes = new Map<string, El[]>([
    ["root", [el({ id: "door", type: "rectangle", customData: { childCanvas: "child" } })]],
    ["child", [el({ id: "gone", type: "rectangle", isDeleted: true }), ...drawn("kept", "在", 0)]],
  ]);
  const g = (c: string) => buildGeometry(c, scenes.get(c)!, new Map(scenes.get(c)!.map((e) => [e.id, e])), scenes, () => undefined);
  it("touched `child/gone` (deleted): the parent's node opens no way, the path locates nowhere, on the parent, the child and by levels", () => {
    touches.clear();
    touches.record({ session: "s", canvas: "child", at: 1, until: 1, say: "改图", nodes: [{ id: "gone", x: 80, y: 32 }] });
    expect(g("root").boxes.has("door")).toBe(false);
    expect(g("root").locate(nodePath("child", "gone"))).toBeNull();
    expect(g("child").locate(nodePath("child", "gone"))).toBeNull();
    expect(levelsOf(nodePath("child", "gone"), "root", scenes, {})).toBeNull();
  });
  it("a node that is still there below: the way in is a place as before", () => {
    touches.clear();
    touches.record({ session: "s", canvas: "child", at: 1, until: 1, say: "改图", nodes: [{ id: "kept", x: 80, y: 32 }] });
    const loc = g("root").locate(nodePath("child", "kept"));
    expect(loc?.place).toBe("door");
    expect(loc?.portal?.canvasId).toBe("child");
  });
  it("a touched node on a canvas that is not there any more: no way either", () => {
    touches.clear();
    touches.record({ session: "s", canvas: "nowhere", at: 1, until: 1, say: "改图", nodes: [{ id: "x", x: 0, y: 0 }] });
    expect(g("root").boxes.has("door")).toBe(false);
  });
});
