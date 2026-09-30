// 口 and ladders at a node's door (web/docs/workstation.md §10 父图入口, §12 进出子图). Going into a node's sub-diagram is a climb
// down a ladder from the node's top edge — the body past that line is cut off — and coming in on the sub-diagram's canvas is a
// climb down from one figure's height above the entrance. Pure (./place.ts and ./rig.ts only), so it runs under vitest in node.
//
// While someone is in the sub-diagram, the parent canvas keeps what they went down through: a hole in the node's top edge, the
// upper end of the ladder standing out of it, and one head looking out — the traced one's, else the followed one's, else the
// one that went in last. It is all a function of the runs' door states at t.
import { DOOR_H, DOOR_MS, RIG } from "./rig";
import type { RunState, Side } from "./place";

/** The head rises out of the hole over this long once its owner is all the way down, and ducks over SINK_MS as it starts to come out. */
export const PEEK_MS = 220;
export const SINK_MS = 140;
/** A ladder is drawn HATCH_IN_MS before its climber gets on it (it is known: the walk to it) and stays HATCH_OUT_MS after they are off. */
export const HATCH_IN_MS = 200;
export const HATCH_OUT_MS = 300;
/** Looking out, the head's centre is this high above the floor line (figure units); hidden, it is this far under it. */
export const PEEK_UP = 11;
export const PEEK_DOWN = RIG.head + 2;
/** The word beside a resting head (./figureNode.ts `PeekNode`): its left edge from the head's centre, its font size and a width that holds 「在子图 · 空闲」 (figure units). */
export const PEEK_NOTE = { x: RIG.head + 5, size: 7.5, w: 58 };

/**
 * Where the head looking out of a hole is, as a box in the canvas's world units: `dock` is the hole (the first worker's spot on the node's top edge), `k` the figures' world px per
 * unit. The head's room (its hit box: ±9 wide, from the top of the head to the floor line), and, for an idle agent, the word beside it. Other floaters (./stopPill.ts) keep off it.
 */
export function peekBox(dock: { x: number; y: number }, k: number, note: boolean): { x: number; y: number; w: number; h: number } {
  const top = PEEK_UP + RIG.head + 2;
  const right = note ? PEEK_NOTE.x + PEEK_NOTE.w : 9;
  return { x: dock.x - 9 * k, y: dock.y - top * k, w: (9 + right) * k, h: (top + LADDER_HALF) * k };
}

/** The rails of a ladder on the parent canvas stand this far above the floor (figure units): the upper end that shows. */
export const HATCH_POST = 34;
/** Rungs are about this far apart, as on any ladder (./rig.ts). */
const RUNG = 5.5;
/** How far a ladder's rails are apart, and how wide the hole is (figure units). */
export const LADDER_HALF = 2.6;

/** The line the figure is cut off at, relative to the floor line, for a figure of k world px per unit: `dir` 1 — the ladder goes down: the floor line
 * itself, what is below it is cut; −1 — it goes up: one figure's height above the floor, what is above that is cut. */
export const cutLine = (dir: 1 | -1, k: number) => (dir === 1 ? 0 : -DOOR_H * k);

/** A door's ladder as it is drawn, in figure units with the floor at 0 (up is −y): the rails from `top` to `bottom`, the rungs between. */
export function ladderShape(dir: 1 | -1): { top: number; bottom: number; rungs: number[] } {
  const sp = DOOR_H / Math.max(1, Math.round(DOOR_H / RUNG));
  const top = dir === 1 ? -HATCH_POST : -DOOR_H;
  const rungs: number[] = [];
  for (let y = -sp; y >= top - 1e-6; y -= sp) rungs.push(y);
  return { top, bottom: 0, rungs };
}

const ease = (u: number) => {
  const v = Math.min(1, Math.max(0, u));
  return v * v * (3 - 2 * v);
};

type Door = Pick<RunState, "portalPhase" | "portalSide" | "portalT" | "portalBelow" | "fade">;
/** How far the head of a run below the floor looks out of the hole: 0 hidden … 1 showing. It rises once the run is all the way down, and ducks as the run
 * starts to climb out — from where it was, so nothing jumps. With reduced motion (no ladder is climbed) it is there or not. */
export function peekRise(st: Door, reduced: boolean): number {
  if (st.portalSide !== "below") return 0;
  if (st.portalPhase === "behind") return st.fade > 0 ? (reduced ? 1 : ease((st.portalT ?? 0) / PEEK_MS)) : 0;
  if (st.portalPhase === "out" && !reduced) return ease((st.portalBelow ?? Infinity) / PEEK_MS) * (1 - ease((st.portalT ?? 0) / SINK_MS));
  return 0;
}

/** Whose head looks out of a hole: the traced one, else the followed one (if they are down there), else the one that went in last. */
export function peekerOf(cands: readonly { id: string; since: number }[], o: { traced?: string | null; followed?: string | null }): string | null {
  for (const id of [o.traced, o.followed]) if (id && cands.some((c) => c.id === id)) return id;
  let best: { id: string; since: number } | null = null;
  for (const c of cands) if (!best || c.since > best.since) best = c;
  return best?.id ?? null;
}

/** How visible the hole at `place` is because of this run: fully while it is down there resting (below the floor) — the hole and its head are what say so, not a ladder standing on the head. */
export function holeVisAt(st: RunState, place: string, side: Side): number {
  return side === "below" && st.at === place && st.portalPhase === "behind" && st.portalSide === "below" && st.fade > 0 ? 1 : 0;
}

/** How visible the ladder at `place` is because of this run: only while it is on it or about to be — faded in a little before it gets on (down, or up out of the hole), out a little
 * after it is off. Never while it merely rests in the sub-diagram (a ladder pole standing out of a head reads as a ladder stuck in it); with reduced motion, nothing is climbed: never. */
export function hatchVisAt(st: RunState, place: string, side: Side, t: number, reduced = false): number {
  if (reduced) return 0;
  let v = 0;
  for (const d of st.doors) {
    if (d.at !== place || d.side !== side) continue;
    // known ahead: the walk to the ladder going in; the moment it decides to come out, coming out
    const up = (t - (d.t - HATCH_IN_MS)) / HATCH_IN_MS;
    const down = 1 - (t - (d.t + DOOR_MS)) / HATCH_OUT_MS;
    v = Math.max(v, Math.min(1, Math.max(0, Math.min(up, down))));
  }
  return v;
}

/** `hatchVisAt` with a look ahead: `ahead` is the run's state HATCH_IN_MS later (a door it is about to take is in it before it is in `st`), so the ladder fades in before the climb. */
export const hatchVisSoon = (st: RunState, ahead: RunState, place: string, side: Side, t: number, reduced = false): number => Math.max(hatchVisAt(st, place, side, t, reduced), hatchVisAt(ahead, place, side, t, reduced));

/** How a figure is drawn while it is on a door's ladder: the trip (./rig.ts `planDoor` for `dir`, `leaving`) and how far into it, in ms. Null when it is not on one, or with
 * reduced motion, which has no ladder (the door only fades: `fade` in the state). */
export function doorClimb(st: Pick<RunState, "portalPhase" | "portalSide" | "portalT">, reduced: boolean): { dir: 1 | -1; leaving: boolean; t: number } | null {
  if (reduced || !st.portalSide || (st.portalPhase !== "in" && st.portalPhase !== "out")) return null;
  return { dir: st.portalSide === "below" ? 1 : -1, leaving: st.portalPhase === "in", t: Math.min(st.portalT ?? 0, DOOR_MS - 1e-3) };
}

export type Hatch = { place: string; side: Side; ids: string[] };
export type Peek = { place: string; id: string };
/** Look back and ahead this far (ms) for doors: the structure is rebuilt every 250 ms or so, and a ladder fades in before, and out after. */
const BEFORE = HATCH_OUT_MS + 20;
const AHEAD = HATCH_IN_MS + 300;

/**
 * The hatches to draw on a canvas at t — where a run is on a ladder, about to be, has just been, or (on the parent side) is down in a sub-diagram — and whose head
 * looks out of each hole. `at`: a run's state at a time (./place.ts stateAt on this canvas's context); `o`: the traced and the followed run.
 */
export function hatchesAt(ids: readonly string[], at: (id: string, t: number) => RunState, t: number, o: { traced?: string | null; followed?: string | null }): { hatches: Hatch[]; peeks: Peek[] } {
  const hatches = new Map<string, Hatch>();
  const cands = new Map<string, { id: string; since: number }[]>();
  for (const id of ids) {
    const now = at(id, t);
    for (const u of [t - BEFORE, t, t + AHEAD]) {
      const st = u === t ? now : at(id, u);
      if (!st.portalPhase || !st.portalSide) continue;
      if (st.portalPhase === "behind" && !(st.portalSide === "below" && st.fade > 0)) continue; // up in the parent: nothing of it here
      const key = `${st.at}|${st.portalSide}`;
      const h = hatches.get(key) ?? { place: st.at, side: st.portalSide, ids: [] };
      if (!h.ids.includes(id)) h.ids.push(id);
      hatches.set(key, h);
    }
    if (peekRise(now, false) > 0 || (now.portalSide === "below" && now.portalPhase === "behind" && now.fade > 0)) {
      cands.set(now.at, [...(cands.get(now.at) ?? []), { id, since: now.doorsIn[now.doorsIn.length - 1] ?? -Infinity }]);
    }
  }
  const peeks: Peek[] = [];
  for (const [place, list] of cands) {
    const id = peekerOf(list, o);
    if (id) peeks.push({ place, id });
  }
  return { hatches: [...hatches.values()], peeks };
}
