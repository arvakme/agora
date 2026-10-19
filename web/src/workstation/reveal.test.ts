// 分站揭示 (web/docs/workstation.md §2 智能体改图): an agent's batch appears on the page station by station, as the figure gets to each stop.
// The schedule (./runs/touch.ts `edit.reveal` / `edit.land`) and when each element shows (./reveal.ts). Pure, time series.
import { describe, expect, it } from "vitest";
import { LAND_LEAD_MS } from "../buildreplay/plan.ts";
import { BUDGET_MS, mergeTouches, planTouch, type Touch } from "./runs/touch.ts";
import type { WorkRun } from "./runs/types.ts";
import { elementTimes, holds, nodeTimes, REVEAL_CAP_MS, REVEAL_FADE_MS, REVEAL_MIN, shownAt, stationsOf, stopsOf, stopTime, type RevealEl } from "./reveal.ts";

const T0 = 1_800_000_000_000;
const node = (id: string, x: number, y = 0) => ({ id, x, y });
const touch = (over: Partial<Touch> & Pick<Touch, "nodes">): Touch => ({ session: "s1", canvas: "c1", at: T0, until: T0, say: "改图", ...over });
const run = (t: Touch[]): WorkRun => mergeTouches({ id: "s1", agent: "pi", name: "Pi", sessionId: "s1", segs: [], receipts: [], running: true, lastAt: T0, children: [] }, t);
const rect = (id: string, x: number, y = 0, o: Partial<RevealEl> = {}): RevealEl => ({ id, type: "rectangle", x: x - 50, y: y - 20, width: 100, height: 40, ...o });

describe("the stops say what appears when", () => {
  it("each stop reveals its own nodes, a little after the figure is planned to get there (the build replay's LAND_LEAD_MS)", () => {
    const segs = planTouch(touch({ nodes: [node("a", 0), node("b", 100), node("c", 1500)] }), T0);
    expect(segs.map((g) => g.edit!.reveal)).toEqual([["a", "b"], ["c"]]);
    for (const g of segs) {
      expect(g.edit!.land).toBeGreaterThan(g.start + LAND_LEAD_MS);
      expect(g.edit!.land).toBeLessThan(g.end);
    }
    expect(segs[1].edit!.land).toBeGreaterThan(segs[0].end); // the second station comes after the first one's work, not with the batch
  });
  it("stations the budget had no stop for come with the next stop the figure makes: every node is revealed once, in order, within the budget", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`, (i % 6) * 1200, Math.floor(i / 6) * 1200));
    const segs = planTouch(touch({ nodes }), T0);
    const all = segs.flatMap((g) => g.edit!.reveal!);
    expect(all.sort()).toEqual(nodes.map((n) => n.id).sort());
    expect(segs.length).toBeLessThan(nodes.length); // every node is its own slice here (1200 apart > REACH_PX): most have no stop of their own
    expect(Math.max(...segs.map((g) => g.edit!.land!)) - T0).toBeLessThanOrEqual(BUDGET_MS);
  });
  it("a change far behind the one before is one stop: it reveals everything there", () => {
    const segs = planTouch(touch({ nodes: [node("z", 0), node("w", 6000)] }), T0 + 9000, undefined, true);
    expect(segs).toHaveLength(1);
    expect(segs[0].edit!.reveal!.sort()).toEqual(["w", "z"]);
  });
  it("stopsOf reads them off the runs (children too), from the batch on, in order", () => {
    const r = run([touch({ nodes: [node("a", 0), node("b", 2000)] })]);
    const parent: WorkRun = { ...r, id: "boss", segs: [], children: [{ ...r, parentId: "boss" }] };
    const stops = stopsOf([parent], "c1", T0);
    expect(stops.map((s) => s.nodes)).toEqual([["a"], ["b"]]);
    expect(stopsOf([parent], "other", T0)).toEqual([]);
    expect(stopsOf([parent], "c1", T0 + 60_000)).toEqual([]);
  });
});

describe("stopTime: in step with the figure", () => {
  const s = { land: T0 + 3000, end: T0 + 5000 };
  it("seen arriving: LAND_LEAD_MS later; on its way: not before it gets there (the stop's end for now); not watched: the plan", () => {
    expect(stopTime(s, T0 + 2000)).toBe(T0 + 2000 + LAND_LEAD_MS);
    expect(stopTime(s, "walking")).toBe(s.end);
    expect(stopTime(s, undefined)).toBe(s.land);
  });
  it("never after the stop's work is over (a figure held up does not hold the picture past its own stop)", () => {
    expect(stopTime(s, T0 + 4900)).toBe(s.end);
  });
});

describe("elementTimes: each element of the batch with its station", () => {
  const els = new Map<string, RevealEl>(
    [
      rect("a", 0),
      rect("b", 1000),
      { id: "a-t", type: "text", x: 0, y: 0, width: 10, height: 10, containerId: "a" },
      { id: "ab", type: "arrow", x: 0, y: 0, width: 1000, height: 0, startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
      { id: "ab-t", type: "text", x: 500, y: 0, width: 10, height: 10, containerId: "ab" },
      { id: "old-b", type: "arrow", x: 0, y: 0, width: 1000, height: 0, startBinding: { elementId: "old" }, endBinding: { elementId: "b" } },
      rect("old", -800),
      { id: "note", type: "text", x: 980, y: 80, width: 40, height: 20 },
      { id: "deco", type: "line", x: -10, y: -10, width: 5, height: 5, groupIds: ["g1"] },
      rect("a2", 50, 0, { groupIds: ["g1"] }),
      rect("lost", 3000),
    ].map((e) => [e.id, e]),
  );
  const held = { canvas: "c1", at: T0, ids: ["a", "b", "a-t", "ab", "ab-t", "old-b", "note", "deco", "a2", "lost"] };
  const nodeAt = new Map([["a", T0 + 2000], ["a2", T0 + 2000], ["b", T0 + 5000]]);
  const t = elementTimes(held, els, nodeAt);
  it("a node at its stop, its text with it", () => {
    expect(t.get("a")).toBe(T0 + 2000);
    expect(t.get("a-t")).toBe(T0 + 2000);
    expect(t.get("b")).toBe(T0 + 5000);
  });
  it("an arrow once both its ends are there (the later station), its label with it; an end that was there before does not hold it", () => {
    expect(t.get("ab")).toBe(T0 + 5000);
    expect(t.get("ab-t")).toBe(T0 + 5000);
    expect(t.get("old-b")).toBe(T0 + 5000);
  });
  it("a free note with the nearest new node; a part of a group with the group's node", () => {
    expect(t.get("note")).toBe(T0 + 5000);
    expect(t.get("deco")).toBe(T0 + 2000);
  });
  it("a node no stop names (its stop gave way to a later change) shows at once", () => {
    expect(t.get("lost")).toBe(T0);
  });
  it("never later than REVEAL_CAP_MS after the batch, never before it", () => {
    const late = elementTimes({ ...held, ids: ["a"] }, els, new Map([["a", T0 + 60_000]]));
    expect(late.get("a")).toBe(T0 + REVEAL_CAP_MS);
    const early = elementTimes({ ...held, ids: ["a"] }, els, new Map([["a", T0 - 60_000]]));
    expect(early.get("a")).toBe(T0);
  });
  it("only reads the elements: the scene (and the file saved from it) is never touched", () => {
    const frozen = new Map([...els].map(([k, v]) => [k, Object.freeze({ ...v })]));
    const before = JSON.stringify([...frozen.values()]);
    expect(() => elementTimes(held, frozen, nodeAt)).not.toThrow();
    expect(JSON.stringify([...frozen.values()])).toBe(before);
    expect([...frozen.values()].every((e) => !("opacity" in e))).toBe(true);
  });
  it("nodeTimes: a node at the first stop that reveals it", () => {
    const m = nodeTimes(
      [
        { key: "1", run: "r", seg: {} as never, nodes: ["a"], land: T0 + 1000, end: T0 + 2000 },
        { key: "2", run: "r", seg: {} as never, nodes: ["a", "b"], land: T0 + 3000, end: T0 + 4000 },
      ],
      (s) => s.land,
    );
    expect([...m]).toEqual([["a", T0 + 1000], ["b", T0 + 3000]]);
  });
});

describe("when a batch is held at all", () => {
  it("held: enough new elements over two stations or more, figures on, motion allowed", () => {
    expect(holds({ count: 20, stations: 3, reduced: false, figures: true })).toBe(true);
  });
  it("as it always was (all at once): reduced motion, figures off, a small batch, a single station", () => {
    expect(holds({ count: 20, stations: 3, reduced: true, figures: true })).toBe(false);
    expect(holds({ count: 20, stations: 3, reduced: false, figures: false })).toBe(false);
    expect(holds({ count: REVEAL_MIN - 1, stations: 2, reduced: false, figures: true })).toBe(false);
    expect(holds({ count: 20, stations: 1, reduced: false, figures: true })).toBe(false);
    expect(REVEAL_MIN).toBe(3);
  });
  it("stations are the distinct moments after the batch", () => {
    expect(stationsOf(new Map([["a", T0], ["b", T0 + 10], ["c", T0 + 10], ["d", T0 + 20]]), T0)).toEqual([T0 + 10, T0 + 20]);
  });
});

describe("shownAt: the fade-in", () => {
  it("hidden before its moment, in over REVEAL_FADE_MS (the figure's own APPEAR_MS), then there", () => {
    expect(shownAt(T0, T0 - 1)).toBe(0);
    expect(shownAt(T0, T0 + REVEAL_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(shownAt(T0, T0 + REVEAL_FADE_MS)).toBe(1);
    expect(shownAt(-Infinity, T0)).toBe(1); // past the cap
  });
});

