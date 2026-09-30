// Footprints on the diagram (web/docs/workstation.md「新想法」): per node, how long workers stood
// there working and how long they wrote there (./trail.ts), up to the time shown — a replay counts
// only what had happened by the playhead. Drawn by ./FootprintLayer.tsx. Pure.
import type { Ctx } from "./place";
import type { WorkRun } from "./runs/types";
import { dwell } from "./trail";

/** `density`: this node's weight ÷ the heaviest node's (0–1]; writing weighs twice (it is the one
 * thing the diagram marks in purple). Times in ms. */
export type Footprint = { place: string; stood: number; wrote: number; density: number };

export function footprints(runs: readonly WorkRun[], ctx: Ctx, from: number, to: number): Footprint[] {
  const d = [...dwell(runs, ctx, from, to)];
  const weight = (v: { stood: number; wrote: number }) => v.stood + v.wrote;
  const max = Math.max(0, ...d.map(([, v]) => weight(v)));
  return d.map(([place, v]) => ({ place, stood: Math.round(v.stood), wrote: Math.round(v.wrote), density: weight(v) / max })).sort((a, b) => b.density - a.density || (a.place < b.place ? -1 : 1));
}
