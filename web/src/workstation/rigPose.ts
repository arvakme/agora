// Standing poses and the per-frame solve (./rig.ts): what a worker's hands, lean and head aim for in each
// state (poseTargets), smoothed by springs and solved with IK into joints (solve).

import { layerStep, STAND, standMotion, type Layer } from "./poses";
import type { Gesture } from "./gestures";
import { type Bone, clamp, ik, mix, type Pt, RIG, Spring, wrapAngle } from "./rigCore";
import { DOWN_BEHIND, DOWN_LEAN, DOWN_SWAY_MAX, RAISED, SHOULDER, type Trip, tripAt, TURN_MS } from "./rigTrip";

export type Pose = "walk" | "read" | "write" | "exec" | "think" | "wait" | "idle" | "delegate" | "handoff" | "unknown";
export type Prop = "laptop" | "terminal" | "sheet" | "carry" | null;
export type Targets = { near: [number, number]; far: [number, number]; lean: number; tilt: number; sway: number; prop: Prop; mark: "?" | "!" | null; markMuted?: boolean; facing: 1 | -1; /** Hips' height added (figure units; negative = higher): standing straight-legged is −0.6. */ crouch?: number; /** The head's turn: an offset (figure units, x along the facing) it looks toward. */ look?: [number, number] };

/** The standing pose (./poses.ts STAND): hands behind the back, leaning a little, legs straight, and what it does by itself — breathing, shifting, a look now and then. */
function standTargets(t: number, o: { still: boolean; seed?: number }): Pick<Targets, "near" | "far" | "lean" | "tilt" | "sway" | "crouch" | "look"> {
  const m = standMotion(t, o.seed ?? 0, o.still);
  return { near: [...STAND.near], far: [...STAND.far], lean: STAND.lean, tilt: m.tilt, sway: m.sway, crouch: STAND.crouch + m.crouch, look: m.look };
}

/**
 * The pose's targets at time t (ms; pure). Hands are relative to the shoulder, x along the facing.
 * `since`: ms into the current segment. `bump`: 0→1→0 over the first 800 ms of a conflict.
 */
export function poseTargets(pose: Pose, t: number, since: number, o: { still: boolean; conflict?: boolean; bump?: number; unknownReceipt?: boolean; coarse?: boolean; seed?: number }): Targets {
  // `t` drives only the small loops (breathing, typing): the caller passes wall-clock time, so a
  // 16× replay does not make hands flicker. What the worker does comes from the timeline.
  const s = t / 1000;
  const osc = (period: number, amp: number, off = 0) => (o.still ? 0 : Math.sin((s / period + off) * 2 * Math.PI) * amp);
  // Hand targets are Loom's (for its arm, 19.4 long; scaled to ours at the end): the still pose, plus the loops.
  const T: Targets = { near: [1.8, 18.4], far: [-1.2, 18.6], lean: 0, tilt: 0, sway: osc(3.6, 0.7), prop: null, mark: null, facing: 1 };
  switch (pose) {
    case "write": {
      // both hands on the keyboard at the standing desk, typing
      const tap = (off: number) => (o.still ? 0 : Math.max(0, Math.sin((s / 0.3 + off) * 2 * Math.PI)) * 1.8);
      T.near = [11, 13.5 - tap(0)];
      T.far = [9.2, 14.2 - tap(0.5)];
      T.lean = 6;
      T.tilt = 8;
      T.prop = "laptop";
      T.sway = 0;
      break;
    }
    case "exec": {
      // a gesture: reach out and press enter on the terminal, then watch the run
      const u = since / 1000;
      const press = o.still ? 0 : u < 0.7 ? Math.sin(Math.PI * (u / 0.7)) : Math.max(0, Math.sin(((u - 0.7) / 2.4) * 2 * Math.PI)) ** 8 * 0.6;
      T.near = [12.4 + press * 2.8, 13.2 - press * 1.6];
      T.far = [6.8, 15.6];
      T.lean = 3 + press * 2;
      T.tilt = 5;
      T.prop = "terminal";
      T.sway = 0;
      break;
    }
    case "read": // holds a page in both hands, head down
      T.near = [8.4, 8.6 + osc(2.6, 0.6)];
      T.far = [6.8, 9.6 + osc(2.6, 0.6)];
      T.tilt = 14;
      T.lean = 2;
      T.prop = "sheet";
      T.sway = osc(4, 0.4);
      break;
    case "think": // chin in hand, looking up
      T.near = [4.2, -3.4];
      T.far = [4.6, 10.4];
      T.tilt = -10 + osc(3.2, 2);
      T.lean = -1.5;
      break;
    case "wait": // a raised hand, held still: ./gestures.ts waves it every 6–8 s
      T.near = [...RAISED];
      T.far = [-0.4, 18.2];
      T.tilt = -8;
      T.lean = -2;
      T.mark = "?";
      break;
    case "idle":
      Object.assign(T, standTargets(t, o));
      break;
    case "delegate": // points: "you, go do this"
      T.near = [17.6 + osc(0.9, 1), -0.6];
      T.far = [0.8, 17.4];
      T.lean = 3;
      T.tilt = -3;
      T.sway = 0;
      break;
    case "handoff": // turn to the dispatcher and hold out the result
      T.facing = -1;
      T.near = [13.2, 6.8];
      T.far = [11.6, 7.8];
      T.lean = 5;
      T.tilt = 5;
      T.prop = "carry";
      T.sway = 0;
      break;
    case "unknown":
      Object.assign(T, standTargets(t, o));
      T.tilt += 4;
      // Known only by its receipts: it stays put with a grey ?.
      if (o.unknownReceipt || o.coarse) {
        T.mark = "?";
        T.markMuted = true;
      }
      break;
    case "walk":
      break;
  }
  if (o.conflict) {
    // blocked: a visible bump when both reach the same file, then keep going, flagged — the recoil
    // (leaning back, hands up) blends in and out with the bump, so the hands never jump to it
    T.mark = "!";
    const bump = o.bump ?? 0;
    if (bump > 0) {
      T.lean = mix(T.lean, -9, bump);
      T.near = [mix(T.near[0], 7, bump), mix(T.near[1], -4.6, bump)];
      T.far = [mix(T.far[0], 4.7, bump), mix(T.far[1], -1.1, bump)];
      T.tilt = mix(T.tilt, -12, bump);
    }
  }
  // from Loom's arm to ours
  const k = (RIG.upper + RIG.fore) / 19.4;
  T.near = [T.near[0] * k, T.near[1] * k];
  T.far = [T.far[0] * k, T.far[1] * k];
  return T;
}

/** A pose's targets with a gesture over them (./gestures.ts): hand targets by their weights and
 * offsets, lean and tilt added, what is in hand. (Facing, hips and feet are solve's.) */
export function withGesture(T: Targets, G: Gesture): Targets {
  const hand = (p: [number, number], to: readonly [number, number] | undefined, w = 0, add?: readonly [number, number]): [number, number] => [mix(p[0], to?.[0] ?? p[0], w) + (add?.[0] ?? 0), mix(p[1], to?.[1] ?? p[1], w) + (add?.[1] ?? 0)];
  return { ...T, near: hand(T.near, G.near, G.nearW, G.nearAdd), far: hand(T.far, G.far, G.farW, G.farAdd), lean: T.lean + (G.lean ?? 0), tilt: T.tilt + (G.tilt ?? 0), prop: G.prop !== undefined ? G.prop : T.prop };
}

/** A worker's springs (smooth hands, lean, head tilt, sway), kept per run between frames. */
export type Springs = { t: number | null; nx: Spring; ny: Spring; fx: Spring; fy: Spring; lean: Spring; tilt: Spring; sway: Spring; /** The turn in progress: from `turnFrom` (−1 = still facing the old way) to 1, starting at wall time `turnAt`. */
  turnFrom: number; turnAt: number; f: 1 | -1 | 0; prop: Spring; propKind: Prop;
  /** What the worker is doing and the blend into it (./poses.ts), what its pose alone asked for last frame, the pose-level hip height, and a number of its own so two workers do not breathe together. */
  layer: Layer | null; eff: Targets | null; hipY: Spring; seed: number };
let made = 0;
export function makeSprings(): Springs {
  const hand = () => new Spring(3.2, 0.55, 0.4);
  // a hand's angle about its shoulder turns on a slower spring than its distance: the arc is longer than the chord it replaces, so the swing keeps the pace it had
  const swing = () => new Spring(2.5, 0.55, 0.4);
  // The body settles with a small, damped overshoot (arriving, standing up from a pose).
  const body = () => new Spring(2.2, 0.5, 0.3);
  return { t: null, nx: swing(), ny: hand(), fx: swing(), fy: hand(), lean: body(), tilt: new Spring(3, 0.45, 1.2), sway: body(), turnFrom: 1, turnAt: -Infinity, f: 0, prop: new Spring(4, 0.9, 0), propKind: null, layer: null, eff: null, hipY: new Spring(2.2, 0.9, 0), seed: made++ };
}

/** Where a turn is at wall time `wall`: −1 … 1, eased (smoothstep), 1 when done. */
function turnValue(sp: Pick<Springs, "turnFrom" | "turnAt">, wall: number): number {
  if (sp.turnFrom >= 1) return 1;
  const dur = (TURN_MS * (1 - sp.turnFrom)) / 2;
  const u = Math.min(1, Math.max(0, (wall - sp.turnAt) / dur));
  const e = u * u * (3 - 2 * u);
  const v = sp.turnFrom + (1 - sp.turnFrom) * e;
  if (u >= 1) sp.turnFrom = 1;
  return v;
}

/** Solved joints in figure space (origin = the root on the ground, facing applied). */
export type Joints = {
  root: Pt;
  f: 1 | -1;
  px: number;
  py: number;
  nx: number;
  ny: number;
  hx: number;
  hy: number;
  shx: number;
  shy: number;
  legN: Bone;
  legF: Bone;
  armN: Bone;
  armF: Bone;
  hipN: Pt;
  hipF: Pt;
  shN: Pt;
  shF: Pt;
  prop: Prop;
  /** 0 → 1 while a prop (laptop, sheet, terminal) fades and scales in; the kind fading out stays until 0. */
  propAlpha: number;
  /** Horizontal scale while turning: −1 (still facing the old way) → 1 (facing the new way). */
  turn: number;
  mark: Targets["mark"];
  markMuted: boolean;
  /** On a trip (walking or climbing). */
  walking: boolean;
  /** 0 → 1 getting onto a ladder, 1 on it (the feet are off the ground), 1 → 0 getting off. */
  climb: number;
  /** From ./gestures.ts, for the drawing (./figureNode.ts): the whole figure scaled about its feet and
   * raised (a landing), the head turned toward a point (figure space), the screen flashing (a save),
   * a command's verdict on the terminal, a page in the near hand (taking one: on its way from the hand that gives it). */
  scale?: number;
  lift?: number;
  look?: Pt | null;
  flash?: number;
  result?: { ok: boolean; a: number };
  hold?: number;
  holdFrom?: Pt;
  holdU?: number;
  /** Gliding along an arrow (§5 沿箭头滑行): 0 the figure … 1 the capsule that carries its avatar along the line, and the line's heading there (radians, world). */
  capsule?: number;
  heading?: number;
  /** Hopping (§5 跳过去): 0 on the floor … 1 in the air (no shadow under it). */
  air?: number;
};

/**
 * Solve one worker at timeline time t: from its dock (standing) or its trip (walking, climbing), the
 * pose's targets and its springs. `k`: world px per figure unit as drawn (a trip's feet and holds are
 * world points). `gaze`: what it looks at while it stands there (a glance at another node: it turns to
 * it, head tipped that way). Springs integrate wall-clock time (`dt`, seconds), so a replay at 16× still
 * blends at human speed. They are reset only on a real jump (`reset`: a seek or scrub, or the tab
 * coming back after a long pause), so a paused frame is exact and live updates blend.
 */
export function solve(o: { t: number; wall?: number; dt?: number; reset?: boolean; pose: Pose; since: number; dock: Pt; trip: Trip | null; k?: number; gaze?: Pt | null; still: boolean; conflict?: boolean; bump?: number; unknownReceipt?: boolean; coarse?: boolean; readingWhileWalking?: boolean; gest?: Gesture }, sp: Springs): Joints {
  const { t, still } = o;
  const wall = o.wall ?? t;
  const k = o.k ?? 1;
  const trip = !still && o.trip && t >= o.trip.t0 && t < o.trip.t1 ? tripAt(o.trip, t) : null;
  const root: Pt = trip ? trip.root : { ...o.dock };
  // a trip's feet and holds are world points: into figure space (from the root, in figure units)
  const local = (p: Pt): Pt => ({ x: (p.x - root.x) / k, y: (p.y - root.y) / k });
  const climb = trip?.climb ?? 0;
  const hold = trip?.hands?.map(local);
  let f: 1 | -1 = trip ? trip.f : 1;
  let feet: Pt[];
  let bob = 0;
  let T: Targets;
  if (trip) {
    feet = trip.feet.map(local);
    bob = (1 - climb) * Math.min(2.2, (Math.abs(feet[0].x - feet[1].x) + Math.abs(feet[0].y - feet[1].y)) * 0.09);
    // arms swing against the legs (each hand opposite its foot); on a ladder they reach for the rungs
    const hang = 0.887 * (RIG.upper + RIG.fore);
    // going down a ladder the body comes in to it — the hips over the feet, not sat back on the rungs, the torso tipped to it — by how far onto the ladder it is
    const snug = trip.snug ? climb : 0;
    const over = clamp(((feet[0].x + feet[1].x) / 2) * f - 0.8 - DOWN_BEHIND, 0, DOWN_SWAY_MAX);
    T = { near: [1 - 0.5 * feet[0].x * f, hang], far: [0.2 - 0.5 * feet[1].x * f, hang], lean: mix(3, 5, climb) + DOWN_LEAN * snug, tilt: 0, sway: over * snug, prop: o.readingWhileWalking && climb < 0.5 ? "carry" : null, mark: null, facing: 1 };
    // hopping (§5 跳过去): the arms swing back in the crouch, up in the air, out for the landing (the springs carry them between); nothing carried
    if (trip.arms) T = { ...T, near: [...trip.arms.near], far: [...trip.arms.far], lean: trip.arms.lean, prop: null };
  } else {
    T = poseTargets(o.pose, wall, o.since, { still, conflict: o.conflict, bump: o.gest?.bump ?? o.bump, unknownReceipt: o.unknownReceipt, coarse: o.coarse, seed: sp.seed });
    if (T.facing === -1) f = -1;
    if (o.gaze) {
      // a glance: turned toward what it looks at, head tipped up or down to it
      const dx = o.gaze.x - root.x;
      if (Math.abs(dx) > 1) f = dx < 0 ? -1 : 1;
      const head = root.y - (RIG.hip + RIG.torso + RIG.head) * k;
      T.tilt = clamp((Math.atan2(o.gaze.y - head, Math.abs(dx) + k) * 180) / Math.PI, -30, 30);
    }
    // a gesture: facing a sub-agent handing something over, or turned round to the person
    if (o.gest?.face) f = o.gest.face;
    else if (o.gest?.turn) f = f === 1 ? -1 : 1;
    feet = [
      { x: RIG.stance * f, y: 0 },
      { x: -RIG.stance * f, y: 0 },
    ];
  }
  // Without an explicit wall-clock step (tests, one-off solves), fall back to the timeline step.
  const dt = o.dt ?? (sp.t == null ? -1 : (t - sp.t) / 1000);
  const jump = still || !!o.reset || sp.t == null || dt < 0 || dt > 1;
  sp.t = t;
  const step = Math.min(dt, 0.05);
  // What the worker is doing (its pose, or walking) is blended into the last frame's over ./poses.ts BLEND_MS — through a raise of the hands going into an activity, a clap
  // coming out of one — so nothing switches in one frame; the gestures go over that afterwards, each with its own weights.
  const armK = (RIG.upper + RIG.fore) / 19.4;
  const layered = layerStep(sp.layer, trip ? "walk" : o.pose, T, sp.eff, wall, jump, armK);
  sp.layer = layered.layer;
  T = layered.T;
  sp.eff = T;
  // Gestures (./gestures.ts) over the pose; sitting on the node's edge moves the feet out over it.
  const G = o.gest;
  const sit = G?.sit?.w ? G.sit : null;
  if (G) T = withGesture(T, G);
  if (sit) feet = feet.map((p, i) => ({ x: mix(p.x, sit.feet[i].x * f, sit.w), y: mix(p.y, sit.feet[i].y, sit.w) }));
  const S = (s: Spring, x: number) => (jump ? s.reset(x) : s.step(step, x));
  // A hand moves along an arc about its shoulder, not along the chord: the springs run on its angle and its distance from the shoulder
  // (the same four springs). An elbow is placed by the angle of the hand (`ik`), and a hand that crosses over the shoulder — from
  // hanging to raised, or onto a rung — on a straight line swings that angle half a circle within a few frames and the elbow with it,
  // 10–19 units in one frame (web/docs/workstation.md §16). On the arc the distance stays what the two ends give it and the angle turns steadily.
  const swing = (sa: Spring, sr: Spring, h: readonly [number, number]): number[] => {
    const r = Math.hypot(h[0], h[1]);
    const a = Math.atan2(h[1], h[0]);
    const ang = jump || sa.xp == null ? sa.reset(a) : sa.step(step, sa.y + wrapAngle(a - sa.y));
    const rad = S(sr, r);
    return [rad * Math.cos(ang), rad * Math.sin(ang), ang];
  };
  const near = swing(sp.nx, sp.ny, T.near);
  const far = swing(sp.fx, sp.fy, T.far);
  const lean = S(sp.lean, T.lean);
  const tilt = S(sp.tilt, T.tilt);
  const sway = S(sp.sway, T.sway);

  // Turning: when the facing flips, the figure is redrawn for the new facing but mirrored (so it
  // still looks the old way) and its horizontal scale eases from −1 through 0 (edge-on) to 1 over
  // TURN_MS of wall-clock time. Limbs, props and springs all live in facing-local coordinates, so
  // nothing swings across; a turn reversed half-way continues from where it is. A jump in time
  // (seek, scrub) faces the right way at once.
  if (sp.f !== f) {
    if (sp.f !== 0 && !jump) {
      sp.turnFrom = -turnValue(sp, wall);
      sp.turnAt = wall;
    }
    sp.f = f;
  }
  if (jump) {
    sp.turnFrom = 1;
    sp.turnAt = -Infinity;
  }
  const turn = turnValue(sp, wall);
  // Props fade and scale in and out (never pop): the old one shrinks away before the new one grows.
  let propAlpha: number;
  if (jump) {
    sp.propKind = T.prop;
    propAlpha = sp.prop.reset(T.prop ? 1 : 0);
  } else if (T.prop === sp.propKind) propAlpha = sp.prop.step(step, T.prop ? 1 : 0);
  else {
    propAlpha = sp.prop.step(step, 0);
    if (propAlpha < 0.05) sp.propKind = T.prop;
  }
  const L = (x: number) => x * f;
  const px = L(sway);
  // on a ladder the knees bend: the hips sink to the climbing height (a gesture's crouch lowers them;
  // sitting puts them on the node's edge)
  const hipY = S(sp.hipY, T.crouch ?? 0); // the pose's hip height eases (standing straight-legged is 0.6 higher than walking)
  // never higher than the straight leg reaches (a walk's bob on top of the standing height would hang the foot)
  const hipH = Math.min(RIG.thigh + RIG.shin - 0.25, (trip ? trip.hip : RIG.hip) - bob * 0.6 - hipY - (G?.crouch ?? 0));
  const py = mix(-hipH, -(sit?.hip ?? 0), sit?.w ?? 0);
  const leanR = (lean * Math.PI) / 180;
  const nx = px + Math.sin(leanR) * RIG.torso * f;
  const ny = py - Math.cos(leanR) * RIG.torso;
  const shx = nx - L(0.4);
  const shy = ny + SHOULDER;
  const tiltR = (tilt * Math.PI) / 180;
  const hx = nx + L(0.8) + Math.sin(tiltR) * 2 * f;
  const hy = ny - RIG.head - 0.6 + Math.abs(Math.sin(tiltR)) * 0.8;
  const hipN = { x: px + L(0.8), y: py };
  const hipF = { x: px - L(0.8), y: py };
  const shN = { x: shx + L(0.6), y: shy };
  const shF = { x: shx - L(0.6), y: shy };
  // the hands: the pose's (through the springs), drawn onto their holds while getting on a ladder
  // A hand goes onto a rung along an arc about the shoulder (same reason as `swing`), from where the pose has it (h[2]: the spring's own angle, which turns steadily through the line straight behind, where `atan2` would
  // flip by a full turn) to the rung's angle (from the facing, 0 = straight ahead, + down): from hanging (+90°) to a rung overhead (−90°) it goes through ahead, never round behind the body.
  const reach = (h: number[], at: Pt | undefined): [number, number] => {
    const x = shx + L(h[0]);
    const y = shy + h[1];
    if (!at) return [x, y];
    const a0 = h[2];
    const a1 = Math.atan2(at.y - shy, (at.x - shx) * f);
    const a = mix(a0, a1, climb);
    const r = mix(Math.hypot(x - shx, y - shy), Math.hypot(at.x - shx, at.y - shy), climb);
    return [shx + f * r * Math.cos(a), shy + r * Math.sin(a)];
  };
  const [nhx, nhy] = reach(near, hold?.[0]);
  const [fhx, fhy] = reach(far, hold?.[1]);
  return {
    root,
    f,
    px,
    py,
    nx,
    ny,
    hx,
    hy,
    shx,
    shy,
    legN: ik(hipN.x, hipN.y, feet[0].x, feet[0].y, RIG.thigh, RIG.shin, -f),
    legF: ik(hipF.x, hipF.y, feet[1].x, feet[1].y, RIG.thigh, RIG.shin, -f),
    armN: ik(shN.x, shN.y, nhx, nhy, RIG.upper, RIG.fore, f),
    armF: ik(shF.x, shF.y, fhx, fhy, RIG.upper, RIG.fore, f),
    hipN,
    hipF,
    shN,
    shF,
    prop: sp.propKind,
    propAlpha: Math.max(0, Math.min(1, propAlpha)),
    turn: Math.max(-1, Math.min(1, turn)),
    mark: T.mark,
    markMuted: !!T.markMuted,
    walking: !!trip,
    climb,
    scale: G?.scale,
    lift: G?.lift,
    look: G?.look ?? (T.look && (T.look[0] || T.look[1]) ? { x: hx + T.look[0] * 10 * f, y: hy + T.look[1] * 10 } : null),
    flash: G?.flash,
    result: G?.result,
    hold: G?.hold,
    holdFrom: G?.holdFrom,
    holdU: G?.holdU,
    capsule: trip?.capsule,
    heading: trip?.heading,
    air: trip?.air,
  };
}
