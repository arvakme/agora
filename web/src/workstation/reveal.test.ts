// 分站揭示 (web/docs/workstation.md §2 智能体改图): an agent's batch appears on the page station by station, as the figure gets to each stop.
// The schedule (./runs/touch.ts `edit.reveal` / `edit.land`) and when each element shows (./reveal.ts). Pure, time series.
import { describe, expect, it } from "vitest";
import { LAND_LEAD_MS } from "../buildreplay/plan.ts";
import { BUDGET_MS, mergeTouches, planTouch, type Touch } from "./runs/touch.ts";
import type { WorkRun } from "./runs/types.ts";
import { BOX_GAP_MS, BOX_GAP_TOTAL_MS, BOX_MS, elementTimes, GROUP_MS, inkUnits, TEXT_WRITE_MS, unitWindows, FILL_FADE_MS, holds, inkAt, inkPlan, LINE_GAP_MS, LINE_MS, MIN_SQUEEZE, nodeTimes, REVEAL_CAP_MS, REVEAL_FADE_MS, REVEAL_MIN, REVEAL_SETTLE_MS, shownAt, stationsOf, stopsOf, stopTime, TEXT_MS, type RevealEl } from "./reveal.ts";

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

describe("inkPlan: a station is drawn as a hand would", () => {
  const { steps, length } = inkPlan(["box", "box", "line", "box", "line"]);
  const boxes = steps.filter((s) => s.kind === "box");
  const lines = steps.filter((s) => s.kind === "line");
  it("a box: outline over BOX_MS from the station's moment, then its fill, then its text", () => {
    expect(boxes[0]).toMatchObject({ start: 0, dur: BOX_MS, fill: BOX_MS });
    expect(boxes[0].text).toBeGreaterThan(boxes[0].fill);
    expect(inkAt(boxes[0], BOX_MS / 2)).toMatchObject({ fill: 0, text: 0 });
    const mid = inkAt(boxes[0], BOX_MS / 2).stroke;
    expect(mid).toBeGreaterThan(0.5); // eased out, the arrows' easing
    expect(mid).toBeLessThan(1);
    expect(inkAt(boxes[0], BOX_MS + FILL_FADE_MS).fill).toBe(1);
    expect(inkAt(boxes[0], boxes[0].text + TEXT_MS).text).toBe(1);
  });
  it("the boxes one after another, a little apart, in scene order", () => {
    expect(boxes.map((s) => s.start)).toEqual([0, BOX_GAP_MS, 2 * BOX_GAP_MS]);
  });
  it("arrows start only once every box of the station has its outline; then one after another; the head as the stroke ends, the label after", () => {
    const outlined = Math.max(...boxes.map((s) => s.start + s.dur));
    expect(Math.min(...lines.map((s) => s.start))).toBe(outlined);
    expect(lines[1].start - lines[0].start).toBe(LINE_GAP_MS);
    expect(lines[0].dur).toBe(LINE_MS);
    const l = lines[0];
    expect(inkAt(l, l.start + LINE_MS / 2)).toMatchObject({ fill: 0, text: 0 });
    expect(inkAt(l, l.start + LINE_MS).fill).toBe(1);
    expect(inkAt(l, l.start + LINE_MS).text).toBe(0);
    expect(inkAt(l, l.start + LINE_MS + TEXT_MS).text).toBe(1);
    expect(length).toBe(lines[1].text + TEXT_MS);
  });
  it("only lines (their ends drawn at earlier stations): drawn from the start", () => {
    expect(inkPlan(["line", "line"]).steps[0].start).toBe(0);
  });
  it("many components and lines: the gaps shrink so a full station stays within REVEAL_SETTLE_MS", () => {
    const big = inkPlan([...Array(30).fill("group"), ...Array(30).fill("line")]);
    expect(big.length).toBeCloseTo(REVEAL_SETTLE_MS);
    expect(big.steps[29].start).toBeCloseTo(BOX_GAP_TOTAL_MS);
  });
  it("a short stop squeezes the station into the time the figure stays (never below MIN_SQUEEZE); a long one does not stretch it", () => {
    const natural = inkPlan(["box", "box", "line"]);
    const short = inkPlan(["box", "box", "line"], natural.length / 4);
    expect(short.length).toBeCloseTo(natural.length * MIN_SQUEEZE);
    const fits = inkPlan(["box", "box", "line"], natural.length * 0.8);
    expect(fits.length).toBeCloseTo(natural.length * 0.8);
    expect(fits.steps[2].start / natural.steps[2].start).toBeCloseTo(0.8);
    expect(inkAt(fits.steps[0], fits.steps[0].dur).stroke).toBe(1);
    expect(inkPlan(["box"], 60_000).length).toBe(inkPlan(["box"]).length);
  });
  it("a fade (nothing it holds could be drawn) takes a box's place and fades in linearly", () => {
    const [f] = inkPlan(["fade"]).steps;
    expect(inkAt(f, BOX_MS / 2).stroke).toBeCloseTo(0.5);
  });
  it("a component (a group) is drawn in GROUP_MS however many elements it has, then its fills, then its text; arrows wait for it", () => {
    const { steps } = inkPlan(["group", "box", "line"]);
    expect(steps[0]).toMatchObject({ start: 0, dur: GROUP_MS, fill: GROUP_MS });
    expect(steps[0].text).toBeGreaterThan(steps[0].fill);
    expect(steps[2].start).toBe(GROUP_MS); // the box started later but finishes sooner: the arrow waits for the longest
    expect(steps[1].start + steps[1].dur).toBeLessThan(GROUP_MS);
  });
  it("a text on its own is written from its moment over TEXT_WRITE_MS (nothing to wait for), in a box's place", () => {
    const { steps } = inkPlan(["box", "text"]);
    expect(steps[1]).toMatchObject({ start: BOX_GAP_MS, text: BOX_GAP_MS, textDur: TEXT_WRITE_MS });
    expect(inkAt(steps[1], BOX_GAP_MS + TEXT_WRITE_MS / 2).text).toBeCloseTo(0.5);
    expect(inkAt(steps[0], steps[0].text + TEXT_MS / 2).text).toBeCloseTo(0.5); // a box's text: written, not faded
  });
});

describe("inkUnits: what is drawn as one", () => {
  const el = (id: string, type: string, more: Partial<RevealEl> = {}): RevealEl => ({ id, type, x: 0, y: 0, width: 10, height: 10, groupIds: [], ...more });
  it("an element on its own is a unit of its kind; a text bound to one of them goes with it", () => {
    const u = inkUnits([el("a", "rectangle"), el("t", "text", { containerId: "a" }), el("b", "arrow"), el("c", "text"), el("d", "freedraw"), el("e", "image"), el("f", "frame")]);
    expect(u).toEqual([
      { kind: "box", ids: ["a"] },
      { kind: "line", ids: ["b"] },
      { kind: "text", ids: ["c"] },
      { kind: "box", ids: ["d"] },
      { kind: "box", ids: ["e"] },
      { kind: "box", ids: ["f"] },
    ]);
  });
  it("a group (a library component: its root box, its lines, its caption) is one unit, by its outermost group, in scene order", () => {
    const u = inkUnits([el("root", "rectangle", { groupIds: ["outer"] }), el("x", "rectangle"), el("l1", "line", { groupIds: ["inner", "outer"] }), el("cap", "text", { groupIds: ["outer"] })]);
    expect(u).toEqual([
      { kind: "group", ids: ["root", "l1", "cap"] },
      { kind: "box", ids: ["x"] },
    ]);
  });
  it("a text bound to something not in the station is a text of its own", () => {
    expect(inkUnits([el("t", "text", { containerId: "elsewhere" })])).toEqual([{ kind: "text", ids: ["t"] }]);
  });
});

describe("unitWindows: a component's elements one after another, overlapping", () => {
  it("one element: all of the unit's time", () => {
    expect(unitWindows([50])).toEqual([[0, 1]]);
  });
  it("in order, by length, each over a share that shrinks with their number (never under a quarter), all within the unit", () => {
    const w = unitWindows([100, 100, 200, 0]);
    expect(w.map(([a]) => a)).toEqual([...w.map(([a]) => a)].sort((a, b) => a - b));
    for (const [a, b] of w) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1 + 1e-9);
      expect(b - a).toBeCloseTo(0.5); // 1 / sqrt(4)
    }
    expect(w[3][1]).toBeLessThan(1); // an element with nothing to draw still has a place, a short one
    const many = unitWindows(Array(400).fill(10));
    expect(many[0][1] - many[0][0]).toBe(0.25);
    expect(many[399][1]).toBeCloseTo(1, 2);
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

