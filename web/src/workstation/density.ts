// The strip and the lanes never turn into a barcode (web/docs/workstation.md「细条与泳道不密」). Pure.
import type { WorkRun } from "./runs/types";

/** One mark in the strip per this many px. */
export const BUCKET_PX = 3;
export type Bucket = { x: number; w: number; /** 0 … 1: the share of the bucket that was busy. */ level: number };

/** Busy stretches (px, along the strip) → the marks to draw: one per bucket that has any activity, its shade the share that was busy. */
export function bucketize(spans: readonly { x0: number; x1: number }[], width: number, bucket = BUCKET_PX): Bucket[] {
  const n = Math.max(0, Math.ceil(width / bucket));
  const cover = new Float64Array(n);
  // each bucket's busy part is a union of intervals: sort, merge, then measure
  const inside = spans
    .map((s) => ({ x0: Math.max(0, Math.min(s.x0, s.x1)), x1: Math.min(width, Math.max(s.x0, s.x1)) }))
    .filter((s) => s.x1 > s.x0)
    .sort((a, b) => a.x0 - b.x0);
  const merged: { x0: number; x1: number }[] = [];
  for (const s of inside) {
    const last = merged[merged.length - 1];
    if (last && s.x0 <= last.x1) last.x1 = Math.max(last.x1, s.x1);
    else merged.push({ ...s });
  }
  for (const s of merged)
    for (let i = Math.floor(s.x0 / bucket); i <= Math.min(n - 1, Math.floor((s.x1 - 1e-9) / bucket)); i++) cover[i] += Math.min(s.x1, (i + 1) * bucket) - Math.max(s.x0, i * bucket);
  const out: Bucket[] = [];
  for (let i = 0; i < n; i++) if (cover[i] > 1e-9) out.push({ x: i * bucket, w: Math.min(bucket, width - i * bucket), level: Math.min(1, cover[i] / bucket) });
  return out;
}

/** A row with more than one segment per 8 px is crowded: it is drawn as buckets. A quiet one keeps its segments. */
export const isDense = (segments: number, width: number) => segments * 8 > width;

/** The most recently active `max` of a run's sub-agents (kept in their own order), and how many were left out. */
export function recentKids<T extends { active: number }>(kids: readonly T[], max = 8): { shown: T[]; hidden: number } {
  if (kids.length <= max) return { shown: [...kids], hidden: 0 };
  const keep = new Set([...kids].sort((a, b) => b.active - a.active).slice(0, max));
  return { shown: kids.filter((k) => keep.has(k)), hidden: kids.length - max };
}

/** With nothing running for this long the strip stops drawing activity. */
export const IDLE_QUIET_MS = 10 * 60_000;

/** When the last thing happened, if every run (sub-agents too) has been over for more than 10 minutes; else null. */
export function idleSince(runs: readonly WorkRun[], now: number): number | null {
  let last = -Infinity;
  const walk = (r: WorkRun): boolean => {
    if (r.running) return false;
    last = Math.max(last, r.lastAt, ...r.segs.map((s) => s.end));
    return r.children.every(walk);
  };
  if (!runs.length || !runs.every(walk)) return null;
  return Number.isFinite(last) && now - last > IDLE_QUIET_MS ? last : null;
}
