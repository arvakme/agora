// The build replay's camera (web/docs/share-build-replay.md §5). What it shows is the drawing (a whole diagram at the zoom that fits it, down to 0.55) with the
// view kept on the figure; how the view gets there is the director's camera (../workstation/director.ts `cameraStep`: a rate-limited carrot and a
// critically damped spring, and a cut when the shot is over CUT_DISTANCE away — a hop of the figure, which is a cut of the figure too). A replay knows all
// its future and has no delay. Pure.
import { cameraStep, viewAt, type CameraGoal, type CameraOut, type CameraState } from "../workstation/director";
import type { Box } from "../canvas/clearance";

/** The zoom range of the replay: it fits the whole drawing when it can, and not below this (the live camera's is [0.7, 1]). */
export const REPLAY_ZOOM = { min: 0.55, max: 1 };
/** Room the figure needs round it at the edge of the drawing: the head and the bubble above, to each side, and the feet below (world px, at zoom 1). */
const ROOM = { up: 130, side: 90, down: 30 };
const PAD = 48;
/** The shot must be this far (world px, screen px at the zoom) from where the view is before the camera sets off: a figure at work does not make it tremble. */
const MOVE_PX = 12;

export type Shot = { zoom: number; centre: { x: number; y: number } };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The shot: the zoom that fits the drawing to the pane, and the view's centre — on the figure (a little above its feet, for its head and bubble), held
 * inside the drawing and the room the figure needs; a drawing that fits the view is shown by its middle, whatever the figure does (the camera holds).
 */
export function shotOf(i: { size: { w: number; h: number }; bounds: Box; figure: { x: number; y: number } | null }): Shot {
  const { size: { w, h }, bounds: b, figure: p } = i;
  const zoom = clamp(Math.min((w - 32) / (b.w + 2 * PAD), (h - 32) / (b.h + 2 * PAD)), REPLAY_ZOOM.min, REPLAY_ZOOM.max);
  let r = { x0: b.x - PAD, y0: b.y - PAD, x1: b.x + b.w + PAD, y1: b.y + b.h + PAD };
  if (p) r = { x0: Math.min(r.x0, p.x - ROOM.side), y0: Math.min(r.y0, p.y - ROOM.up), x1: Math.max(r.x1, p.x + ROOM.side), y1: Math.max(r.y1, p.y + ROOM.down) };
  const vw = w / zoom;
  const vh = h / zoom;
  const fit = (c: number, lo: number, hi: number, ext: number) => (hi - lo <= ext ? (lo + hi) / 2 : clamp(c, lo + ext / 2, hi - ext / 2));
  const want = p ? { x: p.x, y: p.y - 40 / zoom } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return { zoom, centre: { x: fit(want.x, r.x0, r.x1, vw), y: fit(want.y, r.y0, r.y1, vh) } };
}

/** A figure that moves this far (world px) between two frames was cut across (a walk is a few px a frame): the shot changes with it. */
export const JUMP_PX = 150;
export const jumped = (prev: { x: number; y: number } | null | undefined, cur: { x: number; y: number } | null | undefined): boolean => !!prev && !!cur && Math.hypot(cur.x - prev.x, cur.y - prev.y) > JUMP_PX;

/** One frame of the camera toward `shot` (`dt` in ms of play time, `now` the play time, for the cut's cool-down; `cut`: the figure was cut across this frame). */
export function stepOf(s: CameraState, shot: Shot | null, o: { dt: number; now: number; pane: { w: number; h: number }; cut?: boolean }): CameraOut {
  const goal: CameraGoal = shot && {
    view: viewAt(shot.centre, shot.zoom, o.pane),
    move: Math.hypot(shot.centre.x - s.at.x, shot.centre.y - s.at.y) * shot.zoom > MOVE_PX || Math.abs(shot.zoom - s.at.zoom) > 0.01,
  };
  return cameraStep(s, goal, { ...o, zoom: REPLAY_ZOOM });
}
