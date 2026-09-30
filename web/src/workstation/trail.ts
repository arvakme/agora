// Where each worker stood while it worked, and its walks from node to node (web/docs/workstation.md
// 「新想法」: the footprints and the day's summary share it). Read off `stateAt` (./place.ts), so both
// agree with what the canvas showed: a short read is a glance from where it stands, thinking and
// waiting happen where it stands, a sub-agent walks back to hand over. Pure; memoised per context
// and run object (the overlay builds a new context when the runs refresh: once a second while
// anyone works, so the footprints and the summary recompute at most that often).
import { bursts, OUTSIDE, stateAt, type Ctx } from "./place";
import type { Move } from "./rig";
import type { SegKind, WorkRun } from "./runs/types";

/** One segment of work, at the place the worker stood meanwhile. */
export type Stay = { place: string; start: number; end: number; kind: SegKind };
/** Its stays, and its walks from one place to another (time order). */
export type Trail = { stays: Stay[]; moves: Move[] };

const memo = new WeakMap<Ctx, WeakMap<WorkRun, Trail>>();

export function trail(run: WorkRun, ctx: Ctx): Trail {
  let byRun = memo.get(ctx);
  if (!byRun) memo.set(ctx, (byRun = new WeakMap()));
  const hit = byRun.get(run);
  if (hit) return hit;
  const stays: Stay[] = [];
  const moves = new Map<string, Move>();
  const keep = (ms: readonly Move[]) => {
    for (const m of ms) if (m.from !== m.to) moves.set(`${m.t}|${m.from}|${m.to}`, m);
  };
  // A stretch of work starts its walks as its segments start: the state at its last segment's start
  // lists them all, from where it appeared.
  for (const b of bursts(run.segs)) {
    const st = stateAt(run, b[b.length - 1].start, ctx);
    keep(st.moves);
    let at = st.moves[0]?.from ?? st.at;
    let i = 0;
    for (const g of b) {
      while (i < st.moves.length && st.moves[i].t <= g.start) at = st.moves[i++].to;
      stays.push({ place: at, start: g.start, end: g.end, kind: g.kind });
    }
  }
  // a sub-agent's walk back to the one who sent it
  if (run.doneAt != null) keep(stateAt(run, run.doneAt, ctx).moves);
  const out = { stays, moves: [...moves.values()].sort((a, b) => a.t - b.t) };
  byRun.set(run, out);
  return out;
}

/** Per node, how long workers stood there working and how long of that they wrote, from `from` to
 * `to`. The 图外 tray is not a node; idle time and walks without work are not stays. */
export function dwell(runs: readonly WorkRun[], ctx: Ctx, from: number, to: number): Map<string, { stood: number; wrote: number }> {
  const out = new Map<string, { stood: number; wrote: number }>();
  for (const r of runs)
    for (const s of trail(r, ctx).stays) {
      const d = Math.min(s.end, to) - Math.max(s.start, from);
      if (d <= 0 || s.place === OUTSIDE) continue;
      let v = out.get(s.place);
      if (!v) out.set(s.place, (v = { stood: 0, wrote: 0 }));
      v.stood += d;
      if (s.kind === "write") v.wrote += d;
    }
  return out;
}
