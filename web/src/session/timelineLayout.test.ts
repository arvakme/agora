// The trajectory overview's pure parts: kind → colour token and shape, turn bands and labels, a long
// conversation folded into a fixed width (older turns → density bars, hair-thin blocks → bands),
// where the pointer lands, and what a 0.5 s hover says.
import { describe, expect, it } from "vitest";
import {
  CLASSES,
  HEIGHT,
  LANE_H,
  TOP,
  hitTest,
  hoverText,
  labelledTurns,
  laneTop,
  MIN_BLOCK,
  layoutTimeline,
  lookOf,
  stepCursor,
  targetsInOrder,
  valueAt,
  xOf,
} from "./timelineLayout.ts";
import { convo, modelOf } from "./timelineFixture.ts";

describe("lookOf: kind → colour token, shape and lane", () => {
  const tool = (activity: NonNullable<ReturnType<typeof modelOf>["spans"][number]["activity"]>, isError = false) => lookOf({ kind: "tool", activity, isError });
  it("purple is only the assistant's message; the user is grey-blue", () => {
    expect(lookOf({ kind: "message", isError: false })).toMatchObject({ cls: "message", token: "--tl-message", fill: "solid", lane: 1 });
    expect(lookOf({ kind: "user", isError: false })).toMatchObject({ cls: "user", lane: 0 });
    const purple = CLASSES.filter((c) => lookOf(sample(c)).token === "--tl-message");
    expect(purple).toEqual(["message"]);
  });
  it("reading is outlined, editing is solid, a failure carries a cross", () => {
    for (const a of ["read", "search", "webSearch", "webFetch"] as const) expect(tool(a)).toMatchObject({ cls: "read", fill: "hollow", cross: false, lane: 2 });
    for (const a of ["write", "edit"] as const) expect(tool(a)).toMatchObject({ cls: "write", fill: "solid", cross: false });
    expect(tool("commands")).toMatchObject({ cls: "run", fill: "solid" });
    expect(tool("subagents")).toMatchObject({ cls: "agent", fill: "solid" });
    expect(tool("questions")).toMatchObject({ cls: "wait", lane: 0 });
    for (const a of ["plan", "tools"] as const) expect(tool(a)).toMatchObject({ cls: "other" });
    expect(tool("read", true)).toMatchObject({ cls: "fail", fill: "solid", cross: true, lane: 2 });
    expect(tool("commands", true).cls).toBe("fail");
    expect(lookOf({ kind: "message", isError: true }).cls).toBe("message"); // only a tool call fails
  });
  it("every class has its own colour token", () => {
    expect(new Set(CLASSES.map((c) => lookOf(sample(c)).token)).size).toBe(CLASSES.length);
  });
});
function sample(cls: (typeof CLASSES)[number]) {
  const map = {
    user: { kind: "user", isError: false },
    message: { kind: "message", isError: false },
    read: { kind: "tool", activity: "read", isError: false },
    write: { kind: "tool", activity: "edit", isError: false },
    run: { kind: "tool", activity: "commands", isError: false },
    agent: { kind: "tool", activity: "subagents", isError: false },
    wait: { kind: "tool", activity: "questions", isError: false },
    other: { kind: "tool", activity: "tools", isError: false },
    fail: { kind: "tool", activity: "read", isError: true },
  } as const;
  return map[cls];
}

describe("a short conversation: every action a block, turns banded and numbered", () => {
  const model = modelOf(convo(8, 6));
  const lay = layoutTimeline(model, 640);
  it("one block per record, none folded, every turn its own band", () => {
    expect(lay.cells.length).toBe(model.spans.length);
    expect(lay.bands.length).toBe(0);
    expect(lay.bars.length).toBe(0);
    expect(lay.segs.map((s) => s.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lay.segs.every((s) => !s.folded)).toBe(true);
  });
  it("turns tile the width; a turn is as wide as it has actions", () => {
    expect(lay.segs[0].x0).toBe(0);
    expect(lay.segs.at(-1)!.x1).toBeCloseTo(640, 6);
    for (let i = 1; i < lay.segs.length; i++) expect(lay.segs[i].x0).toBeCloseTo(lay.segs[i - 1].x1, 6);
    const per = lay.segs.map((s) => (s.x1 - s.x0) / model.spans.filter((x) => x.turn === s.turn).length);
    for (const u of per) expect(u).toBeCloseTo(per[0], 6);
  });
  it("up to 14 turns, every turn is numbered", () => {
    expect(labelledTurns(lay).map((s) => s.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const fourteen = layoutTimeline(modelOf(convo(14, 2)), 640);
    expect(labelledTurns(fourteen)).toHaveLength(14);
  });
});

describe("turn labels on a longer conversation: every 5th, more sparsely if they would touch", () => {
  it("15+ turns: turns 1, 6, 11, … when there is room", () => {
    const lay = layoutTimeline(modelOf(convo(40, 1)), 1200);
    expect(lay.bars.length).toBe(0);
    expect(labelledTurns(lay).map((s) => s.turn)).toEqual([1, 6, 11, 16, 21, 26, 31, 36]);
  });
  it("never closer than the minimum gap: the stride grows (5 → 10 → 20 …)", () => {
    const lay = layoutTimeline(modelOf(convo(200, 30)), 700);
    const xs = labelledTurns(lay, 26).map((s) => s.x0);
    expect(xs.length).toBeGreaterThan(3);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(26 - 1e-6);
    const turns = labelledTurns(lay, 26).map((s) => s.turn);
    const stride = turns[1] - turns[0];
    expect([5, 10, 20, 50, 100]).toContain(stride);
    expect(turns.slice(0, -1).every((t) => (t - 1) % stride === 0)).toBe(true);
  });
  it("the newest turn is numbered too when it has room, so the window says where it is", () => {
    const lay = layoutTimeline(modelOf(convo(200, 30)), 700);
    expect(labelledTurns(lay, 26).at(-1)!.turn).toBe(200);
    const cramped = layoutTimeline(modelOf(convo(200, 30)), 700);
    expect(labelledTurns(cramped, 5000).map((s) => s.turn)).toEqual([1]);
  });
});

describe("a very long conversation: fixed width, older turns become density bars", () => {
  const model = modelOf(convo(200, 30));
  const W = 700;
  const lay = layoutTimeline(model, W);
  const older = lay.segs.filter((s) => s.folded);
  const win = lay.segs.filter((s) => !s.folded);
  it("everything fits the width, the newest turns are the window, the rest are bars", () => {
    expect(model.spans.length).toBeGreaterThan(6000);
    expect(lay.segs[0].x0).toBe(0);
    expect(lay.segs.at(-1)!.x1).toBeCloseTo(W, 6);
    expect(older.length).toBeGreaterThan(100);
    expect(win.length).toBeGreaterThanOrEqual(1);
    expect(older.every((s, i) => s.turn === i + 1)).toBe(true);
    expect(win.at(-1)!.turn).toBe(200);
    expect(lay.bars.map((b) => b.turn)).toEqual(older.map((s) => s.turn));
  });
  it("older turns are drawn as no single block", () => {
    const olderTurns = new Set(older.map((s) => s.turn));
    expect([...lay.cells, ...lay.bands].every((t) => !olderTurns.has(t.turn))).toBe(true);
  });
  it("what is drawn is bounded by the width, not by the number of records", () => {
    expect(lay.cells.length + lay.bands.length + lay.bars.length).toBeLessThan(W);
  });
  it("a density bar is the turn's colour mix", () => {
    const b = lay.bars[10];
    const spans = model.spans.filter((s) => s.turn === b.turn);
    expect(b.n).toBe(spans.length);
    expect(b.parts.reduce((n, p) => n + p.count, 0)).toBe(spans.length);
    expect(b.parts.reduce((n, p) => n + p.frac, 0)).toBeCloseTo(1, 6);
    const order = b.parts.map((p) => CLASSES.indexOf(p.cls));
    expect(order).toEqual([...order].sort((a, c) => a - c));
    const reads = spans.filter((s) => lookOf(s).cls === "read").length;
    expect(b.parts.find((p) => p.cls === "read")?.count ?? 0).toBe(reads);
  });
});

describe("turns the person asked to look at stay unfolded, wherever they are", () => {
  const model = modelOf(convo(200, 30));
  const W = 700;
  it("a kept old turn is drawn as blocks between folded neighbours; the strip still tiles the width", () => {
    const lay = layoutTimeline(model, W, new Set([10, 11, 12]));
    const by = new Map(lay.segs.map((s) => [s.turn, s]));
    for (const t of [10, 11, 12]) expect(by.get(t)!.folded, `turn ${t}`).toBe(false);
    expect(by.get(9)!.folded).toBe(true);
    expect(by.get(13)!.folded).toBe(true);
    expect(lay.cells.some((c) => c.turn === 11)).toBe(true);
    expect(lay.bars.some((b) => b.turn === 11)).toBe(false);
    expect(lay.segs[0].x0).toBe(0);
    expect(lay.segs.at(-1)!.x1).toBeCloseTo(W, 6);
    for (let i = 1; i < lay.segs.length; i++) expect(lay.segs[i].x0).toBeCloseTo(lay.segs[i - 1].x1, 6);
    expect(lay.cells.length + lay.bands.length + lay.bars.length).toBeLessThan(W);
  });
  it("the newest turn is still unfolded, and the kept ones are given the room first", () => {
    const lay = layoutTimeline(model, W, new Set([10, 11, 12]));
    expect(lay.segs.at(-1)!.folded).toBe(false);
    const kept = lay.segs.filter((s) => s.turn >= 10 && s.turn <= 12);
    for (const s of kept) expect((s.x1 - s.x0) / s.n).toBeGreaterThanOrEqual(MIN_BLOCK); // every record of a kept turn still gets its own block
    // and it stays open even when it alone is longer than the strip
    const long = layoutTimeline(modelOf(convo(5, 400)), 300);
    expect(long.segs.at(-1)!.folded).toBe(false);
    expect(long.segs.slice(0, -1).every((s) => s.folded)).toBe(true);
  });
  it("x ↔ value still round-trips when folded and open turns interleave", () => {
    const lay = layoutTimeline(model, W, new Set([50]));
    for (const s of lay.segs) {
      const mid = (s.x0 + s.x1) / 2;
      expect(xOf(lay, valueAt(lay, mid))).toBeCloseTo(mid, 6);
    }
  });
  it("a stretch too long for a block each is left as density bars (they say more than a smear)", () => {
    const lay = layoutTimeline(model, W, new Set(Array.from({ length: 100 }, (_, i) => i + 1)));
    const plain = layoutTimeline(model, W);
    expect(lay.segs.map((s) => [s.turn, s.folded])).toEqual(plain.segs.map((s) => [s.turn, s.folded]));
  });
  it("without a request nothing changes", () => {
    const a = layoutTimeline(model, W);
    const b = layoutTimeline(model, W, new Set());
    expect(b.segs.map((s) => [s.turn, s.folded, Math.round(s.x1)])).toEqual(a.segs.map((s) => [s.turn, s.folded, Math.round(s.x1)]));
  });
});

describe("hair-thin blocks fold into colour bands (real-time projection)", () => {
  // every fifth call takes 9 s, the rest 3 ms: the short ones would be slivers next to it
  const items = convo(6, 20, { slow: true });
  const model = modelOf(items, "duration");
  const lay = layoutTimeline(model, 300);
  it("neighbours of one colour in one lane that would be under 1.5 px merge into one band; every block left is wide enough to see", () => {
    expect(lay.bands.length).toBeGreaterThan(0);
    for (const b of lay.bands) {
      expect(b.count).toBeGreaterThanOrEqual(2);
      expect(b.last).toBeGreaterThan(b.first);
      expect(b.w).toBeGreaterThanOrEqual(MIN_BLOCK);
    }
    for (const c of lay.cells) expect(c.w).toBeGreaterThanOrEqual(MIN_BLOCK);
  });
  it("no record is lost: blocks and bands account for every one in the window", () => {
    const win = new Set(lay.segs.filter((s) => !s.folded).map((s) => s.turn));
    const want = model.spans.filter((s) => win.has(s.turn)).length;
    expect(lay.cells.length + lay.bands.reduce((n, b) => n + b.count, 0)).toBe(want);
  });
});

describe("where the pointer lands", () => {
  const model = modelOf(convo(6, 12, { fail: (t, i) => t === 2 && i === 3 }));
  const lay = layoutTimeline(model, 600);
  const cell = (index: number) => lay.cells.find((c) => c.first === index)!;
  it("a block is hit inside its own lane and x range", () => {
    const c = cell(20);
    const y = laneMid(c.look.lane);
    expect(hitTest(lay, c.x + c.w / 2, y)).toMatchObject({ kind: "cell", first: 20 });
    expect(hitTest(lay, c.x + c.w / 2, y + 2)).toMatchObject({ first: 20 });
    const other = c.look.lane === 2 ? 1 : 2;
    expect(hitTest(lay, c.x + c.w / 2, laneMid(other))).toBeNull(); // the same x in another lane is empty
  });
  it("a click a little above or below the row snaps to the nearest lane", () => {
    const c = cell(20);
    expect(hitTest(lay, c.x + c.w / 2, laneMid(c.look.lane) + 9)).toMatchObject({ first: 20 });
  });
  it("a hair-thin block can still be hit (a pixel of slack each side)", () => {
    const thin = { ...lay, cells: [{ ...cell(20), x: 100, w: 1.5 }], bands: [], bars: [] };
    expect(hitTest(thin, 99.2, laneMid(cell(20).look.lane))).toMatchObject({ first: 20 });
    expect(hitTest(thin, 98.5, laneMid(cell(20).look.lane))).toBeNull();
    expect(hitTest(thin, 101.9, laneMid(cell(20).look.lane))).toMatchObject({ first: 20 });
    expect(hitTest(thin, 103.2, laneMid(cell(20).look.lane))).toBeNull();
  });
  it("empty space and the label row hit nothing", () => {
    expect(hitTest(lay, -5, 10)).toBeNull();
    expect(hitTest(lay, 300, HEIGHT - 2)).toBeNull();
    expect(hitTest(lay, 300, 200)).toBeNull();
  });
  it("a density bar is hit anywhere down its height", () => {
    const l = layoutTimeline(modelOf(convo(200, 30)), 700);
    const b = l.bars[4];
    expect(hitTest(l, b.x + b.w / 2, TOP + 2)).toMatchObject({ kind: "bar", turn: b.turn });
    expect(hitTest(l, b.x + b.w / 2, TOP + 34)).toMatchObject({ kind: "bar", turn: b.turn });
  });
  it("x ↔ timeline value round-trips through the turns (the drag-to-focus range keeps working)", () => {
    for (const s of lay.segs) {
      const mid = (s.x0 + s.x1) / 2;
      expect(xOf(lay, valueAt(lay, mid))).toBeCloseTo(mid, 6);
    }
    expect(valueAt(lay, -10)).toBe(model.start);
    expect(valueAt(lay, 9999)).toBe(model.end);
    const long = layoutTimeline(modelOf(convo(200, 30)), 700);
    const b = long.segs[10];
    expect(valueAt(long, b.x0 + 0.01)).toBeGreaterThanOrEqual(b.v0);
    expect(valueAt(long, b.x1 - 0.01)).toBeLessThanOrEqual(b.v1);
  });
});

describe("keyboard cursor over blocks, bands and bars", () => {
  const lay = layoutTimeline(modelOf(convo(4, 6)), 400);
  const order = targetsInOrder(lay);
  it("left to right, then by lane; the ends stay put", () => {
    expect(order).toHaveLength(lay.cells.length);
    for (let i = 1; i < order.length; i++) expect(order[i].x >= order[i - 1].x).toBe(true);
    expect(stepCursor(order, null, 1)).toBe(order[0].key);
    expect(stepCursor(order, order[0].key, 1)).toBe(order[1].key);
    expect(stepCursor(order, order[1].key, -1)).toBe(order[0].key);
    expect(stepCursor(order, order[0].key, -1)).toBe(order[0].key);
    expect(stepCursor(order, order.at(-1)!.key, 1)).toBe(order.at(-1)!.key);
    expect(stepCursor(order, null, -1)).toBe(order.at(-1)!.key);
  });
});

describe("what a 0.5 s hover says", () => {
  const items = convo(3, 8, { fail: (t, i) => t === 1 && i === 2 });
  const model = modelOf(items);
  const lay = layoutTimeline(model, 500);
  const cell = (index: number) => lay.cells.find((c) => c.first === index)!;
  it("a record: index, kind, turn, the exact time to the millisecond, how long it took, what it was", () => {
    const tool = model.spans.find((s) => s.kind === "tool" && s.durationMs)!;
    const h = hoverText(cell(tool.index));
    expect(h.title).toContain(`#${tool.index}`);
    expect(h.title).toContain(`第 ${tool.turn} 轮`);
    expect(h.lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(h.lines[1]).toBe(`耗时 ${tool.durationMs} ms`);
    expect(h.lines.at(-1)).toContain(tool.label.slice(0, 20));
  });
  it("a failure says so; a record with no recorded duration says nothing about one", () => {
    const failed = model.spans.find((s) => s.isError)!;
    expect(hoverText(cell(failed.index)).title).toContain("失败");
    const user = model.spans.find((s) => s.kind === "user")!;
    expect(hoverText(cell(user.index)).lines.some((l) => l.startsWith("耗时"))).toBe(false);
  });
  it("a density bar: the turn, its action count and the colour mix", () => {
    const l = layoutTimeline(modelOf(convo(200, 30)), 700);
    const h = hoverText(l.bars[3]);
    expect(h.title).toBe(`第 4 轮 · ${l.bars[3].n} 条记录`);
    expect(h.lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(h.lines.join(" ")).toMatch(/读文件 \d+/);
  });
  it("a band: how many, of what, from where to where", () => {
    const m = modelOf(convo(6, 20, { slow: true }), "duration");
    const l = layoutTimeline(m, 300);
    const b = l.bands[0];
    const h = hoverText(b);
    expect(h.title).toContain(`${b.count} 个`);
    expect(h.title).toContain(`#${b.first}`);
    expect(h.title).toContain(`#${b.last}`);
  });
});

function laneMid(lane: number) {
  return laneTop(lane) + LANE_H / 2;
}
