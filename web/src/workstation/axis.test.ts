// The timeline axis: real time where someone works, fixed-width breaks for idle stretches (and the
// idle tail), adaptive ticks that never collide, and playback that skips the breaks.
import { describe, expect, it } from "vitest";
import { advance, buildAxis, fitsLabel, gapLabelFits, labelWidth, ticks } from "./axis.ts";

const S = 1000;
const T0 = Date.UTC(2026, 8, 28, 7, 57, 20);

describe("buildAxis", () => {
  const iv: [number, number][] = [
    [T0, T0 + 30 * S],
    [T0 + 35 * S, T0 + 60 * S],
    [T0 + 3600 * S, T0 + 3630 * S],
  ];
  const now = T0 + 3700 * S;
  const A = buildAxis(iv, now, 800, { gapMs: 20 * S, gapPx: 64 });
  it("merges nearby activity, collapses long idle stretches and the idle tail", () => {
    expect(A.pieces.map((p) => p.kind)).toEqual(["act", "gap", "act", "tail"]);
    expect(A.pieces[0]).toMatchObject({ a: T0, b: T0 + 60 * S });
    expect(A.pieces[1].x1 - A.pieces[1].x0).toBe(64);
    expect(A.pieces[3].x1).toBeCloseTo(800 - 10, 6);
  });
  it("gives activity all the room that is left, at one scale", () => {
    const act = A.pieces.filter((p) => p.kind === "act");
    const pps = (act[0].x1 - act[0].x0) / (act[0].b - act[0].a);
    expect((act[1].x1 - act[1].x0) / (act[1].b - act[1].a)).toBeCloseTo(pps, 9);
    expect(pps).toBeCloseTo(A.pps, 9);
  });
  it("round-trips time ↔ px inside activity, and knows the breaks", () => {
    for (const t of [T0, T0 + 12.5 * S, T0 + 3610 * S]) expect(A.fromPx(A.toPx(t))).toBeCloseTo(t, 3);
    expect(A.gapAt(T0 + 1000 * S)?.kind).toBe("gap");
    expect(A.gapAt(T0 + 3650 * S)?.kind).toBe("tail");
    expect(A.gapAt(T0 + 10 * S)).toBeNull();
  });
  it("still draws something with no activity yet", () => {
    const e = buildAxis([], now, 400);
    expect(e.pieces).toHaveLength(1);
    expect(e.end).toBe(now);
  });
});

describe("ticks", () => {
  it("chooses a step from the px per second so labels stay ≥ 72 px apart and never overlap", () => {
    for (const width of [300, 800, 2400]) {
      const A = buildAxis([[T0, T0 + 120 * S]], T0 + 120 * S, width);
      const ts = ticks(A);
      const labelled = ts.filter((t) => t.label);
      expect(labelled.length).toBeGreaterThan(0);
      for (let i = 1; i < labelled.length; i++) expect(labelled[i].x - labelled[i - 1].x).toBeGreaterThanOrEqual(30);
      const majors = ts.filter((t) => t.major);
      for (let i = 1; i < majors.length; i++) expect(majors[i].x - majors[i - 1].x).toBeGreaterThanOrEqual(72 - 1e-6);
    }
  });
  it("puts no ticks inside a break", () => {
    const A = buildAxis([[T0, T0 + 30 * S], [T0 + 600 * S, T0 + 630 * S]], T0 + 630 * S, 800);
    const gap = A.pieces.find((p) => p.kind === "gap")!;
    expect(ticks(A).some((t) => t.x > gap.x0 + 1 && t.x < gap.x1 - 1)).toBe(false);
  });
});

describe("advance (replay playback)", () => {
  const gaps = [{ a: 100, b: 1000 }];
  it("plays through a break without taking any time", () => {
    expect(advance(50, 40, gaps)).toBe(90);
    expect(advance(50, 60, gaps)).toBe(1010);
  });
  it("jumps out of a break it starts in", () => {
    expect(advance(500, 5, gaps)).toBe(1005);
  });
  it("is a function of wall time only (no per-frame accumulation)", () => {
    let t = 0;
    for (let i = 0; i < 100; i++) t = advance(t, 3, gaps);
    expect(t).toBe(advance(0, 300, gaps));
  });
});

describe("labels are drawn only where they fit", () => {
  it("a label needs its whole width (text + padding); CJK counts a full em", () => {
    expect(fitsLabel("写 users.py", 200)).toBe(true);
    expect(fitsLabel("写 users.py", 40)).toBe(false);
    expect(fitsLabel("空闲", 30)).toBe(false); // 2 × 11 px + padding
    expect(fitsLabel("空闲", 40)).toBe(true);
    expect(fitsLabel("", 0)).toBe(false);
  });

  it("a collapsed break shows its words (two lines) only when the widest line fits; the details stay in its hover card", () => {
    expect(gapLabelFits("空闲", "12 小时 5 分", 90)).toBe(true);
    expect(gapLabelFits("空闲", "12 小时 5 分", 64)).toBe(false); // 12 小时 5 分 is wider than the default 64 px break: the words go to the hover card
    expect(gapLabelFits("空闲", "12 小时 5 分", 24)).toBe(false);
    expect(gapLabelFits("空闲中", "4 分 23 秒", 10)).toBe(false); // the narrowest break the axis makes
  });

  it("5 days, 100 sub-agents a session: every drawn tick label sits inside its stretch and clear of the next label", () => {
    const iv: [number, number][] = [];
    for (let d = 0; d < 8; d++) for (let i = 0; i < 100; i++) iv.push([T0 + d * 15 * 3600 * S + i * 24 * S, T0 + d * 15 * 3600 * S + i * 24 * S + 40 * S]); // 8 sessions, 100 sub-agents each
    const now = T0 + 5 * 86400 * S;
    const A = buildAxis(iv, now, 900, { gapMs: 20 * S, gapPx: 64 });
    const drawn = ticks(A).filter((k) => k.label);
    expect(drawn.length).toBeGreaterThan(0);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i].x - drawn[i - 1].x).toBeGreaterThanOrEqual(labelWidth(drawn[i].label) / 2 + labelWidth(drawn[i - 1].label) / 2);
    for (const k of drawn) {
      const p = A.pieces.find((q) => q.kind === "act" && k.x >= q.x0 - 4 && k.x <= q.x1 + 4)!;
      expect(k.x - labelWidth(k.label) / 2).toBeGreaterThanOrEqual(p.x0 - 4);
      expect(k.x + labelWidth(k.label) / 2).toBeLessThanOrEqual(p.x1 + 4);
    }
  });
});
