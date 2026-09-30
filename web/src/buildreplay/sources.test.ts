// The replay's own world (./sources.ts): canvases at the moment shown, in the ids and shapes the 工位视图 reads.
import { describe, expect, it, vi } from "vitest";
import type { El } from "../canvas/scene";
import { pathFor, planBuild } from "./plan";
import { BuildWorld, realId, worldId } from "./sources";
import type { BuildTimeline } from "./types";

const node = (id: string, x: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x, y: 0, width: 100, height: 50, index: id, isDeleted: false, ...extra }) as unknown as El;
const claude = { kind: "agent", agent: "claude", name: "Claude Code" } as const;
const tl: BuildTimeline = {
  format: "agora-build-timeline",
  version: 1,
  root: "c1",
  canvases: { c1: { title: "总架构", parent: null }, be: { title: "后端", parent: { canvas: "c1", node: "b" } } },
  start: { c1: [], be: [] },
  steps: [
    { i: 0, at: 0, until: 0, canvas: "c1", actor: claude, items: [{ kind: "add-node", say: "加了节点「后端」", place: "b", ids: ["b"], quiet: false, add: [node("b", 0)] }] },
    { i: 1, at: 1, until: 1, canvas: "c1", actor: claude, items: [{ kind: "expand", say: "把「后端」展开成子图", place: "b", ids: ["b"], quiet: false, child: "be", change: [node("b", 0, { customData: { childCanvas: "be" } })] }] },
    { i: 2, at: 2, until: 2, canvas: "be", actor: claude, items: [{ kind: "add-node", say: "加了节点「订单」", place: "o", ids: ["o"], quiet: false, add: [node("o", 0)] }] },
  ],
  sources: { changes: 3, yourSteps: 0, unseenEdits: 0, steps: 3, dropped: 0 },
};

describe("BuildWorld", () => {
  const plan = planBuild(tl);
  const world = new BuildWorld(tl, plan, 1_800_000_000_000);

  it("canvas ids carry a prefix, and only the world's own code knows how to take it off", () => {
    expect(worldId("c1")).toBe("build~c1");
    expect(realId("build~c1")).toBe("c1");
    expect(realId("c1")).toBe("c1");
  });

  it("the pictures are what has landed by the time shown; listeners hear of a change only when one landed", () => {
    const heard = vi.fn();
    world.visible.subscribe(heard);
    const ids = (c: string) => [...(world.visible.get().get(worldId(c)) ?? [])].map((e) => e.id);
    expect(ids("c1")).toEqual([]);
    world.setTime(plan.beats[0].land - 1);
    expect(heard).not.toHaveBeenCalled();
    world.setTime(plan.beats[0].land);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(ids("c1")).toEqual(["b"]);
    world.setTime(plan.beats[0].land + 1);
    expect(heard).toHaveBeenCalledTimes(1);
    world.setTime(plan.length);
    expect(ids("be")).toEqual(["o"]);
  });

  it("the places are all there from the start: a figure walks to a node before it draws it", () => {
    const fresh = new BuildWorld(tl, plan, 1_800_000_000_000);
    const st = fresh.nested.get();
    expect(st.scenes.get(worldId("c1"))!.map((e) => e.id)).toEqual(["b"]);
    expect(st.scenes.get(worldId("be"))!.map((e) => e.id)).toEqual(["o"]);
    expect(fresh.visible.get().get(worldId("c1"))).toEqual([]);
  });

  it("nodes stand for files, and the child link points into the world (so the door logic finds the sub-diagram)", () => {
    const st = world.nested.get();
    const b = st.scenes.get(worldId("c1"))!.find((e) => e.id === "b")!;
    expect(b.customData).toEqual({ codePaths: [pathFor("c1", "b")], childCanvas: "build~be" });
    expect(st.index.get("build~be")).toEqual({ canvasId: "build~c1", elementId: "b" });
    expect(st.titles).toEqual({ "build~c1": "总架构", "build~be": "后端" });
  });

  it("the runs are one constant set", () => {
    const a = world.runs.get();
    world.setTime(0);
    expect(world.runs.get()).toBe(a);
    expect(a.flat.map((f) => f.run.id)).toEqual(["build:claude"]);
  });
});
