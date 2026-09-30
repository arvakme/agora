// The overview's selection — drag a stretch to look at it — without a DOM.
//
// A selection is kept as records (the first and last record's `#index`), not as positions on the
// axis: the same selection means the same records in "等宽" and in "实际时长", and a records-based
// range is what the ledger below filters by. `tail` pins the right edge to the newest record, so a
// turn still running keeps the selection's end with it (and an edge the person moved off the end does not).
import { valueAt, xOf, type Layout } from "./timelineLayout";
import type { Span, TimelineModel } from "./trajectoryModel";

export type Sel = { from: number; to: number; tail: boolean };
/** The model as one ordered list of records (by position on the axis) and where each one sits. */
export type Domain = { spans: readonly Span[]; pos: ReadonlyMap<number, number>; turns: readonly number[]; firstOf: ReadonlyMap<number, number>; lastOf: ReadonlyMap<number, number> };
export type Edge = "left" | "right";
export type Part = Edge | "body" | "out";

/** The grab area of an edge, centred on its line. */
export const HANDLE_HIT = 12;

export function domainOf(model: TimelineModel): Domain {
  const pos = new Map<number, number>();
  const firstOf = new Map<number, number>();
  const lastOf = new Map<number, number>();
  const turns: number[] = [];
  model.spans.forEach((s, p) => {
    pos.set(s.index, p);
    if (!firstOf.has(s.turn)) (firstOf.set(s.turn, p), turns.push(s.turn));
    lastOf.set(s.turn, p);
  });
  return { spans: model.spans, pos, turns, firstOf, lastOf };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const newest = (d: Domain) => d.spans.length - 1;

/** Positions [first, last] the selection covers now (a pinned right edge is whatever is newest; a record that is gone collapses onto what is). */
export function range(d: Domain, sel: Sel): [number, number] {
  const last = newest(d);
  const p0 = clamp(d.pos.get(sel.from) ?? last, 0, last);
  const p1 = sel.tail ? last : clamp(d.pos.get(sel.to) ?? last, 0, last);
  return [Math.min(p0, p1), Math.max(p0, p1)];
}
/** A selection between two positions (either order). Reaching the newest record pins it. */
export function selectBetween(d: Domain, a: number, b: number): Sel {
  const p0 = clamp(Math.min(a, b), 0, newest(d));
  const p1 = clamp(Math.max(a, b), 0, newest(d));
  return { from: d.spans[p0].index, to: d.spans[p1].index, tail: p1 === newest(d) };
}
export function count(d: Domain, sel: Sel): number {
  const [p0, p1] = range(d, sel);
  return p1 - p0 + 1;
}
export function contains(d: Domain, sel: Sel, index: number): boolean {
  const p = d.pos.get(index);
  const [p0, p1] = range(d, sel);
  return p !== undefined && p >= p0 && p <= p1;
}
export function turnsOf(d: Domain, sel: Sel): [number, number] {
  const [p0, p1] = range(d, sel);
  return [d.spans[p0].turn, d.spans[p1].turn];
}
/** Every turn the selection touches: the overview keeps these open as blocks. */
export function keepTurns(d: Domain, sel: Sel): Set<number> {
  const [a, b] = turnsOf(d, sel);
  return new Set(d.turns.filter((t) => t >= a && t <= b));
}
/** What the badge says: 「第 a–b 轮 · N 条」. */
export function caption(d: Domain, sel: Sel): string {
  const [a, b] = turnsOf(d, sel);
  return `${a === b ? `第 ${a} 轮` : `第 ${a}–${b} 轮`} · ${count(d, sel)} 条`;
}

// ——— on the strip ———
/** The record at overview x (clamped at both ends): the last one that starts at or before it. */
export function posAtX(lay: Layout, d: Domain, x: number): number {
  const v = valueAt(lay, x);
  let lo = 0;
  let hi = d.spans.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (d.spans[mid].start <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
/** Overview x of the selection's two edges. */
export function edgeX(lay: Layout, d: Domain, sel: Sel): [number, number] {
  const [p0, p1] = range(d, sel);
  let end = d.spans[p0].end;
  for (let p = p0; p <= p1; p++) end = Math.max(end, d.spans[p].end);
  return [xOf(lay, d.spans[p0].start), xOf(lay, end)];
}
/** What is under x: an edge (HANDLE_HIT wide, the nearer one when they overlap), the body between, or outside. */
export function partAt(lay: Layout, d: Domain, sel: Sel | null, x: number): Part {
  if (!sel) return "out";
  const [x0, x1] = edgeX(lay, d, sel);
  const half = HANDLE_HIT / 2;
  const nearL = Math.abs(x - x0) <= half;
  const nearR = Math.abs(x - x1) <= half;
  if (nearL && nearR) return Math.abs(x - x0) <= Math.abs(x - x1) ? "left" : "right";
  if (nearL) return "left";
  if (nearR) return "right";
  return x > x0 && x < x1 ? "body" : "out";
}

// ——— changing it ———
/** Edge dragged to position p: it stops on the other edge (one record is the smallest selection). */
export function dragEdge(d: Domain, sel: Sel, edge: Edge, p: number): Sel {
  const [p0, p1] = range(d, sel);
  return edge === "left" ? selectBetween(d, Math.min(p, p1), p1) : selectBetween(d, p0, Math.max(p, p0));
}
/** The whole selection moved by `delta` records, stopping at the ends. */
export function panSel(d: Domain, sel: Sel, delta: number): Sel {
  const [p0, p1] = range(d, sel);
  const by = clamp(delta, -p0, newest(d) - p1);
  return by === 0 ? sel : selectBetween(d, p0 + by, p1 + by);
}
/** An edge moved one record, or one turn (the left edge to a turn start, the right edge to a turn end). */
export function stepEdge(d: Domain, sel: Sel, edge: Edge, dir: 1 | -1, unit: "record" | "turn"): Sel {
  const [p0, p1] = range(d, sel);
  const at = (t: number) => d.turns.indexOf(t);
  if (edge === "left") {
    let p = p0 + dir;
    if (unit === "turn") {
      const t = at(d.spans[p0].turn);
      const first = d.firstOf.get(d.spans[p0].turn)!;
      p = dir < 0 ? (p0 > first ? first : (d.firstOf.get(d.turns[Math.max(0, t - 1)])!)) : (d.firstOf.get(d.turns[Math.min(d.turns.length - 1, t + 1)])!);
    }
    return selectBetween(d, clamp(p, 0, p1), p1);
  }
  let p = p1 + dir;
  if (unit === "turn") {
    const t = at(d.spans[p1].turn);
    const last = d.lastOf.get(d.spans[p1].turn)!;
    p = dir > 0 ? (p1 < last ? last : d.lastOf.get(d.turns[Math.min(d.turns.length - 1, t + 1)])!) : d.lastOf.get(d.turns[Math.max(0, t - 1)])!;
  }
  return selectBetween(d, p0, clamp(p, p0, newest(d)));
}
