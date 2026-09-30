// 精简 / 逐步 (./plan.ts `Mode`, web/docs/share-build-replay.md §9): on real diagrams the brief replay walks less than half as far and takes less than half
// as long, and shows the same things in the same order. The three fixtures are diagrams from real projects, geometry only (their words are left out):
// one agent's recorded 24 changes over three canvases, a smaller recorded history, and a whole diagram drawn in one change.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene";
import { geometryWalk } from "./geometryWalk";
import { walkStats } from "./measure";
import { HOP_MS, planBuild, REACH_PX, runsOf, Scenes, type Beat, type Mode, type Plan } from "./plan";
import { CUT_MS } from "../workstation/place";
import type { BuildItem, BuildStep, BuildTimeline } from "./types";

const NAMES = ["agent-history", "demo-history", "whole-diagram-in-one-change"] as const;
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as BuildTimeline;
const plans = (tl: BuildTimeline): Record<Mode, Plan> => {
  const g = geometryWalk(tl);
  return { steps: planBuild(tl, { ...g, mode: "steps" }), brief: planBuild(tl, { ...g, mode: "brief" }) };
};

describe.each(NAMES)("%s", (name) => {
  const tl = load(name);
  const p = plans(tl);
  const steps = walkStats(p.steps, tl);
  const brief = walkStats(p.brief, tl);

  it("brief walks less than half as far, for less than half as long, and the whole replay is less than half as long", () => {
    const walked = (w: ReturnType<typeof walkStats>) => w.px.all;
    expect(walked(steps)).toBeGreaterThan(0);
    expect(walked(brief)).toBeLessThanOrEqual(walked(steps) / 2);
    expect(brief.ms.all).toBeLessThanOrEqual(steps.ms.all / 2);
    expect(p.brief.length).toBeLessThanOrEqual(p.steps.length / 2);
  });

  it("brief has no walk for nothing: none within reach, none it cut instead of walking that is short", () => {
    expect(brief.count.near).toBe(0);
    for (const b of p.brief.beats.filter((x) => x.hop)) expect(b.dist).toBeGreaterThan(0);
    for (const b of p.brief.beats.filter((x) => !x.hop && x.walkMs > 0 && x.fromCanvas === x.canvas)) expect(b.walkMs).toBeLessThanOrEqual(HOP_MS);
  });

  it("shows the same things in the same order: the beats are the same, and their steps never go back", () => {
    const key = (b: Beat) => `${b.step}|${b.canvas}|${b.kind}|${b.say}`;
    // within one step the order may differ (nearest first), so compare as a set per step; across steps the order is the timeline's
    const group = (plan: Plan) => {
      const by = new Map<number, string[]>();
      for (const b of plan.beats) by.set(b.step, [...(by.get(b.step) ?? []), key(b)]);
      return [...by].map(([s, ks]) => [s, ks.sort()]);
    };
    expect(group(p.brief)).toEqual(group(p.steps));
    for (const plan of [p.steps, p.brief]) expect(plan.beats.every((b, i) => i === 0 || b.step >= plan.beats[i - 1].step)).toBe(true);
  });

  it.each(["steps", "brief"] as const)("%s: a line lands only once the nodes it joins are there, and a sub-diagram is drawn in only after its node opens it", (mode) => {
    const plan = p[mode];
    const scenes = new Scenes(tl, plan);
    for (const b of plan.beats) {
      if (b.kind !== "add-arrows") continue;
      const there = new Set(scenes.at(b.canvas, b.land).map((e) => e.id));
      for (const e of b.add as (El & { startBinding?: { elementId?: string } | null; endBinding?: { elementId?: string } | null })[])
        for (const id of [e.startBinding?.elementId, e.endBinding?.elementId]) if (id) expect(there.has(id), `${e.id} → ${id}`).toBe(true);
    }
    const opened = new Map<string, number>(); // canvas → when the node that opens it did
    for (const b of plan.beats) if (b.kind === "expand" && b.child) opened.set(b.child, Math.min(opened.get(b.child) ?? Infinity, b.land));
    for (const b of plan.beats) if (opened.has(b.canvas)) expect(b.land).toBeGreaterThanOrEqual(opened.get(b.canvas)!);
  });

  it("brief: what is drawn from where the figure stands is within reach of it; everything that walks is a trip the figure really makes", () => {
    const at = new Map<string, { x: number; y: number }>();
    for (const [c, els] of Object.entries(tl.start)) for (const e of els) at.set(`${c}/${e.id}`, { x: e.x + e.width / 2, y: e.y + e.height / 2 });
    for (const s of tl.steps) for (const it of s.items) for (const e of [...(it.add ?? []), ...(it.change ?? [])]) at.set(`${s.canvas}/${e.id}`, { x: e.x + e.width / 2, y: e.y + e.height / 2 });
    const stand = new Map<string, string | null>();
    for (const b of p.brief.beats) {
      const from = stand.get(b.actor) ?? null;
      if (b.reach && b.place && from && b.fromCanvas === b.canvas && b.place !== from) {
        const a = at.get(`${b.canvas}/${from}`)!;
        const near = [b.place, ...b.add.flatMap((e) => [(e as never as { startBinding?: { elementId?: string } }).startBinding?.elementId, (e as never as { endBinding?: { elementId?: string } }).endBinding?.elementId])].filter(Boolean) as string[];
        expect(Math.min(...near.map((id) => at.get(`${b.canvas}/${id}`)).filter(Boolean).map((c) => Math.hypot(c!.x - a.x, c!.y - a.y)))).toBeLessThanOrEqual(REACH_PX);
      }
      if (b.at) stand.set(b.actor, b.at);
    }
  });

  it("one figure per actor for the whole replay; a hop is a call marked `cut` (the figure fades in where it goes while it fades out where it was: ../workstation/place.ts), step by step has none", () => {
    for (const mode of ["steps", "brief"] as const) {
      const runs = runsOf(p[mode], 0);
      expect(runs.map((r) => r.id).sort()).toEqual(p[mode].actors.map((a) => `build:${a.key}`).sort());
    }
    const cuts = runsOf(p.brief, 0).flatMap((r) => r.segs.filter((g) => g.cut));
    expect(cuts).toHaveLength(p.brief.beats.filter((b) => b.hop).length);
    expect(runsOf(p.steps, 0).flatMap((r) => r.segs).some((g) => g.cut)).toBe(false);
  });

  it("a hop takes about a cut's time (CUT_MS) and no walk: it does not add time back", () => {
    for (const b of p.brief.beats.filter((x) => x.hop)) {
      expect(b.walkMs).toBe(0);
      expect(b.land - b.start).toBeLessThanOrEqual(CUT_MS + 250);
    }
  });
});

// ——— small cases ———
const node = (id: string, x: number, y = 0): El[] => [
  { id, type: "rectangle", x, y, width: 160, height: 64, index: id, isDeleted: false, boundElements: [] } as unknown as El,
];
const claude = { kind: "agent", agent: "claude", name: "Claude Code" } as const;
const addNode = (id: string, x: number, y = 0): BuildItem => ({ kind: "add-node", say: `加了节点 ${id}`, place: id, ids: [id], quiet: false, add: node(id, x, y) });
const line = (id: string, from: string, to: string): BuildItem => ({
  kind: "add-arrows",
  say: `连了 ${from} → ${to}`,
  place: from,
  ids: [id],
  quiet: false,
  add: [{ id, type: "arrow", x: 0, y: 0, width: 10, height: 0, index: id, isDeleted: false, startBinding: { elementId: from }, endBinding: { elementId: to } } as unknown as El],
});
const step = (i: number, items: BuildItem[]): BuildStep => ({ i, at: i, until: i, canvas: "c1", actor: claude, items });
const tlOf = (steps: BuildStep[]): BuildTimeline => ({ format: "agora-build-timeline", version: 1, root: "c1", canvases: { c1: { title: "", parent: null } }, start: { c1: [] }, steps, sources: { changes: steps.length, yourSteps: 0, unseenEdits: 0, steps: steps.length, dropped: 0 } });
const far = (x: number) => x; // readable positions

describe("the brief planner", () => {
  it("draws what is within reach from where it stands, walks to what is not, and pulls a line from the node it leaves without going to the other end", () => {
    const tl = tlOf([step(0, [addNode("a", far(0)), addNode("b", far(300)), line("ab", "a", "b"), addNode("c", far(3000)), line("bc", "b", "c")])]);
    const brief = planBuild(tl, { mode: "brief", walk: () => 1500 });
    const by = Object.fromEntries(brief.beats.map((b) => [b.say, b]));
    expect(by["加了节点 b"]).toMatchObject({ reach: true, walkMs: 0 }); // 300 px: a body away, no walk
    expect(by["连了 a → b"]).toMatchObject({ reach: true, walkMs: 0 });
    expect(by["加了节点 c"]).toMatchObject({ reach: false, walkMs: 1500 }); // far: the figure walks there…
    expect(by["连了 b → c"].reach).toBe(true); // …and pulls the line to c from where it stands (c is within reach of the stance)
    const steps = planBuild(tl, { mode: "steps", walk: () => 1500 });
    expect(steps.beats.filter((b) => b.walkMs > 0).length).toBeGreaterThan(brief.beats.filter((b) => b.walkMs > 0).length);
  });

  it("stands where a run of things is drawn, once: the stance is the node they are all closest to", () => {
    const tl = tlOf([step(0, [addNode("a", 0), addNode("z", 5000), addNode("m1", 5000, 200), addNode("m2", 5300, 100), addNode("m3", 5100, 250)])]);
    const brief = planBuild(tl, { mode: "brief", walk: () => 1000 });
    const walks = brief.beats.filter((b) => !b.reach && b.from);
    expect(walks).toHaveLength(1);
    expect(["z", "m1", "m2", "m3"]).toContain(walks[0].at);
    expect(brief.beats.slice(1).every((b) => b.at === walks[0].at)).toBe(true);
  });

  it("cuts a walk that would take long instead of walking it, and shows the figure where the thing is drawn", () => {
    const tl = tlOf([step(0, [addNode("a", 0)]), step(1, [addNode("b", 6000)])]);
    const long = planBuild(tl, { mode: "brief", walk: () => HOP_MS + 1 });
    expect(long.beats[1]).toMatchObject({ hop: true, walkMs: 0, at: "b" });
    expect(runsOf(long, 0)).toHaveLength(1); // the same figure: it is cut across, not replaced
    expect(runsOf(long, 0)[0].segs.map((g) => !!g.cut)).toEqual([false, true]);
    expect(long.beats[1].land - long.beats[1].start).toBeLessThan(600);
    const short = planBuild(tl, { mode: "brief", walk: () => HOP_MS - 1 });
    expect(short.beats[1]).toMatchObject({ hop: false, walkMs: HOP_MS - 1 });
  });

  it("step by step is what it was: every walk is walked", () => {
    const tl = tlOf([step(0, [addNode("a", 0), addNode("b", 300)])]);
    const p = planBuild(tl, { mode: "steps", walk: () => 1200 });
    expect(p.beats[1]).toMatchObject({ walkMs: 1200, hop: false });
    expect(planBuild(tl, { walk: () => 1200 }).beats.map((b) => b.walkMs)).toEqual(p.beats.map((b) => b.walkMs)); // and it is the default of the planner
  });
});
