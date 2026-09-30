// The overview's selection — drag a stretch to look at it — without a DOM.
//
// A selection is kept as records (the first and last record's `#index`), and it means the records from
// one to the other *in record order* — the order of the log, which is the same in "等宽" and in "实际时长" and
// does not move when a tool's result arrives. Positions on the axis belong to the projection (a tool that
// starts in the same millisecond as another sorts by when it ends in "实际时长", and that changes as results
// come in), so they only turn the pointer into records and never say who is in. That is also what the ledger
// below filters by. `tail` pins the right edge to the newest record, so a turn still running keeps the
// selection's end with it (and an edge the person moved off the end does not).
import { valueAt, xOf, type Layout } from "./timelineLayout";
import type { Span, TimelineModel } from "./trajectoryModel";

export type Sel = { from: number; to: number; tail: boolean };
/** The model's records twice: `spans` by position on the axis (what the pointer meets; `pos` is where a record sits there) and `ordered` by record
 *  (what a selection is made of); `rank` is where a record sits in `ordered`, and `firstOf` / `lastOf` where a turn starts and ends there. */
export type Domain = { spans: readonly Span[]; pos: ReadonlyMap<number, number>; ordered: readonly Span[]; rank: ReadonlyMap<number, number>; turns: readonly number[]; firstOf: ReadonlyMap<number, number>; lastOf: ReadonlyMap<number, number> };
export type Edge = "left" | "right";
export type Part = Edge | "body" | "out";

/** The grab area of an edge, centred on its line. */
export const HANDLE_HIT = 12;

export function domainOf(model: TimelineModel): Domain {
  const ordered = [...model.spans].sort((a, b) => a.index - b.index);
  const rank = new Map<number, number>();
  const pos = new Map(model.spans.map((s, p) => [s.index, p]));
  const firstOf = new Map<number, number>();
  const lastOf = new Map<number, number>();
  const turns: number[] = [];
  ordered.forEach((s, r) => {
    rank.set(s.index, r);
    if (!firstOf.has(s.turn)) (firstOf.set(s.turn, r), turns.push(s.turn));
    lastOf.set(s.turn, r);
  });
  return { spans: model.spans, pos, ordered, rank, turns, firstOf, lastOf };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const newest = (d: Domain) => d.ordered.length - 1;
/** Where the record at axis position `p` sits in record order. */
const rankAt = (d: Domain, p: number) => d.rank.get(d.spans[clamp(p, 0, newest(d))].index)!;

/** Ranks [first, last] the selection covers now (a pinned right edge is whatever is newest; a record that is gone collapses onto what is). */
export function range(d: Domain, sel: Sel): [number, number] {
  const last = newest(d);
  const r0 = clamp(d.rank.get(sel.from) ?? last, 0, last);
  const r1 = sel.tail ? last : clamp(d.rank.get(sel.to) ?? last, 0, last);
  return [Math.min(r0, r1), Math.max(r0, r1)];
}
/** A selection between two ranks (either order). Reaching the newest record pins it. */
function between(d: Domain, a: number, b: number): Sel {
  const r0 = clamp(Math.min(a, b), 0, newest(d));
  const r1 = clamp(Math.max(a, b), 0, newest(d));
  return { from: d.ordered[r0].index, to: d.ordered[r1].index, tail: r1 === newest(d) };
}
/** A selection between two axis positions (either order): every record on the stretch is in it, however the axis orders them. */
export function selectBetween(d: Domain, a: number, b: number): Sel {
  const p0 = clamp(Math.min(a, b), 0, newest(d));
  const p1 = clamp(Math.max(a, b), 0, newest(d));
  let lo = newest(d);
  let hi = 0;
  for (let p = p0; p <= p1; p++) {
    const r = rankAt(d, p);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  return between(d, lo, hi);
}
/** A selection dragged out from the record the pointer went down on (kept as a record: the axis may re-order while dragging) to axis position p. */
export function selectFrom(d: Domain, anchor: number, p: number): Sel {
  return selectBetween(d, d.pos.get(anchor) ?? p, p);
}
export function count(d: Domain, sel: Sel): number {
  const [r0, r1] = range(d, sel);
  return r1 - r0 + 1;
}
export function contains(d: Domain, sel: Sel, index: number): boolean {
  const r = d.rank.get(index);
  const [r0, r1] = range(d, sel);
  return r !== undefined && r >= r0 && r <= r1;
}
export function turnsOf(d: Domain, sel: Sel): [number, number] {
  const [r0, r1] = range(d, sel);
  return [d.ordered[r0].turn, d.ordered[r1].turn];
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
/** The record at overview x: what a drag is anchored to (a position on the axis would move under it when a result re-orders the axis). */
export function recordAtX(lay: Layout, d: Domain, x: number): number {
  return d.spans[posAtX(lay, d, x)].index;
}
/** Overview x of the selection's two edges: where its first record starts on this axis and where its last one ends. */
export function edgeX(lay: Layout, d: Domain, sel: Sel): [number, number] {
  const [r0, r1] = range(d, sel);
  let start = d.ordered[r0].start;
  let end = d.ordered[r0].end;
  for (let r = r0; r <= r1; r++) {
    start = Math.min(start, d.ordered[r].start);
    end = Math.max(end, d.ordered[r].end);
  }
  return [xOf(lay, start), xOf(lay, end)];
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
/** Edge dragged to axis position p: it stops on the other edge (one record is the smallest selection). */
export function dragEdge(d: Domain, sel: Sel, edge: Edge, p: number): Sel {
  const [r0, r1] = range(d, sel);
  const r = rankAt(d, p);
  return edge === "left" ? between(d, Math.min(r, r1), r1) : between(d, r0, Math.max(r, r0));
}
/** The whole selection moved as far as the pointer has gone since it went down on record `anchor`: to axis position p, which is as many records
 *  on as that record is, in record order. Stops at the ends. */
export function panSel(d: Domain, sel: Sel, anchor: number, p: number): Sel {
  const from = d.rank.get(anchor);
  if (from === undefined) return sel;
  const [r0, r1] = range(d, sel);
  const by = clamp(rankAt(d, p) - from, -r0, newest(d) - r1);
  return by === 0 ? sel : between(d, r0 + by, r1 + by);
}
/** An edge moved one record, or one turn (the left edge to a turn start, the right edge to a turn end). */
export function stepEdge(d: Domain, sel: Sel, edge: Edge, dir: 1 | -1, unit: "record" | "turn"): Sel {
  const [r0, r1] = range(d, sel);
  const at = (t: number) => d.turns.indexOf(t);
  if (edge === "left") {
    let r = r0 + dir;
    if (unit === "turn") {
      const t = at(d.ordered[r0].turn);
      const first = d.firstOf.get(d.ordered[r0].turn)!;
      r = dir < 0 ? (r0 > first ? first : (d.firstOf.get(d.turns[Math.max(0, t - 1)])!)) : (d.firstOf.get(d.turns[Math.min(d.turns.length - 1, t + 1)])!);
    }
    return between(d, clamp(r, 0, r1), r1);
  }
  let r = r1 + dir;
  if (unit === "turn") {
    const t = at(d.ordered[r1].turn);
    const last = d.lastOf.get(d.ordered[r1].turn)!;
    r = dir > 0 ? (r1 < last ? last : d.lastOf.get(d.turns[Math.min(d.turns.length - 1, t + 1)])!) : d.lastOf.get(d.turns[Math.max(0, t - 1)])!;
  }
  return between(d, r0, clamp(r, r0, newest(d)));
}
