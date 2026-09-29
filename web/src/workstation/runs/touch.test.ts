// Canvas edits an agent makes through the page (`agora canvas apply | anim | child`) as work on the 工位视图 (web/docs/workstation.md §2): the page
// executor says which nodes it changed and when; they become segments of that session's run at those nodes, a slice at a time. Pure, time series.
import { describe, expect, it } from "vitest";
import { REACH_PX } from "../../buildreplay/plan.ts";
import { CUT_DISTANCE, OUTSIDE, stateAt, type Ctx } from "../place.ts";
import { isNodePath, nodePath, parseNodePath, pathLabel } from "./nodePath.ts";
import { BUDGET_MS, mergeTouches, planTouch, sliceNodes, touches, touchNodesOf, type Touch, type TouchEl } from "./touch.ts";
import type { RunSeg, WorkRun } from "./types.ts";

const S = 1000;
const node = (id: string, x: number, y = 0) => ({ id, x, y });
const T0 = 1_800_000_000_000;
const touch = (over: Partial<Touch> & Pick<Touch, "nodes">): Touch => ({ session: "s1", canvas: "c1", at: T0, until: T0, say: "改图", ...over });
const run = (segs: RunSeg[] = [], x: Partial<WorkRun> = {}): WorkRun => ({ id: "s1", agent: "claude", name: "Claude Code", sessionId: "s1", segs, receipts: [], running: true, lastAt: T0, children: [], ...x });
const many = (n: number, gap = 60) => Array.from({ length: n }, (_, i) => node(`n${i}`, (i % 6) * gap * 3, Math.floor(i / 6) * gap * 3));

describe("node paths: a node of a canvas as the place a call is at", () => {
  it("round-trips, is told from a file, and has no file name to show", () => {
    const p = nodePath("c-1", "el/9");
    expect(isNodePath(p)).toBe(true);
    expect(parseNodePath(p)).toEqual({ canvas: "c-1", id: "el/9" });
    expect(isNodePath("server/app.py")).toBe(false);
    expect(parseNodePath("server/app.py")).toBeNull();
    expect(pathLabel(p)).toBe("");
    expect(pathLabel("server/app.py")).toBe("server/app.py");
    expect(p.startsWith("/")).toBe(false); // not "outside the project"
  });
});

describe("touchNodesOf: which of the touched elements are places", () => {
  const e = (id: string, type: string, x: number, o: Partial<TouchEl> = {}): [string, TouchEl] => [id, { id, type, x, y: 0, width: 100, height: 40, ...o }];
  const map = new Map<string, TouchEl>([
    e("a", "rectangle", 0),
    e("b", "ellipse", 400),
    e("a-t", "text", 0, { containerId: "a" }),
    e("ab", "arrow", 100, { startBinding: { elementId: "a" }, endBinding: { elementId: "b" } }),
    e("ab-t", "text", 250, { containerId: "ab" }), // an arrow's label: the arrow's start, not the arrow
    e("loose", "arrow", 900), // bound to nothing
    e("l", "line", 5),
    e("gone", "rectangle", 700, { isDeleted: true }),
    e("free", "text", 800), // a note nobody holds
  ]);
  it("nodes at their centres; text and arrows are work at the node that holds or starts them; the order is the order touched, each once", () => {
    expect(touchNodesOf(["b", "ab-t", "a-t", "ab", "a"], map)).toEqual([{ id: "b", x: 450, y: 20 }, { id: "a", x: 50, y: 20 }]);
  });
  it("no place: an arrow bound to nothing, a line, a deleted node, a free note, an id the scene does not have", () => {
    expect(touchNodesOf(["loose", "l", "gone", "free", "nope"], map)).toEqual([]);
  });
});

describe("sliceNodes: one slice is what one stance reaches", () => {
  it("nodes within REACH_PX of one another are one slice; a far one is another", () => {
    const s = sliceNodes([node("a", 0), node("b", 300), node("c", 3000), node("d", 3200)]);
    expect(s.map((x) => x.nodes.map((n) => n.id))).toEqual([["a", "b"], ["c", "d"]]);
    expect(REACH_PX).toBe(420);
  });
  it("30 nodes on a grid are a handful of slices, not 30", () => {
    const s = sliceNodes(many(30, 40));
    expect(s.length).toBeLessThan(10);
    expect(s.flatMap((x) => x.nodes).length).toBe(30);
  });
  it("the stance is the node the slice is closest to (fewest steps for all of them)", () => {
    const [s] = sliceNodes([node("a", 0), node("b", 200), node("c", 400)]);
    expect(s.stance).toBe("b");
  });
  it("later slices are nearest first, so the way is short", () => {
    const s = sliceNodes([node("a", 0), node("far", 9000), node("near", 900)]);
    expect(s.map((x) => x.stance)).toEqual(["a", "near", "far"]);
  });
});

describe("planTouch: the segments of one change", () => {
  it("one segment per slice, in order, back to back, each a write at its stance node on its canvas", () => {
    const segs = planTouch(touch({ nodes: [node("a", 0), node("b", 3000)] }), T0);
    expect(segs).toHaveLength(2);
    expect(segs.map((g) => [g.kind, parseNodePath(g.path!)])).toEqual([["write", { canvas: "c1", id: "a" }], ["write", { canvas: "c1", id: "b" }]]);
    expect(segs[0].start).toBe(T0);
    expect(segs[1].start).toBe(segs[0].end);
    expect(segs.every((g) => g.end > g.start && g.say)).toBe(true);
    expect(segs[0].cut).toBeUndefined(); // (the first stop is where the figure comes from: its own walk or cut)
    expect(segs[1].cut).toBe(true); // 3000 px on: too far to walk in the time there is — a cut
  });
  it("a next stop near enough is walked to, and it takes what the walk takes (never squeezed: a hurried figure jerks)", () => {
    const [a, b] = planTouch(touch({ nodes: [node("a", 0), node("b", 500)] }), T0);
    expect(b.cut).toBeUndefined();
    expect(b.end - b.start).toBeGreaterThanOrEqual(3000); // 500 + 500 × 1.4 / 0.22 ms of walking, and the work
    expect(a.end - a.start).toBeGreaterThanOrEqual(900);
  });
  it("the work starts when the change was made, not before", () => {
    expect(planTouch(touch({ at: T0 + 5 * S, until: T0 + 5 * S, nodes: [node("a", 0)] }), T0)[0].start).toBe(T0 + 5 * S);
  });
  it("30 nodes changed at once take no longer than BUDGET_MS in all (the picture never waits for the figure)", () => {
    const segs = planTouch(touch({ nodes: many(30, 400) }), T0);
    expect(segs.length).toBeGreaterThan(2); // a few stops, the rest are on the canvas already
    expect(segs.at(-1)!.end - segs[0].start).toBeLessThanOrEqual(BUDGET_MS);
    expect(BUDGET_MS).toBe(8000);
  });
  it("a change that itself took long (an animation) may be shown at 1.5 times its time", () => {
    const segs = planTouch(touch({ until: T0 + 20 * S, nodes: many(30, 400) }), T0);
    expect(segs.at(-1)!.end - segs[0].start).toBeLessThanOrEqual(30 * S);
    expect(segs.at(-1)!.end - segs[0].start).toBeGreaterThan(BUDGET_MS);
  });
  it("a change with no node in it is no work", () => {
    expect(planTouch(touch({ nodes: [] }), T0)).toEqual([]);
  });
});

describe("mergeTouches: into the run", () => {
  const exec = (start: number, end: number, cmd: string): RunSeg => ({ kind: "exec", start, end, label: "跑 agora", cmd });
  const think = (start: number, end: number): RunSeg => ({ kind: "think", start, end, label: "想" });
  it("the run gets the writes, in time order among its own segments", () => {
    const r = run([think(T0 - 4 * S, T0 - S), think(T0 + 20 * S, T0 + 21 * S)]);
    const m = mergeTouches(r, [touch({ nodes: [node("a", 0)] })]);
    expect(m.segs.map((g) => g.kind)).toEqual(["think", "write", "think"]);
    expect(m.segs.every((g, i) => i === 0 || g.start >= m.segs[i - 1].start)).toBe(true);
  });
  it("the command that made the change is not also shown as the figure's work: it is cut where the writes begin", () => {
    const r = run([exec(T0 - 500, T0 + 900, "agora canvas apply --plan p.json"), exec(T0 - 5 * S, T0 - 4 * S, "ls")]);
    const m = mergeTouches(r, [touch({ nodes: [node("a", 0)] })]);
    const cmds = m.segs.filter((g) => g.kind === "exec");
    expect(cmds.map((g) => g.cmd)).toEqual(["ls", "agora canvas apply --plan p.json"]);
    expect(cmds[1].end).toBeLessThanOrEqual(T0);
    expect(m.segs.find((g) => g.start <= T0 + 100 && g.end > T0 + 100)!.kind).toBe("write");
  });
  it("nothing to merge: the very same run comes back", () => {
    const r = run([think(T0, T0 + S)]);
    expect(mergeTouches(r, [])).toBe(r);
  });
  it("a second change while the first is still being shown follows it (segments never overlap); one far behind is one segment at its last node", () => {
    const a = touch({ at: T0, nodes: many(30, 400) });
    const b = touch({ at: T0 + 2 * S, until: T0 + 2 * S, nodes: [node("x", 0), node("y", 5000), node("z", 9000)] });
    const m = mergeTouches(run(), [a, b]);
    for (let i = 1; i < m.segs.length; i++) expect(m.segs[i].start).toBeGreaterThanOrEqual(m.segs[i - 1].end);
    const mine = m.segs.filter((g) => parseNodePath(g.path!)?.id.match(/^[xyz]$/));
    expect(mine).toHaveLength(1);
    expect(parseNodePath(mine[0].path!)?.id).toBe("z");
  });
  it("a change on the canvas the figure stood at for the one before walks from there (a small change next door is a short step, not the long first walk)", () => {
    const a = touch({ at: T0, nodes: [node("a", 0)] });
    const b = touch({ at: T0 + 20 * S, until: T0 + 20 * S, nodes: [node("b", 200)] });
    const m = mergeTouches(run(), [a, b]);
    const [first, second] = m.segs;
    expect(first.end - first.start).toBeGreaterThan(3000); // from the tray: the long walk
    expect(second.end - second.start).toBeLessThan(first.end - first.start); // 200 px on: a step and the work
  });
  it("the same change told twice counts once (the store)", () => {
    touches.clear();
    const t = touch({ nodes: [node("a", 0)] });
    touches.record(t);
    touches.record({ ...t });
    expect(touches.of("s1")).toHaveLength(1);
    touches.record({ ...t, at: T0 + S });
    expect(touches.of("s1")).toHaveLength(2);
    expect(touches.of("nobody")).toEqual([]);
    touches.keep(["other"]);
    expect(touches.of("s1")).toEqual([]);
  });
});

describe("the figure at work on the edited nodes (stateAt on a context that has them)", () => {
  const DOCKS: Record<string, { x: number; y: number }> = { a: { x: 0, y: 0 }, b: { x: 300, y: 0 }, far: { x: 3000, y: 0 }, [OUTSIDE]: { x: 100, y: 100 } };
  const ctx = (r: WorkRun, reduced = false): Ctx => ({
    locate: (p) => {
      const n = parseNodePath(p);
      return n && DOCKS[n.id] ? { place: n.id } : null;
    },
    dock: (p) => DOCKS[p] ?? DOCKS[OUTSIDE],
    reduced,
    run: () => r,
  });
  const drawn = (nodes: ReturnType<typeof node>[], at = T0, over: Partial<Touch> = {}) => mergeTouches(run([{ kind: "think", start: at - 3 * S, end: at, label: "想" }]), [touch({ at, until: at, nodes, ...over })]);
  it("from the tray to the first node it walked to (or is cut to, over CUT_DISTANCE), then works there", () => {
    const r = drawn([node("a", 0)]);
    const c = ctx(r);
    const first = stateAt(r, r.segs[1].start + 20, c);
    expect(first.at).toBe("a");
    const later = stateAt(r, r.segs[1].end - 50, c);
    expect(later).toMatchObject({ at: "a", pose: "write" });
  });
  it("a far node is a cut, not a walk across the diagram", () => {
    const r = drawn([node("far", 3000)]);
    const st = stateAt(r, r.segs[1].start + 20, ctx(r));
    expect(CUT_DISTANCE).toBeLessThan(3000);
    expect(st.at).toBe("far");
  });
  it("reduced motion: to the place, no walking, no cut", () => {
    const r = drawn([node("a", 0), node("far", 3000)]);
    const st = stateAt(r, r.segs[2].start + 20, ctx(r, true));
    expect(st.at).toBe("far");
    expect(st.trip).toBeNull();
    expect(st.cut).toBeUndefined();
  });
  it("a node the page does not have any more (deleted): the figure stays where it is, nothing crashes", () => {
    const r = drawn([node("gone", 0)]);
    expect(() => stateAt(r, r.segs[1].start + 20, ctx(r))).not.toThrow();
  });
});
