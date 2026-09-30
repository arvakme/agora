// The walks of the build replay measured on the canvases' own geometry (./geometryWalk.ts): what the figure really takes, not a guess.
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene";
import { geometryWalk } from "./geometryWalk";
import { finalScenes, planBuild } from "./plan";
import type { BuildStep, BuildTimeline } from "./types";

const box = (id: string, label: string, x: number, y: number): El[] => [
  { id, type: "rectangle", x, y, width: 160, height: 64, index: id, isDeleted: false, boundElements: [{ type: "text", id: `${id}-t` }] } as unknown as El,
  { id: `${id}-t`, type: "text", x: x + 10, y: y + 20, width: 100, height: 24, index: `${id}t`, isDeleted: false, containerId: id, text: label } as unknown as El,
];
const claude = { kind: "agent", agent: "claude", name: "Claude Code" } as const;
const add = (i: number, canvas: string, id: string, x: number, y: number): BuildStep => ({ i, at: i, until: i, canvas, actor: claude, items: [{ kind: "add-node", say: id, place: id, ids: [id], quiet: false, add: box(id, id, x, y) }] });
const tl: BuildTimeline = {
  format: "agora-build-timeline",
  version: 1,
  root: "c1",
  canvases: { c1: { title: "总", parent: null }, be: { title: "后", parent: { canvas: "c1", node: "b" } } },
  start: { c1: [], be: [] },
  steps: [add(0, "c1", "a", 0, 0), add(1, "c1", "b", 700, 0), add(2, "c1", "c", 0, 400), add(3, "be", "x", 0, 0), add(4, "be", "y", 300, 300)],
  sources: { changes: 5, yourSteps: 0, unseenEdits: 0, steps: 5, dropped: 0 },
};

describe("geometryWalk", () => {
  const g = geometryWalk(tl);

  it("a farther node takes longer to walk to; the same node takes nothing; what is not there is a settle", () => {
    const near = g.walk("c1", "a", "c"); // 400 px down
    const far = g.walk("c1", "a", "b"); // 700 px across
    expect(near).toBeGreaterThan(800);
    expect(far).toBeGreaterThan(near);
    expect(g.walk("c1", "a", "a")).toBe(500);
    expect(g.walk("c1", null, "a")).toBe(500);
    expect(g.walk("nope", "a", "b")).toBe(500);
  });

  it("the entrance of a sub-diagram is the node nearest its top left", () => {
    expect(g.entrance("be")).toBe("x");
    expect(g.entrance("nope")).toBeNull();
  });

  it("planning with it puts the landing after the walk that really takes this long", () => {
    const p = planBuild(tl, g);
    const [a, b] = p.beats;
    expect(b.land - b.start).toBe(g.walk("c1", "a", "b") + 250);
    expect(a.land - a.start).toBe(250);
  });
});

describe("finalScenes", () => {
  it("every canvas as it is after the last step", () => {
    const s = finalScenes(tl);
    expect(s.get("c1")!.map((e) => e.id)).toEqual(["a", "a-t", "b", "b-t", "c", "c-t"]);
    expect(s.get("be")!.map((e) => e.id)).toEqual(["x", "x-t", "y", "y-t"]);
  });
});
