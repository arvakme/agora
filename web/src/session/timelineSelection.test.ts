// The overview's selection (drag a stretch to look at it): where the pointer lands on it, dragging an
// edge, panning, clamping, keyboard steps, the same selection in either projection, and a selection
// whose right edge rides along with new records.
import { describe, expect, it } from "vitest";
import { HANDLE_HIT, caption, contains, count, domainOf, dragEdge, edgeX, keepTurns, panSel, partAt, posAtX, range, recordAtX, selectBetween, selectFrom, stepEdge, turnsOf } from "./timelineSelection.ts";
import { layoutTimeline, xOf } from "./timelineLayout.ts";
import { convo, modelOf } from "./timelineFixture.ts";
import type { Item } from "./agents.ts";

const W = 600;
const seq = modelOf(convo(12, 8));
const dom = domainOf(seq);
const lay = layoutTimeline(seq, W);
const N = seq.spans.length;
const at = (p: number) => seq.spans[p].index;
const firstOf = (turn: number) => seq.spans.findIndex((s) => s.turn === turn);
const lastOf = (turn: number) => seq.spans.length - 1 - [...seq.spans].reverse().findIndex((s) => s.turn === turn);
/** x in the middle of record position p */
const mid = (p: number) => xOf(lay, seq.spans[p].start + 0.5);

describe("turning a pointer position into a record, and a stretch into a selection", () => {
  it("the record under x, clamped at both ends", () => {
    expect(posAtX(lay, dom, mid(17))).toBe(17);
    expect(posAtX(lay, dom, -50)).toBe(0);
    expect(posAtX(lay, dom, W + 50)).toBe(N - 1);
  });
  it("two positions make a selection in either order, by record index", () => {
    const a = selectBetween(dom, 30, 12);
    expect(a).toEqual({ from: at(12), to: at(30), tail: false });
    expect(count(dom, a)).toBe(19);
    expect(range(dom, a)).toEqual([12, 30]);
  });
  it("reaching the last record pins the right edge to the newest", () => {
    expect(selectBetween(dom, 40, N - 1).tail).toBe(true);
    expect(selectBetween(dom, 40, N - 2).tail).toBe(false);
  });
  it("membership, turns and the caption the badge shows", () => {
    const s = selectBetween(dom, firstOf(3), lastOf(5));
    expect(contains(dom, s, at(firstOf(3)))).toBe(true);
    expect(contains(dom, s, at(lastOf(5)))).toBe(true);
    expect(contains(dom, s, at(firstOf(3) - 1))).toBe(false);
    expect(contains(dom, s, at(lastOf(5) + 1))).toBe(false);
    expect(turnsOf(dom, s)).toEqual([3, 5]);
    expect(caption(dom, s)).toBe(`第 3–5 轮 · ${count(dom, s)} 条`);
    expect(caption(dom, selectBetween(dom, firstOf(4) + 1, firstOf(4) + 3))).toBe("第 4 轮 · 3 条");
    expect([...keepTurns(dom, s)].sort((a, b) => a - b)).toEqual([3, 4, 5]);
  });
});

describe("where the pointer lands on a selection", () => {
  const s = selectBetween(dom, 20, 50);
  const [x0, x1] = edgeX(lay, dom, s);
  it("the edges sit at the records' own positions", () => {
    expect(x0).toBeCloseTo(xOf(lay, seq.spans[20].start), 6);
    expect(x1).toBeCloseTo(xOf(lay, seq.spans[50].end), 6);
  });
  it("an edge is at least 10 px to grab, on both sides of the line", () => {
    expect(HANDLE_HIT).toBeGreaterThanOrEqual(10);
    expect(partAt(lay, dom, s, x0)).toBe("left");
    expect(partAt(lay, dom, s, x0 - HANDLE_HIT / 2 + 0.1)).toBe("left");
    expect(partAt(lay, dom, s, x0 + HANDLE_HIT / 2 - 0.1)).toBe("left");
    expect(partAt(lay, dom, s, x1 + HANDLE_HIT / 2 - 0.1)).toBe("right");
    expect(partAt(lay, dom, s, x1 - HANDLE_HIT / 2 + 0.1)).toBe("right");
  });
  it("between the edges is the body, anywhere else is outside", () => {
    expect(partAt(lay, dom, s, (x0 + x1) / 2)).toBe("body");
    expect(partAt(lay, dom, s, x0 - HANDLE_HIT)).toBe("out");
    expect(partAt(lay, dom, s, x1 + HANDLE_HIT)).toBe("out");
    expect(partAt(lay, dom, null, 100)).toBe("out");
  });
  it("a selection narrower than two handles: the nearer edge wins, the body is what is left", () => {
    const tiny = selectBetween(dom, 30, 30);
    const [a, b] = edgeX(lay, dom, tiny);
    expect(partAt(lay, dom, tiny, a + 0.1)).toBe("left");
    expect(partAt(lay, dom, tiny, b - 0.1)).toBe("right");
  });
});

describe("dragging an edge", () => {
  const s = selectBetween(dom, 20, 50);
  it("moves that edge to the record under the pointer and leaves the other", () => {
    expect(range(dom, dragEdge(dom, s, "left", 10))).toEqual([10, 50]);
    expect(range(dom, dragEdge(dom, s, "right", 70))).toEqual([20, 70]);
  });
  it("cannot cross the other edge: it stops on it (one record is the smallest selection)", () => {
    expect(range(dom, dragEdge(dom, s, "left", 80))).toEqual([50, 50]);
    expect(range(dom, dragEdge(dom, s, "right", 3))).toEqual([20, 20]);
  });
  it("taking the right edge to the end pins it; taking it off the end frees it", () => {
    const pinned = dragEdge(dom, s, "right", N - 1);
    expect(pinned.tail).toBe(true);
    expect(dragEdge(dom, pinned, "right", N - 5).tail).toBe(false);
  });
});

describe("moving the whole selection", () => {
  const s = selectBetween(dom, 20, 50);
  /** the pointer went down on the selection's first record (position 20) and is now `delta` records on */
  const pan = (sel: ReturnType<typeof selectBetween>, delta: number) => panSel(dom, sel, at(20), 20 + delta);
  it("by a whole number of records, width unchanged", () => {
    expect(range(dom, pan(s, 7))).toEqual([27, 57]);
    expect(range(dom, pan(s, -7))).toEqual([13, 43]);
  });
  it("stops at the ends instead of squeezing", () => {
    expect(range(dom, pan(s, -500))).toEqual([0, 30]);
    expect(range(dom, pan(s, 5000))).toEqual([N - 31, N - 1]);
    expect(pan(s, 5000).tail).toBe(true);
    expect(pan(s, 5).tail).toBe(false);
  });
  it("a pinned selection panned left comes off the end; panned right it stays", () => {
    const pinned = selectBetween(dom, N - 20, N - 1);
    expect(pan(pinned, -3).tail).toBe(false);
    expect(pan(pinned, 3)).toEqual(pinned);
  });
});

describe("the keyboard: one record, or one turn", () => {
  const s = selectBetween(dom, firstOf(4) + 2, lastOf(6) - 2);
  it("← → on an edge moves it by one record, never across the other", () => {
    expect(range(dom, stepEdge(dom, s, "left", -1, "record"))[0]).toBe(firstOf(4) + 1);
    expect(range(dom, stepEdge(dom, s, "right", 1, "record"))[1]).toBe(lastOf(6) - 1);
    const one = selectBetween(dom, 10, 11);
    expect(range(dom, stepEdge(dom, one, "left", 1, "record"))).toEqual([11, 11]);
    expect(range(dom, stepEdge(dom, stepEdge(dom, one, "left", 1, "record"), "left", 1, "record"))).toEqual([11, 11]);
    expect(range(dom, stepEdge(dom, selectBetween(dom, 0, 5), "left", -1, "record"))[0]).toBe(0);
  });
  it("Shift+← → moves the left edge to a turn start, the right edge to a turn end", () => {
    expect(range(dom, stepEdge(dom, s, "left", -1, "turn"))[0]).toBe(firstOf(4)); // mid-turn: back to its start
    expect(range(dom, stepEdge(dom, selectBetween(dom, firstOf(4), 100), "left", -1, "turn"))[0]).toBe(firstOf(3)); // at a start: the one before
    expect(range(dom, stepEdge(dom, s, "left", 1, "turn"))[0]).toBe(firstOf(5));
    expect(range(dom, stepEdge(dom, s, "right", 1, "turn"))[1]).toBe(lastOf(6)); // mid-turn: to its end
    expect(range(dom, stepEdge(dom, selectBetween(dom, 0, lastOf(6)), "right", 1, "turn"))[1]).toBe(lastOf(7));
    expect(range(dom, stepEdge(dom, s, "right", -1, "turn"))[1]).toBe(lastOf(5));
  });
  it("the right edge reaching the end pins it", () => {
    expect(stepEdge(dom, selectBetween(dom, 0, N - 2), "right", 1, "record").tail).toBe(true);
    expect(stepEdge(dom, selectBetween(dom, 0, lastOf(12) - 3), "right", 1, "turn").tail).toBe(true);
  });
});

describe("the same records in the other projection", () => {
  const dur = modelOf(convo(12, 8), "duration");
  const d2 = domainOf(dur);
  const l2 = layoutTimeline(dur, W);
  const s = selectBetween(dom, firstOf(3), lastOf(5));
  it("the selection is kept as records, not as positions on an axis: same members, same caption", () => {
    for (const sp of seq.spans) expect(contains(d2, s, sp.index), `#${sp.index}`).toBe(contains(dom, s, sp.index));
    expect(caption(d2, s)).toBe(caption(dom, s));
  });
  it("the edges land where those records are in the new axis", () => {
    const [a, b] = edgeX(l2, d2, s);
    const first = dur.spans.find((x) => x.index === s.from)!;
    expect(a).toBeCloseTo(xOf(l2, first.start), 6);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThanOrEqual(W + 1e-6);
  });
});

describe("a pinned selection follows new records; an unpinned one stays", () => {
  const items = convo(12, 8);
  const more = convo(14, 8); // the same conversation, two turns later
  const d1 = domainOf(modelOf(items));
  const d2 = domainOf(modelOf(more));
  it("pinned: the right edge is the newest record of whatever there is now", () => {
    const pinned = selectBetween(d1, 30, d1.spans.length - 1);
    expect(range(d2, pinned)).toEqual([30, d2.spans.length - 1]);
    expect(count(d2, pinned)).toBeGreaterThan(count(d1, pinned));
  });
  it("not pinned: the same records as before", () => {
    const loose = selectBetween(d1, 30, 60);
    expect(range(d2, loose)).toEqual([30, 60]);
  });
  it("a selection naming records that are no longer there collapses onto what is", () => {
    const gone = { from: 99999, to: 100000, tail: false };
    const [p0, p1] = range(d1, gone);
    expect(p0).toBeLessThanOrEqual(p1);
    expect(p1).toBeLessThan(d1.spans.length);
  });
});

describe("tools that start in the same millisecond", () => {
  // #1 user, #2 a long Read and #3 a short one started together, #4 the reply: "实际时长" puts the short one first
  const parallel = (longDone: boolean): Item[] => [
    { id: "user", kind: "user", at: 1000, text: "read these", source: "agora" },
    { id: "long", kind: "tool", at: 2000, endAt: longDone ? 3000 : undefined, msg: "m1", tool: { name: "Read", input: "a", output: longDone ? "ok" : undefined } },
    { id: "short", kind: "tool", at: 2000, endAt: 2100, msg: "m1", tool: { name: "Read", input: "b", output: "ok" } },
    { id: "reply", kind: "assistant", at: 4000, text: "done" },
    { id: "end", kind: "end", at: 4100, durationMs: 3100, turn: "user" },
  ];
  const members = (d: ReturnType<typeof domainOf>, sel: ReturnType<typeof selectBetween>) => d.spans.map((x) => x.index).filter((i) => contains(d, sel, i)).sort((x, y) => x - y);
  const both = (items: Item[]) => ({ seq: domainOf(modelOf(items)), dur: domainOf(modelOf(items, "duration")) });

  it("the records picked on one axis are the same records, and the same caption, on the other", () => {
    const { seq: a, dur: b } = both(parallel(true));
    expect(b.spans.map((x) => x.index)).not.toEqual(a.spans.map((x) => x.index)); // the two axes really do order them differently
    const sel = selectBetween(a, 0, 2); // #1 – #3
    expect(members(a, sel)).toEqual([1, 2, 3]);
    expect(members(b, sel)).toEqual([1, 2, 3]);
    expect(caption(b, sel)).toBe(caption(a, sel));
  });
  it("picking on the duration axis takes everything the stretch covers, and keeps it on the other axis", () => {
    const { seq: a, dur: b } = both(parallel(true));
    const sel = selectBetween(b, 0, 1); // the user line and the short Read: the long Read lies after it on this axis, but it is #2
    expect(members(b, sel)).toEqual(members(a, sel));
    expect(contains(b, sel, 3)).toBe(true);
  });
  it("a tool's result arriving does not change who is selected", () => {
    const running = domainOf(modelOf(parallel(false), "duration"));
    const sel = selectBetween(running, 0, running.spans.findIndex((x) => x.index === 3));
    const before = members(running, sel);
    const done = domainOf(modelOf(parallel(true), "duration"));
    expect(members(done, sel)).toEqual(before);
    expect(before).toEqual([1, 2, 3]);
  });
});

describe("the pointer's way to a selection, when the axis orders concurrent records differently from the log", () => {
  // #2 #3 #4 start together at t=2000 and end 2800 / 2500 / 2200; "实际时长" lays them out #4 #3 #2 (shortest first); #5 starts at 3000
  const tool = (id: string, at: number, endAt: number, n: string) => ({ id, kind: "tool" as const, at, endAt, msg: "m", tool: { name: "Read", input: n, output: "ok" } });
  const items: Item[] = [
    { id: "u", kind: "user", at: 1000, text: "read files" },
    tool("a", 2000, 2800, "a"), tool("b", 2000, 2500, "b"), tool("c", 2000, 2200, "c"), tool("d", 3000, 3100, "d"),
    { id: "r", kind: "assistant", at: 4000, text: "done" },
  ];
  const model = modelOf(items, "duration");
  const d = domainOf(model);
  const lay = layoutTimeline(model, 600);
  const x = (index: number) => xOf(lay, (d.spans[d.pos.get(index)!].start + d.spans[d.pos.get(index)!].end) / 2);
  const only2 = { from: 2, to: 2, tail: false };

  it("the axis really orders them apart from the log", () => {
    expect(d.spans.map((s) => s.index)).toEqual([1, 4, 3, 2, 5, 6]);
  });
  it("dragging the body of a selection from record #2 onto #5 moves it to #5, however many places the axis puts between them", () => {
    const [x0] = edgeX(lay, d, only2);
    const anchor = recordAtX(lay, d, x0 + 1);
    expect(anchor).toBe(2);
    const moved = panSel(d, only2, anchor, posAtX(lay, d, x(5)));
    expect(moved).toEqual({ from: 5, to: 5, tail: false });
  });
  it("dragging out a new selection from #2 to #5 covers the records between them in the log, #2 to #5", () => {
    const sel = selectFrom(d, recordAtX(lay, d, x(2)), posAtX(lay, d, x(5)));
    expect([sel.from, sel.to]).toEqual([2, 5]);
  });
  it("the anchor is a record: a result that re-orders the axis mid-drag does not move the drag's start", () => {
    const before = recordAtX(lay, d, x(2));
    const settled = modelOf(items.map((it) => (it.id === "a" ? { ...it, endAt: 2100 } : it)), "duration"); // #2 turns out to be the shortest: the axis re-orders
    const d2 = domainOf(settled);
    expect(d2.spans.map((s) => s.index)).not.toEqual(d.spans.map((s) => s.index));
    const at5 = posAtX(layoutTimeline(settled, 600), d2, xOf(layoutTimeline(settled, 600), d2.spans[d2.pos.get(5)!].start + 1));
    expect(panSel(d2, only2, before, at5)).toEqual({ from: 5, to: 5, tail: false });
  });
});
