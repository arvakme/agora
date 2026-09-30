// While a turn plays (workstation/replayMode.ts), the trajectory follows: which row is 「now」, and whether the
// person has looked away from it. Pure; ./TrajectoryView.tsx draws it.
import type { TrajTurn } from "./trajectoryModel";

/** The row the play is at: the last record of turn `n` that has happened by `t` (null before the turn's first). */
export function currentRecord(turns: readonly TrajTurn[], n: number, t: number): string | null {
  const turn = turns.find((x) => x.n === n);
  if (!turn) return null;
  let id: string | null = null;
  for (const s of turn.steps) for (const r of s.records) if (r.at <= t) id = r.id;
  return id;
}

/** The panel while a turn plays: on the trajectory, and back to the view it had when the play ends. */
export type PanelPlay<V extends string> = { view: V; saved: V | null };
export function panelPlays<V extends string>(s: PanelPlay<V>, playing: boolean, trajectory: V): PanelPlay<V> {
  if (playing && s.saved == null) return { view: trajectory, saved: s.view };
  if (!playing && s.saved != null) return { view: s.saved, saved: null };
  return s;
}
