// 施工回放 (./plan.ts): a build timeline becomes beats on a clock of its own, the canvas as it was at any moment, and figures that
// walk to where each thing is drawn (the ordinary 工位视图 walking, on nodes standing for "files").
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene";
import { DOOR_MS } from "../workstation/rig";
import { stateAt, type Ctx } from "../workstation/place";
import { beatAt, beatOfStep, defaultSpeed, DWELL, SPEEDS, LAND_LEAD_MS, OPENING_MS, pathFor, planBuild, runsOf, Scenes, withPlaces } from "./plan";
import type { BuildItem, BuildStep, BuildTimeline } from "./types";

const node = (id: string, label: string, x: number, y: number, index = id): El[] => [
  { id, type: "rectangle", x, y, width: 120, height: 60, index, isDeleted: false, boundElements: [{ type: "text", id: `${id}-t` }] } as unknown as El,
  { id: `${id}-t`, type: "text", x, y, width: 10, height: 10, index: `${index}t`, isDeleted: false, containerId: id, text: label } as unknown as El,
];
const item = (kind: BuildItem["kind"], say: string, place: string | null, o: Partial<BuildItem> = {}): BuildItem => ({ kind, say, place, ids: [], quiet: false, ...o });
const claude = { kind: "agent", agent: "claude", name: "Claude Code" } as const;
const step = (i: number, canvas: string, items: BuildItem[], actor: BuildStep["actor"] = claude): BuildStep => ({ i, at: i * 1000, until: i * 1000, canvas, actor, items });

/** Two nodes and an arrow on c1, a link (quiet) run, a node inside the sub-diagram `be` that `b` opens, then the person deletes a node. */
function timeline(): BuildTimeline {
  const [a, at] = node("a", "前端", 0, 0);
  const [b, bt] = node("b", "后端", 400, 0);
  const [o, ot] = node("o", "订单", 0, 0);
  const arrow = { id: "ab", type: "arrow", x: 120, y: 30, width: 280, height: 0, index: "ab", isDeleted: false } as unknown as El;
  return {
    format: "agora-build-timeline",
    version: 1,
    root: "c1",
    canvases: { c1: { title: "总架构", parent: null }, be: { title: "后端", parent: { canvas: "c1", node: "b" } } },
    start: { c1: node("starter", "示例", 0, 300, "z"), be: [] },
    steps: [
      step(0, "c1", [item("add-node", "加了节点「前端」", "a", { add: [a, at] }), item("add-node", "加了节点「后端」", "b", { add: [b, bt] }), item("add-arrows", "连了 前端 → 后端", "a", { add: [arrow] })]),
      step(1, "c1", [item("link", "把「前端」关联到代码", "a", { quiet: true, change: [a] })]),
      step(2, "c1", [item("link", "把「后端」关联到代码", "b", { quiet: true, change: [b] })]),
      step(3, "be", [item("add-node", "加了节点「订单」", "o", { add: [o, ot] })]),
      step(4, "c1", [item("delete", "删掉了「前端」", "a", { remove: ["a", "a-t"] })], { kind: "you" }),
    ],
    sources: { changes: 4, yourSteps: 1, unseenEdits: 0, steps: 5, dropped: 0 },
  };
}

describe("planBuild", () => {
  const tl = timeline();
  const plan = planBuild(tl);

  it("one beat per thing done, a run of links is one beat, and they follow each other with the opening before the first", () => {
    expect(plan.beats.map((b) => [b.actor, b.canvas, b.kind, b.say])).toEqual([
      ["claude", "c1", "add-node", "加了节点「前端」"],
      ["claude", "c1", "add-node", "加了节点「后端」"],
      ["claude", "c1", "add-arrows", "连了 前端 → 后端"],
      ["claude", "c1", "tick", "把 2 个节点关联到代码"],
      ["claude", "be", "add-node", "加了节点「订单」"],
      ["you", "c1", "delete", "删掉了「前端」"],
    ]);
    expect(plan.beats[0].start).toBe(OPENING_MS);
    for (let i = 1; i < plan.beats.length; i++) expect(plan.beats[i].start).toBe(plan.beats[i - 1].end);
    expect(plan.length).toBe(plan.beats[plan.beats.length - 1].end + OPENING_MS);
    expect(plan.actors.map((a) => [a.key, a.name])).toEqual([["claude", "Claude Code"], ["you", "你"]]);
  });

  it("a beat is: set off, walk (none where the figure already stands), the canvas changes, the figure works a while", () => {
    const [first, second, third] = plan.beats;
    expect(first.land - first.start).toBe(LAND_LEAD_MS); // its first place: it is there from the start
    expect(second.land - second.start).toBeGreaterThan(LAND_LEAD_MS + 500); // 前端 → 后端: a walk of 400 px and more
    expect(third.land - third.start).toBeGreaterThan(second.land - second.start - 1); // back to 前端
    expect(first.end - first.land).toBe(DWELL["add-node"]);
    const quiet = plan.beats[3];
    expect(quiet.land - quiet.start).toBe(LAND_LEAD_MS); // no walking for links
  });

  it("into a sub-diagram costs a door each way of the way", () => {
    const into = plan.beats[4];
    expect(into.land - into.start).toBeGreaterThanOrEqual(DOOR_MS);
    const out = plan.beats[5]; // a different actor: its first place
    expect(out.land - out.start).toBeCloseTo(LAND_LEAD_MS, 6);
  });

  it("through the doors: to the entrance and up, to the node that opens the next canvas and down, then the last walk", () => {
    const calls: string[] = [];
    const opts = { walk: (c: string, f: string | null, t: string) => (calls.push(`${c}:${f}>${t}`), 1000), entrance: (c: string) => `${c}-gate` };
    const p = planBuild(tl, opts);
    // 前端(c1) → 订单(be): walk to 后端 (which opens be), down, walk from be's entrance
    const into = p.beats[4];
    expect(into.land - into.start).toBe(1000 + DOOR_MS + 1000 + LAND_LEAD_MS);
    expect(calls).toContain("c1:a>b");
    expect(calls).toContain("be:be-gate>o");
    // and back: be's 订单 → its entrance and up, then to 前端 on c1 — by another actor here (its first place: no walk)
    const back = planBuild({ ...tl, steps: [...tl.steps.slice(0, 4), { ...tl.steps[0], i: 4, items: [item("add-node", "又加了「前端」", "a", { add: node("a2", "又", 0, 0) })] }] }, opts);
    const last = back.beats[back.beats.length - 1];
    expect(last.land - last.start).toBe(1000 + DOOR_MS + 1000 + LAND_LEAD_MS);
    expect(calls).toContain("be:o>be-gate");
    expect(calls).toContain("c1:b>a");
  });

  it("the walk can be measured by whoever knows the geometry", () => {
    const p = planBuild(tl, { walk: () => 3000 });
    expect(p.beats[1].land - p.beats[1].start).toBe(3000 + LAND_LEAD_MS);
  });
});

describe("the order things are visited in", () => {
  // three nodes drawn at once, given far, near, middle: the figure standing at 0 takes the nearest first, each time
  const mk = (): BuildTimeline => {
    const [a, at] = node("a", "近", 100, 0);
    const [b, bt] = node("b", "中", 500, 0);
    const [c, ct] = node("c", "远", 900, 0);
    const [o, ot] = node("o", "起点", 0, 0);
    return {
      format: "agora-build-timeline",
      version: 1,
      root: "c1",
      canvases: { c1: { title: "总架构", parent: null } },
      start: { c1: [] },
      steps: [
        step(0, "c1", [item("add-node", "起点", "o", { add: [o, ot] })]),
        step(1, "c1", [item("add-node", "远", "c", { add: [c, ct] }), item("add-node", "近", "a", { add: [a, at] }), item("add-node", "中", "b", { add: [b, bt] })]),
      ],
      sources: { changes: 2, yourSteps: 0, unseenEdits: 0, steps: 2, dropped: 0 },
    };
  };
  it("a run of nodes drawn together is visited nearest first from where the figure stands", () => {
    expect(planBuild(mk()).beats.map((b) => b.say)).toEqual(["起点", "近", "中", "远"]);
  });
  it("two things, or a run of another kind, keep the order they were given in", () => {
    const t = mk();
    t.steps[1].items.pop();
    expect(planBuild(t).beats.map((b) => b.say)).toEqual(["起点", "远", "近"]);
  });
});

describe("defaultSpeed", () => {
  it("the slowest speed that shows the whole build in about a minute and a half", () => {
    expect(defaultSpeed(60_000)).toBe(1);
    expect(defaultSpeed(200_000)).toBe(4);
    expect(defaultSpeed(524_000)).toBe(8);
    expect(defaultSpeed(10 * 3600_000)).toBe(SPEEDS[SPEEDS.length - 1]);
  });
});

describe("beatAt", () => {
  const plan = planBuild(timeline());
  it("the beat going on; the first before the opening, the last after the end", () => {
    expect(beatAt(plan, 0)).toBe(plan.beats[0]);
    expect(beatAt(plan, plan.beats[2].start + 1)).toBe(plan.beats[2]);
    expect(beatAt(plan, plan.beats[2].end)).toBe(plan.beats[3]);
    expect(beatAt(plan, plan.length + 1e6)).toBe(plan.beats[plan.beats.length - 1]);
    expect(beatAt({ beats: [], length: 0, actors: [] }, 5)).toBeUndefined();
  });
});

describe("the canvas at a moment", () => {
  const tl = timeline();
  const plan = planBuild(tl);
  const scenes = new Scenes(tl, plan);
  const ids = (canvas: string, t: number) => scenes.at(canvas, t).map((e) => e.id);

  it("the picture before the first beat is the starting elements; each beat adds its own when the figure has got there", () => {
    expect(ids("c1", 0)).toEqual(["starter", "starter-t"]);
    expect(ids("c1", plan.beats[0].land - 1)).toEqual(["starter", "starter-t"]);
    expect(ids("c1", plan.beats[0].land)).toEqual(["a", "a-t", "starter", "starter-t"]);
    expect(ids("c1", plan.beats[2].land)).toContain("ab");
    expect(scenes.count("c1", plan.beats[2].land)).toBe(3);
  });

  it("bottom to top by Excalidraw's fractional index, and what is deleted goes", () => {
    const end = plan.length;
    expect(ids("c1", end)).toEqual(["ab", "b", "b-t", "starter", "starter-t"]); // 前端 was deleted by the person at the end
    expect(ids("be", end)).toEqual(["o", "o-t"]);
    expect(ids("be", plan.beats[4].land - 1)).toEqual([]);
  });
});

describe("the figures", () => {
  const tl = timeline();
  const plan = planBuild(tl);
  const EPOCH = 1_800_000_000_000;
  const runs = runsOf(plan, EPOCH);

  it("one run per actor; each beat a segment that says what it does, at the node it is done at", () => {
    expect(runs.map((r) => [r.id, r.agent, r.name])).toEqual([["build:claude", "claude", "Claude Code"], ["build:you", "you", "你"]]);
    const c = runs[0];
    expect(c.segs.map((s) => [s.say, s.path])).toEqual([
      ["加了节点「前端」", pathFor("c1", "a")],
      ["加了节点「后端」", pathFor("c1", "b")],
      ["连了 前端 → 后端", pathFor("c1", "a")],
      ["把 2 个节点关联到代码", undefined],
      ["加了节点「订单」", pathFor("be", "o")],
    ]);
    expect(c.segs[0].start).toBe(EPOCH + plan.beats[0].start);
    expect(c.segs[3].kind).toBe("think");
    expect(c.segs.every((s) => !/^\//.test(s.path ?? "") && !/[.]py|server\//.test(s.path ?? ""))).toBe(true); // no real file anywhere
  });

  it("nodes stand for files: each gets a code link to its own place, the words in them do not", () => {
    const els = withPlaces("c1", [...node("a", "前端", 0, 0), ...node("b", "后端", 400, 0)]);
    const [a, at] = els;
    expect((a.customData as { codePaths: string[] }).codePaths).toEqual([pathFor("c1", "a")]);
    expect(at.customData).toBeUndefined();
  });

  it("the figure is at the node, having walked there, when the canvas changes — with the ordinary walking (straight docks, no arrows)", () => {
    const dock = (place: string) => ({ a: { x: 60, y: 0 }, b: { x: 460, y: 0 } })[place] ?? { x: 0, y: 0 };
    const ctx: Ctx = { locate: (p) => (p === pathFor("c1", "a") ? { place: "a" } : p === pathFor("c1", "b") ? { place: "b" } : null), dock, reduced: false, run: (id) => runs.find((r) => r.id === id) };
    const c = runs[0];
    for (const b of plan.beats.slice(0, 3)) {
      const st = stateAt(c, EPOCH + b.land, ctx);
      expect(st.at, b.say).toBe(b.place);
      expect(st.w, b.say).toBe(1); // it has arrived
    }
  });

  it("links on different canvases are different beats: a canvas never draws another's elements", () => {
    const [x, xt] = node("x", "别处", 0, 0);
    const [y, yt] = node("y", "这里", 0, 0);
    const tl = timeline();
    tl.steps = [
      step(0, "c1", [item("link", "把「前端」关联到代码", "a", { quiet: true, change: [y, yt] })]),
      step(1, "be", [item("link", "把「订单」关联到代码", "o", { quiet: true, change: [x, xt] })]),
    ];
    const plan = planBuild(tl);
    expect(plan.beats.map((b) => b.canvas)).toEqual(["c1", "be"]);
    const scenes = new Scenes(tl, plan);
    expect(scenes.at("c1", plan.length).map((e) => e.id)).toEqual(["y", "y-t", "starter", "starter-t"]);
    expect(scenes.at("be", plan.length).map((e) => e.id)).toEqual(["x", "x-t"]);
  });

  it("the person's steps are the author's to a guest of a share, and \"你\" to the owner", () => {
    const tl = timeline();
    expect(planBuild(tl).actors.find((a) => a.key === "you")).toMatchObject({ agent: "you", name: "你" });
    expect(planBuild(tl, { author: true }).actors.find((a) => a.key === "you")).toMatchObject({ agent: "author", name: "作者" });
  });
});

describe("a comment's moment", () => {
  it("is the first beat of the step it names; a step past the end is the last beat", () => {
    const plan = planBuild(timeline());
    const b = beatOfStep(plan, plan.beats[3].step)!;
    expect(b.step).toBe(plan.beats[3].step);
    expect(plan.beats.filter((x) => x.step === b.step)[0]).toBe(b);
    expect(beatOfStep(plan, 999)).toBe(plan.beats.at(-1));
  });
});

