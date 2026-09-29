// Play a turn of a session on the diagram (web/docs/workstation.md §11): trace it, select the agent, start the play — from the
// turn's start, or from a step (「▶ 从这一步回放」), or paused at a step (a step clicked in the trajectory: the figure goes there).
import { sessionNames } from "../multi/writes";
import { focus } from "../workstation/focus";
import { plays } from "../workstation/replayMode";
import type { StartOpts } from "../workstation/replayStart";
import { runs } from "../workstation/runs/store";
import type { TurnWindow } from "../workstation/trace";
import { sessions } from "./store";
import type { TrajTurn } from "./trajectoryModel";

export const windowOfTurn = (t: Pick<TrajTurn, "n" | "startedAt" | "endedAt" | "running">): TurnWindow => ({ n: t.n, start: t.startedAt, end: t.running || t.endedAt == null ? null : t.endedAt });

/** The session's top-level run (its agent on the diagram), or null while it has not shown up in the workstation. */
export const runOf = (list: ReturnType<typeof runs.get>, sessionId: string) => list.flat.find((f) => f.depth === 0 && f.run.sessionId === sessionId)?.run ?? null;

/** Returns whether there was a run to play. */
export function playTurn(sessionId: string, turn: TrajTurn, o: StartOpts = {}): boolean {
  const run = runOf(runs.get(), sessionId);
  if (!run) return false;
  const win = windowOfTurn(turn);
  focus.trace(run.id, win);
  focus.select(run.id);
  void plays.start({ runId: run.id, n: turn.n, name: sessionNames.get()[sessionId] || run.name, win, canvasId: sessions.get().sessions[sessionId]?.canvasId }, o);
  return true;
}

/** No figure to bring to a step: at least glide the canvas to the step's node, once. */
export const panToStep = (itemId: string) => focus.panToItem(itemId);
