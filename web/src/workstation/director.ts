// The director (web/docs/workstation.md §导演层): pure functions from the runs and the moment to what every figure shows in a frame
// (`directorFrame`) and to where the camera is (`cameraStep`); ./replayView.ts only applies them to the canvas.
//
//   - The delay buffer. Live, the figures show the world of `now − LOOKAHEAD_MS`; the director itself works at `now`, so what is about to
//     be drawn (`known`: the calls that have reached it and are not on screen yet) is known before it is. A replay knows all of its future
//     and has no delay (`delay` 0). The picture in the diagram is not delayed — only the figures' acting.
//   - No jumps. A worker starts from where it stood (./place.ts `compute`: the tray the first time) and walks to where its work lands — or, over
//     CUT_DISTANCE, is cut across: for CUT_MS it is drawn twice, fading in where it goes (`alpha`) while it fades out where it was (`ghost`), the
//     two opacities adding up to one. Never two full figures, never one that is suddenly somewhere else.
// Pure: no DOM, no clock; the caller says what time it is.
import { CUT_DISTANCE, CUT_MS, placeOfSeg, stateAt, type Ctx, type RunState } from "./place";
import { tripAt, type Pt } from "./rig";
import type { Fit } from "./replayFit";
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
export type DirectorIn = { runs: readonly WorkRun[]; now: number; delay: number; ctx: Ctx };
export type DirectorOut = { t: number; figures: FigureFrame[]; known: Known[] };

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

/** Whether the figure is still on its way at `now` (a trip that is not over, or a cut still fading): the live camera does not go home while it is — it goes home once the figure stands. */
export function figureMoving(run: WorkRun, ctx: Ctx, now: number, delay = LOOKAHEAD_MS): boolean {
  const f = directorFrame({ runs: [run], now, delay, ctx }).figures[0];
  return !!f && ((!!f.state.trip && f.state.w < 1) || (!!f.ghost && f.ghost.alpha > 0.001));
}

/** Where a figure's feet are in a frame (world coordinates, before the place's slot offsets): along its trip, else at its place's dock. */
export function figureAt(f: FigureFrame, ctx: Pick<Ctx, "dock">): Pt {
  const trip = f.state.trip;
  return trip && f.state.w < 1 ? tripAt(trip, f.t).root : ctx.dock(f.state.at);
}

// ── the camera ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A shot is what the person is shown: the followed figure with the room its head and bubble take (./replayFollow.ts `followView` frames it).
// The camera holds while that frame is where the view is (`hold`), follows it (`follow`), or — when it is over CUT_DISTANCE away — cuts to it
// (`cut`, decided once: the picture cross-fades, ./replayView.ts). Following is a rate-limited carrot the view chases as a critically damped
// spring: a start and a stop are eased, the speed never jumps, whatever the goal does. Zoom is the same, in [ZOOM_MIN, ZOOM_MAX].
/** The carrot's top speed (world units a second), and the spring's natural frequency (a second⁻¹). */
export const CARROT_SPEED = 780;
export const CAMERA_OMEGA = 3.2;
/** How fast the zoom carrot moves (zoom a second), and the zoom the camera keeps to. */
export const ZOOM_RATE = 0.8;
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1;
/** The place a figure is going to is framed with it only when it is this near (world units): a shot holds one cluster, a far place is a cut. */
export const SHOT_REACH = 520;
/** After a cut the camera does not cut again for this long (a shot is decided once; no going back and forth). */
export const CUT_COOLDOWN_MS = 1500;

type Pane = { w: number; h: number };
/** The camera: where the view is (its centre in world coordinates, and zoom), how fast it moves, the carrot it chases, and whether it is on its way. */
export type CameraState = { at: { x: number; y: number; zoom: number }; v: { x: number; y: number; z: number }; carrot: { x: number; y: number; zoom: number }; following: boolean; lastCutAt: number; /** 「继续」 took over from a view the person left: no distance cut until the camera has come within CUT_DISTANCE of the shot (it glides). */ handoff?: boolean };
/** What the shot wants: the frame (Excalidraw's view) and whether it is off from where the view is (`move`: outside the dead zone). null: no shot. */
export type CameraGoal = { view: Fit; move: boolean; /** The way home, back to the view the person had: their own zoom is kept, not held to the shot's range. */ home?: boolean } | null;
export type CameraOut = { state: CameraState; view: Fit; mode: "follow" | "hold" | "cut" | "manual"; /** This frame is the cut: the view is at the goal from here on. */ cut: boolean };

/** Excalidraw's view (screen = (scene + scroll) × zoom) as the world point at the middle of the pane, and back. */
export const centreOf = (v: Fit, pane: Pane) => ({ x: pane.w / 2 / v.zoom - v.scrollX, y: pane.h / 2 / v.zoom - v.scrollY });
export const viewAt = (c: { x: number; y: number }, zoom: number, pane: Pane): Fit => ({ zoom, scrollX: pane.w / 2 / zoom - c.x, scrollY: pane.h / 2 / zoom - c.y });

/** A camera at rest on `view`. */
export function cameraStart(view: Fit, pane: Pane): CameraState {
  const c = centreOf(view, pane);
  const at = { x: c.x, y: c.y, zoom: view.zoom };
  return { at, v: { x: 0, y: 0, z: 0 }, carrot: { ...at }, following: false, lastCutAt: -Infinity };
}
/** 「继续」: the camera takes over from the view the person left (no jump, and no cut however far the shot is: it glides there), keeping what it knows of its last cut. */
export const cameraResume = (s: CameraState, view: Fit, pane: Pane): CameraState => ({ ...cameraStart(view, pane), lastCutAt: s.lastCutAt, handoff: true });

/** One step of a critically damped spring toward `target` (exact for a constant target). */
function spring(x: number, v: number, target: number, dt: number): [number, number] {
  const w = CAMERA_OMEGA;
  const e = Math.exp(-w * dt);
  const d = x - target;
  const j = v + w * d;
  return [target + (d + j * dt) * e, (v - j * w * dt) * e];
}
const clampV = (x: number, y: number, max: number): [number, number] => {
  const n = Math.hypot(x, y);
  return n > max ? [(x / n) * max, (y / n) * max] : [x, y];
};

/** One frame of the camera: `dt` ms since the last, `now` in ms, the pane size, `manual` while the person has the camera. Pure. */
export function cameraStep(s: CameraState, goal: CameraGoal, o: { dt: number; now: number; pane: Pane; manual?: boolean; /** The zoom range, when not the live camera's (the build replay fits a whole diagram, down to 0.55). */ zoom?: { min: number; max: number }; /** The figure was cut across this frame (the build replay's hop): the shot changes with it, whatever the distance. */ cut?: boolean }): CameraOut {
  const dt = Math.min(o.dt, 100) / 1000;
  if (o.manual) return { state: s, view: viewAt(s.at, s.at.zoom, o.pane), mode: "manual", cut: false };
  const gc = goal ? centreOf(goal.view, o.pane) : null;
  // the way home goes to the person's own zoom, whatever it is; every other shot is held to the range
  const zmin = goal?.home ? Math.min(o.zoom?.min ?? ZOOM_MIN, goal.view.zoom) : (o.zoom?.min ?? ZOOM_MIN);
  const zmax = goal?.home ? Math.max(o.zoom?.max ?? ZOOM_MAX, goal.view.zoom) : (o.zoom?.max ?? ZOOM_MAX);
  const gz = goal ? Math.max(zmin, Math.min(zmax, goal.view.zoom)) : s.at.zoom;
  let following = !!goal && (goal.move || s.following);
  // a shot over CUT_DISTANCE away is cut to, once; the picture cross-fades in the driver, the view is simply there
  const dist = gc ? Math.hypot(gc.x - s.at.x, gc.y - s.at.y) : 0;
  const handoff = !!s.handoff && dist > CUT_DISTANCE; // a resumed camera glides to a far shot; once it is near enough the handoff is over
  const far = !!gc && dist > CUT_DISTANCE && !s.handoff && o.now - s.lastCutAt >= CUT_COOLDOWN_MS;
  if (gc && following && (far || o.cut)) {
    const at = { x: gc.x, y: gc.y, zoom: gz };
    return { state: { at, v: { x: 0, y: 0, z: 0 }, carrot: { ...at }, following: true, lastCutAt: o.now }, view: viewAt(at, gz, o.pane), mode: "cut", cut: true };
  }
  const carrot = { ...s.carrot };
  if (following && gc) {
    const [mx, my] = clampV(gc.x - carrot.x, gc.y - carrot.y, CARROT_SPEED * dt);
    carrot.x += mx;
    carrot.y += my;
    carrot.zoom += Math.max(-ZOOM_RATE * dt, Math.min(ZOOM_RATE * dt, gz - carrot.zoom));
  } else {
    // holding: the carrot stays where the view is, and the spring runs the speed out
    carrot.x = s.at.x;
    carrot.y = s.at.y;
    carrot.zoom = s.at.zoom;
  }
  const [x, vx] = spring(s.at.x, s.v.x, carrot.x, dt);
  const [y, vy] = spring(s.at.y, s.v.y, carrot.y, dt);
  const [z, vz0] = spring(s.at.zoom, s.v.z, carrot.zoom, dt);
  // the spring may run a hair past its carrot; the zoom never leaves the range (a view that starts outside it, a play's overview, eases in)
  const zoom = Math.max(Math.min(zmin, s.at.zoom), Math.min(Math.max(zmax, s.at.zoom), z));
  const vz = zoom === z ? vz0 : 0;
  if (following && gc && Math.hypot(gc.x - x, gc.y - y) < 2 && Math.hypot(vx, vy) < 5 && Math.abs(gz - zoom) < 0.005) following = false;
  const state: CameraState = { at: { x, y, zoom }, v: { x: vx, y: vy, z: vz }, carrot, following, lastCutAt: s.lastCutAt, ...(handoff && following ? { handoff: true } : {}) };
  return { state, view: viewAt(state.at, state.at.zoom, o.pane), mode: following ? "follow" : "hold", cut: false };
}

/**
 * The view a canvas gets when the camera switches to it. Live: the view the person left on the way home, else the shot, else the canvas's fit
 * held to the zoom range and never the whole diagram (FL2 root cause 6: a paused camera's switch fitted a large diagram, zoom 1 → 0.3 in one
 * frame). A play may show the whole diagram (its overview, its summary).
 */
export function switchView(i: { live: boolean; restore: boolean; home: boolean; homeView: Fit | null; follow: Fit | null; fit: Fit | null; pane: Pane }): Fit | null {
  const held = i.fit && i.live ? viewAt(centreOf(i.fit, i.pane), Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, i.fit.zoom)), i.pane) : i.fit;
  if (i.restore && i.home) return i.homeView ?? held;
  return (i.restore ? null : i.follow) ?? held;
}

/** Whether a place (its box, world coordinates) belongs in the shot of a figure at `figure`: its middle is within SHOT_REACH. */
export const inShot = (figure: Pt, box: { x: number; y: number; w: number; h: number }): boolean => Math.hypot(box.x + box.w / 2 - figure.x, box.y + box.h / 2 - figure.y) <= SHOT_REACH;
