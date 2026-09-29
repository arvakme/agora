// Where a play starts (web/docs/workstation.md §11): the turn's start, or a step the person chose in the trajectory — playing
// from it, or paused at it when they only wanted the figure to stand there. And where a step clicked during a play sends the clock. Pure.
import type { Replay } from "./clock";
import type { Window } from "./playCounts";

/** The clock starts a moment before the turn (the figure is seen arriving) … */
export const LEAD_MS = 400;
/** … and ends after it: the summary, on the whole diagram. */
export const SUMMARY_MS = 3000;

export type StartOpts = { from?: number; paused?: boolean };
export type Start = { at: number; until: number; paused: boolean };

export function startAt(win: Window, now: number, o: StartOpts = {}): Start {
  const until = Math.min(now, (win.end ?? now) + SUMMARY_MS);
  const first = win.start - LEAD_MS;
  return { at: o.from == null ? first : Math.min(until, Math.max(first, o.from)), until, paused: !!o.paused };
}

/** A step clicked while a play is on: paused stays paused there; playing goes on from there at the same speed. */
export const jumpTo = (r: Pick<Replay, "playing" | "until" | "speed">, at: number) => ({ playing: r.playing, at, until: r.until, speed: r.speed });
