// The strip and the lanes never turn into a barcode (web/docs/workstation.md「细条与泳道不密」):
// activity in the strip is bucketed by pixel (one mark per ~3 px, its shade the share of the bucket
// that was busy), a run's sub-agents beyond 8 fold into 「+N 个子代理」, and when every session ended
// more than 10 minutes ago the strip only says so.
import { describe, expect, it } from "vitest";
import { BUCKET_PX, bucketize, idleSince, IDLE_QUIET_MS, isDense, recentKids } from "./density.ts";
import type { WorkRun } from "./runs/types.ts";

describe("bucketize: one mark per ~3 px", () => {
  it("never more marks than width / 3, however many spans", () => {
    const spans = Array.from({ length: 5000 }, (_, i) => ({ x0: (i * 0.37) % 300, x1: ((i * 0.37) % 300) + 0.2 }));
    const b = bucketize(spans, 300);
    expect(b.length).toBeLessThanOrEqual(Math.ceil(300 / BUCKET_PX));
    for (const m of b) expect(m.w).toBeLessThanOrEqual(BUCKET_PX);
  });
  it("nothing busy, nothing drawn", () => expect(bucketize([], 300)).toEqual([]));
  it("shade is the busy share of the bucket: a full span is 1, a sliver is small, never over 1", () => {
    const b = bucketize([{ x0: 0, x1: 3 }, { x0: 6.0, x1: 6.6 }, { x0: 9, x1: 12 }, { x0: 9, x1: 12 }], 30);
    expect(b.find((m) => m.x === 0)!.level).toBeCloseTo(1, 5);
    expect(b.find((m) => m.x === 6)!.level).toBeCloseTo(0.2, 5);
    expect(b.find((m) => m.x === 9)!.level).toBeCloseTo(1, 5);
    for (const m of b) expect(m.level).toBeLessThanOrEqual(1);
  });
  it("a span across buckets fills them; the gap stays empty", () => {
    const b = bucketize([{ x0: 1, x1: 10 }, { x0: 20, x1: 22 }], 30);
    expect(b.map((m) => m.x)).toEqual([0, 3, 6, 9, 18, 21]);
  });
  it("spans outside the width are cut off", () => {
    const b = bucketize([{ x0: -20, x1: 2 }, { x0: 28, x1: 90 }], 30);
    expect(b.every((m) => m.x >= 0 && m.x + m.w <= 30 + 1e-9)).toBe(true);
  });
  it("is the same every time", () => {
    const s = [{ x0: 1, x1: 4 }, { x0: 2, x1: 9 }];
    expect(bucketize(s, 20)).toEqual(bucketize(s, 20));
  });
});

describe("isDense: only a crowded row is bucketed, so a quiet scene keeps its segments", () => {
  it("the mock (20 segments over 300 px) is not dense", () => expect(isDense(20, 300)).toBe(false));
  it("hundreds of segments over 300 px is", () => expect(isDense(400, 300)).toBe(true));
});

const run = (id: string, over: Partial<WorkRun> = {}): WorkRun => ({ id, agent: "claude", name: id, segs: [], receipts: [], running: false, lastAt: 0, children: [], ...over });
const seg = (start: number, end: number) => ({ kind: "read" as const, start, end, label: "读" });

describe("recentKids: at most 8 sub-agents listed, the most recently active", () => {
  const kids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, active: i * 1000 }));
  it("8 or fewer: all, in order, nothing hidden", () => {
    const r = recentKids(kids(8), 8);
    expect(r.shown.map((k) => k.id)).toEqual(kids(8).map((k) => k.id));
    expect(r.hidden).toBe(0);
  });
  it("more: the 8 most recently active, still in their own order; the rest counted", () => {
    const r = recentKids(kids(20), 8);
    expect(r.shown.map((k) => k.id)).toEqual(["k12", "k13", "k14", "k15", "k16", "k17", "k18", "k19"]);
    expect(r.hidden).toBe(12);
  });
  it("recent is by activity, not by order", () => {
    const list = [{ id: "a", active: 500 }, ...Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, active: 10 + i })), { id: "z", active: 1 }];
    const r = recentKids(list, 8);
    expect(r.shown.map((k) => k.id)).toContain("a");
    expect(r.shown.map((k) => k.id)).not.toContain("z");
    expect(r.hidden).toBe(3);
  });
});

describe("idleSince: every session over for more than 10 minutes", () => {
  const now = 10_000_000;
  it("the last thing that happened, when all are over and it was long ago", () => {
    const a = run("a", { segs: [seg(now - 3_000_000, now - 2_900_000)], lastAt: now - 2_900_000 });
    const b = run("b", { segs: [seg(now - 2_000_000, now - IDLE_QUIET_MS - 5000)], lastAt: now - IDLE_QUIET_MS - 5000 });
    expect(idleSince([a, b], now)).toBe(now - IDLE_QUIET_MS - 5000);
  });
  it("not when something ran within 10 minutes", () => {
    expect(idleSince([run("a", { segs: [seg(now - 1000, now - 500)], lastAt: now - 500 })], now)).toBeNull();
  });
  it("not while anything still runs", () => {
    expect(idleSince([run("a", { running: true, segs: [seg(now - 4_000_000, now - 3_900_000)], lastAt: now - 3_900_000 })], now)).toBeNull();
  });
  it("not with no runs at all", () => expect(idleSince([], now)).toBeNull());
  it("sub-agents count: a busy one keeps the strip busy", () => {
    const kid = run("k", { segs: [seg(now - 20_000, now - 10_000)], lastAt: now - 10_000 });
    const parent = run("p", { segs: [seg(now - 4_000_000, now - 3_900_000)], lastAt: now - 3_900_000, children: [kid] });
    expect(idleSince([parent], now)).toBeNull();
  });
});
