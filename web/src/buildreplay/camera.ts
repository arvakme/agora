// The build replay's camera (web/docs/share-build-replay.md §5). What it shows is the drawing (a whole diagram at the zoom that fits it, down to 0.55) with the
// view kept on the figure; how the view gets there is the director's camera (../workstation/director.ts `cameraStep`: a rate-limited carrot and a
// critically damped spring, and a cut when the shot is over CUT_DISTANCE away — a hop of the figure, which is a cut of the figure too). A replay knows all
// its future and has no delay. Pure.
import { cameraStart, cameraStep, viewAt, type CameraGoal, type CameraOut, type CameraState } from "../workstation/director";
import type { Box } from "../canvas/clearance";
import type { Fit } from "../workstation/replayFit";

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

/** The director's camera takes at most this much of a step at a time (./director.ts `cameraStep` caps a frame at 100 ms, so a tab that slept does not throw the view). */
const SUBSTEP_MS = 100;

/**
 * One frame of the camera toward `shot` (`dt` in ms of play time, `now` the play time at its end, for the cut's cool-down; `cut`: the figure was cut across this
 * frame). A long step — a fast replay: 16× is 267 ms of play time in a 60 fps frame — is taken as steps of at most 100 ms, so the camera consumes all of it and
 * keeps up with a figure that walks at the same speed; a cut in any of them is the frame's cut.
 */
export function stepOf(s: CameraState, shot: Shot | null, o: { dt: number; now: number; pane: { w: number; h: number }; cut?: boolean }): CameraOut {
  const n = Math.max(1, Math.ceil(o.dt / SUBSTEP_MS));
  const dt = o.dt / n;
  let state = s;
  let out!: CameraOut;
  let cut = false;
  for (let i = 0; i < n; i++) {
    const goal: CameraGoal = shot && {
      view: viewAt(shot.centre, shot.zoom, o.pane),
      move: Math.hypot(shot.centre.x - state.at.x, shot.centre.y - state.at.y) * shot.zoom > MOVE_PX || Math.abs(shot.zoom - state.at.zoom) > 0.01,
    };
    out = cameraStep(state, goal, { dt, now: o.now - o.dt + (i + 1) * dt, pane: o.pane, zoom: REPLAY_ZOOM, cut: !!o.cut && i === 0 });
    state = out.state;
    cut ||= out.cut;
  }
  return { ...out, cut };
}

/** What the stage keeps between frames: the camera, the last frame's wall time, the clock's generation (a seek), and where the figure was. */
export type StageMem = { cam: CameraState | null; last: number; gen: number; prev: { x: number; y: number } | null };
export const stageMem = (gen: number): StageMem => ({ cam: null, last: 0, gen, prev: null });

/**
 * One frame of the stage's camera (BuildStage.tsx): the view to put on the drawing, and whether it is a cut. `now`: wall ms; `k`: the play speed (1 when paused);
 * `gen`, `time`: the clock's generation and play time (a change of generation is a seek: the camera is put on the shot); `out`: this layer is fading out (holds);
 * `reduced`: the view is simply on the shot. Mutates `m`.
 */
export function stageStep(m: StageMem, i: { now: number; size: { w: number; h: number }; bounds: Box; figure: { x: number; y: number } | null; out: boolean; reduced: boolean; k: number; gen: number; time: number }): { view: Fit; cut: boolean } {
  const { size, figure: p, reduced } = i;
  const shot = shotOf({ size, bounds: i.bounds, figure: p });
  const dt = m.last ? Math.min(100, i.now - m.last) : 0; // wall time: a tab that slept is 100 ms, whatever the speed
  m.last = i.now;
  if (i.gen !== m.gen) ((m.gen = i.gen), (m.cam = null), (m.prev = null));
  if (!m.cam || reduced) m.cam = cameraStart(viewAt(shot.centre, shot.zoom, size), size);
  const out = stepOf(m.cam, i.out ? null : shot, { dt: dt * i.k, now: i.time, pane: size, cut: !i.out && jumped(m.prev, p) });
  m.prev = p ?? m.prev;
  m.cam = reduced ? cameraStart(viewAt(shot.centre, shot.zoom, size), size) : out.state;
  return { view: reduced ? viewAt(shot.centre, shot.zoom, size) : out.view, cut: out.cut && !reduced };
}
