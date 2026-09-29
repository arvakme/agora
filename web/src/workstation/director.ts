// The director's figure half (web/docs/workstation.md §导演层): one pure function from the runs and the moment to what every figure shows in that
// frame. The camera half (`camera`) is filled in by ./replayView.ts's successor; the types are here so both halves speak one language.
//
//   - The delay buffer. Live, the figures show the world of `now − LOOKAHEAD_MS`; the director itself works at `now`, so what is about to
//     be drawn (`known`: the calls that have reached it and are not on screen yet) is known before it is. A replay knows all of its future
//     and has no delay (`delay` 0). The picture in the diagram is not delayed — only the figures' acting.
//   - No jumps. A worker starts from where it stood (./place.ts `compute`: the tray the first time) and walks to where its work lands — or, over
//     CUT_DISTANCE, is cut across: for CUT_MS it is drawn twice, fading in where it goes (`alpha`) while it fades out where it was (`ghost`), the
//     two opacities adding up to one. Never two full figures, never one that is suddenly somewhere else.
// Pure: no DOM, no clock; the caller says what time it is.
import { CUT_MS, placeOfSeg, stateAt, type Ctx, type RunState } from "./place";
import { tripAt, type Pt } from "./rig";
import type { RunSeg, WorkRun } from "./runs/types";

/** How far behind `now` the figures are drawn, live (ms): what they do next is known this long before it shows. */
export const LOOKAHEAD_MS = 600;

/** One figure in one frame. */
export type FigureFrame = {
  run: string;
  /** The time it is shown at: `now − delay`. */
  t: number;
  /** ./place.ts `stateAt` at `t`. */
  state: RunState;
  /** Opacity of the figure at its place, for a cut in progress (1 otherwise); multiplies `state.fade`. */
  alpha: number;
  /** A cut in progress: the same figure fading out at the place it leaves (`alpha` + this = 1). */
  ghost?: { place: string; alpha: number };
};
/** A call that has reached the director (start ≤ now) and is not on screen yet (start > now − delay), with where its work is. */
export type Known = { run: string; seg: RunSeg; place: string | null };
/** The camera's half of a frame (filled by the camera director): not yet part of this function. */
export type CameraPlan = { follow: string | null };
export type DirectorIn = { runs: readonly WorkRun[]; now: number; delay: number; ctx: Ctx };
export type DirectorOut = { t: number; figures: FigureFrame[]; known: Known[]; camera?: CameraPlan };

const smooth = (u: number) => u * u * (3 - 2 * u);

export function directorFrame(i: DirectorIn): DirectorOut {
  const t = i.now - i.delay;
  const figures: FigureFrame[] = i.runs.map((run) => {
    const state = stateAt(run, t, i.ctx);
    if (!state.cut) return { run: run.id, t, state, alpha: 1 };
    const a = smooth(Math.max(0, Math.min(1, (t - state.cut.t) / CUT_MS)));
    return { run: run.id, t, state, alpha: a, ghost: { place: state.cut.from, alpha: 1 - a } };
  });
  const known: Known[] = [];
  if (i.delay > 0) for (const run of i.runs) for (const seg of run.segs) if (seg.start > t && seg.start <= i.now) known.push({ run: run.id, seg, place: placeOfSeg(i.ctx, seg) });
  return { t, figures, known };
}

/** Where a figure's feet are in a frame (world coordinates, before the place's slot offsets): along its trip, else at its place's dock. */
export function figureAt(f: FigureFrame, ctx: Pick<Ctx, "dock">): Pt {
  const trip = f.state.trip;
  return trip && f.state.w < 1 ? tripAt(trip, f.t).root : ctx.dock(f.state.at);
}
