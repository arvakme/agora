// The workers' procedural rig (web/docs/workstation.md §小人).
//
// Inspired by Loom Studio (loom-studio-sep-2026.moldandyeast.com, by RM / moldandyeast), whose page
// describes its figures: poses solved every frame with no keyframes, second-order dynamics on the
// body and joints, two-bone IK for arms and legs, and footsteps planned ahead so feet plant. None
// of its code is used here; this is an independent implementation of those published techniques
// (first written for the 工位视图 prototype, then ported here).
//
// What keeps replay exact:
//   - WHAT a worker does and WHERE its hands and feet are is a pure function of the timeline time t
//     (stateAt in ./place.ts, planTrip / tripAt here). Scrubbing to t and playing up to t agree.
//   - Springs only smooth hands, lean and head between those targets. On a jump (seek, time going
//     backwards, a long gap) they are reset to the target, so a paused frame is always the exact pose.
// Times are milliseconds; lengths are figure units (1 unit = 1 CSS px at scale 1), ground y = 0, up −y.

import { REF_K } from "./docks";
import { isStand, layerStep, STAND, standMotion, type Layer } from "./poses";
import type { Gesture } from "./gestures";
import type { Leg, Route } from "./route";

export type Pt = { x: number; y: number };

/** Second-order system y + k1·y' + k2·y'' = x + k3·x' (f: frequency Hz, z: damping, r: response). dt in seconds. */
export class Spring {
  k1: number;
  k2: number;
  k3: number;
  xp: number | null = null;
  y = 0;
  yd = 0;
  constructor(f: number, z: number, r: number) {
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / (2 * Math.PI * f) ** 2;
    this.k3 = (r * z) / (2 * Math.PI * f);
  }
  reset(x: number) {
    this.xp = x;
    this.y = x;
    this.yd = 0;
    return x;
  }
  step(dt: number, x: number) {
    if (this.xp == null) return this.reset(x);
    if (dt <= 0) return this.y;
    const xd = (x - this.xp) / dt;
    this.xp = x;
    // stays stable at big steps (a 4× replay, a slow frame)
    const k2 = Math.max(this.k2, (dt * dt) / 2 + (dt * this.k1) / 2, dt * this.k1);
    this.y += dt * this.yd;
    this.yd += (dt * (x + this.k3 * xd - this.y - this.k1 * this.yd)) / k2;
    return this.y;
  }
}

/**
 * A retargetable glide (cubic Hermite in time): from where it is, with the speed it has, to a new
 * target that it reaches at rest after `D` seconds. Starting from rest its acceleration is small
 * (6·Δ/D²), and a new target mid-flight keeps position and speed continuous — no pop, no lurch.
 * Used for bubbles moving or flipping sides. `now` in seconds.
 */
export class Glide {
  p0 = 0;
  v0 = 0;
  p1 = 0;
  t0 = 0;
  D = 0.4;
  started = false;
  reset(x: number, now: number) {
    this.p0 = this.p1 = x;
    this.v0 = 0;
    this.t0 = now;
    this.started = true;
    return x;
  }
  private at(now: number): [number, number] {
    const u = this.D > 0 ? Math.min(1, Math.max(0, (now - this.t0) / this.D)) : 1;
    if (u >= 1) return [this.p1, 0];
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const p = h00 * this.p0 + h10 * this.D * this.v0 + h01 * this.p1;
    const d00 = 6 * u2 - 6 * u;
    const d10 = 3 * u2 - 4 * u + 1;
    const d01 = -6 * u2 + 6 * u;
    const v = (d00 * this.p0 + d01 * this.p1) / this.D + d10 * this.v0;
    return [p, v];
  }
  /** Position at `now`, heading for `target` (a changed target starts a new glide from here). */
  step(now: number, target: number) {
    if (!this.started) return this.reset(target, now);
    if (Math.abs(target - this.p1) > 0.25) {
      const [p, v] = this.at(now);
      this.p0 = p;
      this.v0 = v;
      this.p1 = target;
      this.t0 = now;
      // Long moves take longer; and a glide retargeted mid-flight takes as long as it needs so that
      // neither its start nor its end accelerates harder than A (Hermite: a(0) = (6Δ − 4·D·v0) / D²,
      // a(1) = (2·D·v0 − 6Δ) / D²) — it never brakes or lurches, however often the target moves.
      const A = 2000;
      const d = target - p;
      let D = Math.min(1, 0.42 + Math.abs(d) / 260);
      while (D < 2.5 && (Math.abs(6 * d - 4 * D * v) > A * D * D || Math.abs(2 * D * v - 6 * d) > A * D * D)) D += 0.05;
      this.D = D;
    }
    return this.at(now)[0];
  }
}

/** `over`: how far the target was out of the limb's reach (too far, or too near), which `ik` then clamps: 0 when it was reachable. */
export type Bone = { jx: number; jy: number; ex: number; ey: number; over: number };
/** Two-bone IK by the law of cosines: root (rx, ry) → target (tx, ty), bones a and b. bend +1 bends clockwise (y down). */
export function ik(rx: number, ry: number, tx: number, ty: number, a: number, b: number, bend: number): Bone {
  const dx = tx - rx;
  const dy = ty - ry;
  const d0 = Math.hypot(dx, dy) || 1e-3;
  const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, d0));
  const base = Math.atan2(dy, dx);
  const A = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
  const ang = base + bend * A;
  return { jx: rx + a * Math.cos(ang), jy: ry + a * Math.sin(ang), ex: rx + (dx / d0) * d, ey: ry + (dy / d0) * d, over: Math.max(0, d0 - (a + b), Math.abs(a - b) - d0) };
}

/**
 * Proportions in figure units: Loom Studio's line figure (docs/workstation.md §小人) at 0.936 of its
 * size, head excepted, so the top of the head stays 53.8 above the ground, where it has always been
 * (bubbles hang their tails there). `shin` runs from the knee to the sole (the IK target on the
 * ground); the drawn shin stops `ankle` above the sole, where the `foot` starts. `head` is the head's
 * radius (the neck is head + 0.6).
 */
export const RIG = { hip: 25.45, thigh: 12.54, shin: 13.76, ankle: 1.4, foot: 5.05, torso: 15.35, upper: 9.36, fore: 8.8, head: 6.2, stance: 3.6 };
const smooth = (u: number) => u * u * (3 - 2 * u);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mix = (a: number, b: number, u: number) => a + (b - a) * u;
/** An angle difference brought into −π … π (the short way round). */
const wrapAngle = (d: number) => d - 2 * Math.PI * Math.round(d / (2 * Math.PI));

/** One trip from one place to another, starting at t (ms). `slot` is the spot at the destination; `sub`: a sub-agent's (drawn SUB_SCALE smaller). */
export type Move = {
  from: string;
  to: string;
  t: number;
  slot: number;
  fromSlot?: number;
  ret?: boolean;
  sub?: boolean;
  /** A trip that takes over from one still under way (place.ts CATCH_UP_MS): it starts where the worker is at `t`
   * (not at `from`'s dock; `from` is the nearer end of the trip it leaves), feet as they are, with no pause to set off. */
  resume?: { at: Pt; feet: [Foot, Foot] };
  /** Walking speed factor, > 1 to catch up. */
  boost?: number;
};

/** Sub-agents are drawn this much smaller than the agent that sent them. */
export const SUB_SCALE = 0.8;
/** World px per ms at the top of a walk (floors and bridges) and of a climb, for a figure at the reference
 * scale (REF_K; a smaller one — a sub-agent — is proportionally slower, so its steps keep the same beat).
 * 2026-09-29 用户决定调慢走路: 0.22 = 220 px/s (a step a little under 5 frames); a way is never hurried
 * along to fit a time limit, however far. */
export const WALK_SPEED = 0.22;
export const CLIMB_SPEED = 0.13;
/** A walk or climb gathers speed over this long (and slows over as much) — or over RAMP of its time, when
 * that is shorter (a short one); so a long walk spends its time at WALK_SPEED, not in the ramps. */
export const RAMP_MS = 300;
/** A whole trip — the turn at set-off to the last foot down — takes at least this long: a shorter one is slowed
 * (shorter steps). There is no upper limit: the time is the length ÷ the pace. */
export const TRIP_MIN_MS = 700;
/** How long a turn takes (from facing one way to the other, through edge-on). */
export const TURN_MS = 200;
/** A beat to turn and shift weight before the first step: the turn is over before a foot lifts. */
export const SET_OFF_MS = 240;
/** A climb shorter than this (world px) is a step between floors: walked, no ladder. */
export const STEP_MAX = 12;

// The gait, in figure units (× the trip's k for world px).
const STRIDE = 15; // between footfalls at the natural pace (Loom's 15.3)
const LIFT = 3.4; // how high a swinging foot comes up (and how far a hand or foot comes off a ladder)
const RUNG = 5.5; // rung spacing, about: a ladder's rungs split its height evenly
const GAP = 4; // the body keeps this far off a ladder it climbs; hands and feet reach forward to it
const POST = 22; // the rails reach this far above the upper floor: a handhold getting on and off
const GRAB_MS = 150; // hands and feet go onto a ladder over this much either side of where the climb starts (and off it where it ends)
const RAMP = 0.3; // a walk or a climb gathers speed over this share of its time, and slows over as much
/** World px/ms² at the reference scale (× the figure's scale): no walk or climb gathers speed (or slows) harder — 1200 px/s², under 0.02 px/ms of change a frame at 60 fps. */
export const ACCEL = 0.0008;
/** Between a walk and a climb (a corner: the body turns from level to upright) it goes at this share of the slower one's pace: it eases into the corner and out, never stops. */
const CORNER = 0.6;
/** How far the shoulders sit below the top of the torso. */
const SHOULDER = 2.2;

/** A foot (or a hand on a ladder), world coordinates. `lift`: 0 planted or holding … 1 fully off, mid-move. */
export type Foot = Pt & { lift: number };
type Swing = { foot: 0 | 1; t0: number; t1: number; from: Pt; to: Pt; up: number };
/** One ladder's holds: rung j at y = bot − j·sp (0 the lower floor, n the upper one, top the rails' ends).
 * A limb holds every R-th rung, a diagonal pair moving while the other holds; hands hold m rungs over
 * the feet; `hip`: the hips' height above the feet on it (figure units, knees bent). */
type Rungs = { bot: number; sp: number; n: number; top: number; R: number; m: number; hip: number; /** The hands hold this far ahead of the feet's line (figure units): a door's ladder runs through the body, so without it a hand on a rung passes the shoulder within a unit and the elbow whips round (web/docs/workstation.md §16). */ ahead: number };
/** How the body's speed goes along a walk or climb, over its time fraction u (0 … 1): up from `g0` over the first `a` of it, cruising, down to `g1` over the last `b` (speeds as
 * multiples of length ÷ duration, so a walk that starts from rest has g0 = 0). One phase ends at the speed the next one starts at: the speed is continuous along the whole trip. */
export type Profile = { a: number; b: number; g0: number; g1: number };
/** A stretch that starts and ends at rest, gathering speed over the first `a` share of it and slowing over the last. */
const restProfile = (a: number): Profile => ({ a, b: a, g0: 0, g1: 0 });
type Span = { t0: number; t1: number; a: Pt; b: Pt; f: 1 | -1; prof: Profile };
type WalkPhase = Span & { kind: "walk"; feet: [Foot, Foot]; steps: Swing[]; bumps: { lo: number; hi: number; dy: number }[] };
/** A climb up or down the ladder at x; hands and feet go onto it over `on` ms either side of t0 and off it over `off` ms either side of t1. */
type ClimbPhase = Span & { kind: "climb"; x: number; rungs: Rungs; on: number; off: number };
/** A stretch of a trip, t0 → t1, the root going from a to b, starting and ending at rest. */
type Phase = WalkPhase | ClimbPhase;
/** What a trip draws while it is walked: bridges (level, across a gap) and ladders (rails from `bottom`
 * up to `top`, rungs at `rungs`); `temp`: a scaffold's, not a connector's. */
export type Bridge = { a: Pt; b: Pt; temp: boolean };
export type Ladder = { x: number; top: number; bottom: number; rungs: number[]; temp: boolean };
/** A move planned along its route: t0 → t1 (the turn at set-off included), a → b, for a figure drawn at k world px per figure unit. */
export type Trip = { t0: number; t1: number; a: Pt; b: Pt; f: 1 | -1; k: number; phases: Phase[]; bridges: Bridge[]; ladders: Ladder[] };
/** A worker on a trip at t: root and feet (world), its hands' holds while on a ladder, how far into the
 * climbing stance it is (0 walking … 1 on the ladder), its hip height (figure units) and facing. */
export type TripPose = { root: Pt; feet: [Foot, Foot]; hands: [Foot, Foot] | null; climb: number; hip: number; f: 1 | -1 };

/** Progress 0 → 1 over time fraction u along `P`: the speed goes evenly from g0 up to the cruise over the first `a` of the time, holds it, and evenly down to g1 over the last `b`;
 * the cruise is what makes the whole come to 1. Continuous in speed, whatever g0 and g1 are. */
function prog(u: number, P: Profile): number {
  const { a, b, g0, g1 } = P;
  const gm = (1 - (a * g0 + b * g1) / 2) / (1 - (a + b) / 2);
  const v = clamp(u, 0, 1);
  if (a > 0 && v < a) return g0 * v + ((gm - g0) * v * v) / (2 * a);
  if (b > 0 && v > 1 - b) {
    const w = 1 - v;
    return 1 - (g1 * w + ((gm - g1) * w * w) / (2 * b));
  }
  return (a * (g0 + gm)) / 2 + gm * (v - a);
}
/** When progress p is reached (prog's inverse). */
function progAt(p: number, P: Profile): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (prog(mid, P) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The time (ms) to cover `L` px from speed v0 to v1 at up to `vc`, changing speed at `A` (px/ms²): up to the cruise, along it, down again — or, for a short one, up to a lower peak and down. */
function natural(L: number, v0: number, v1: number, vc: number, A: number): number {
  if (L <= 0) return 0;
  const du = (vc * vc - v0 * v0) / (2 * A);
  const dd = (vc * vc - v1 * v1) / (2 * A);
  if (du + dd <= L) return (vc - v0) / A + (vc - v1) / A + (L - du - dd) / vc;
  const vp = Math.sqrt((2 * A * L + v0 * v0 + v1 * v1) / 2);
  return (vp - v0) / A + (vp - v1) / A;
}
/** The profile that covers `L` px in exactly `T` ms from v0 to v1 changing speed at `A`: the slowest cruise that does it (T is at least the natural time, so it is a cruise
 * at or under the pace). None fits (a stretch too short for the speeds at its ends, a slowed trip): it starts and ends at rest. */
function fitProfile(L: number, T: number, v0: number, v1: number, A: number): Profile {
  if (L <= 0 || T <= 0) return restProfile(0.3);
  const B = A * T + v0 + v1;
  let disc = B * B - 4 * ((v0 * v0 + v1 * v1) / 2 + A * L);
  if (disc < 0 && disc > -1e-6 * B * B) disc = 0; // the natural time of a short stretch is exactly the fit: no room but no less
  if (disc >= 0) {
    const vp = (B - Math.sqrt(disc)) / 2;
    const tu = (vp - v0) / A;
    const td = (vp - v1) / A;
    if (vp >= Math.max(v0, v1) - 1e-12 && tu + td <= T + 1e-9) return { a: tu / T, b: td / T, g0: (v0 * T) / L, g1: (v1 * T) / L };
  }
  return restProfile(Math.min(RAMP, RAMP_MS / T));
}

/**
 * The rung a limb holds while its resting point is at rung z (fractional): the nearest of its own rungs
 * (every R-th from `from`), moving on to the next one while z crosses the middle half between them — a
 * smooth move, off the ladder by `up` 0 → 1 → 0 — within lo…hi.
 */
function holdAt(z: number, from: number, R: number, lo: number, hi: number): { j: number; up: number; lift: number } {
  const q = (z - from) / R - 0.25;
  const i = Math.floor(q);
  const fr = q - i;
  const a = from + R * i;
  const src = clamp(a, lo, hi);
  const dst = clamp(a + R, lo, hi);
  const j = clamp(a + R * (fr < 0.5 ? smooth(fr / 0.5) : 1), lo, hi);
  // between two rungs it is off the ladder (lift > 0 however close to one it is); on a rung, 0
  const up = j > src && j < dst ? Math.sin((Math.PI * (j - src)) / (dst - src)) : 0;
  return { j, up, lift: up ? Math.max(1e-3, up) : 0 };
}

/** Hands and feet on the ladder at x with the body at height y: the near hand moves with the far foot,
 * the far hand with the near foot, the pairs taking turns; a limb between rungs comes off toward the body. */
function holds(r: Rungs, x: number, f: 1 | -1, y: number, k: number): { feet: [Foot, Foot]; hands: [Foot, Foot] } {
  const z = (r.bot - y) / r.sp;
  const at = (h: { j: number; up: number; lift: number }, ahead = 0): Foot => ({ x: x + f * (ahead - h.up * LIFT) * k, y: r.bot - h.j * r.sp, lift: h.lift });
  const half = r.R / 2;
  return {
    feet: [at(holdAt(z, 0, r.R, 0, r.n)), at(holdAt(z, half, r.R, 0, r.n))],
    hands: [at(holdAt(z + r.m, (half + r.m) % r.R, r.R, 1, r.top), r.ahead), at(holdAt(z + r.m, r.m % r.R, r.R, 1, r.top), r.ahead)],
  };
}

/** The rungs of a ladder from y0 to y1 for a figure at k world px per unit, its limbs reaching R rungs a move. */
function rungsOf(y0: number, y1: number, k: number, R: number): Rungs {
  const bot = Math.max(y0, y1);
  const H = bot - Math.min(y0, y1);
  const n = Math.max(1, Math.round(H / (RUNG * k)));
  const sp = H / n;
  // hips low enough that a foot at the bottom of its reach (R/4 rungs under the body) still gets there
  const hip = Math.min(0.8 * RIG.hip, 0.97 * (RIG.thigh + RIG.shin) - (R / 4) * (sp / k));
  const hand = hip + RIG.torso - SHOULDER + 0.5 * (RIG.upper + RIG.fore);
  return { bot, sp, n, top: n + Math.max(1, Math.round((POST * k) / sp)), R, m: Math.max(1, Math.round((hand * k) / sp)), hip, ahead: 0 };
}

/** A walk from a to b (root) over level legs and steps: footsteps, and the body's rise over each step. */
function walkPhase(legs: readonly Leg[], a: Pt, b: Pt, f: 1 | -1, feet: [Foot, Foot], t0: number, t1: number, prof: Profile, stride: number, k: number): WalkPhase {
  const dir = Math.sign(b.x - a.x);
  const L = Math.abs(b.x - a.x);
  const along = (x: number) => clamp((x - a.x) * dir, 0, L);
  // a step between floors: the feet come down on the new floor past it; the body rises (or sinks)
  // over a stretch around it, never at once
  const ups = legs.filter((l) => l.kind === "climb").map((l) => ({ at: along(l.a.x), dy: l.b.y - l.a.y }));
  const bumps = ups.map((s) => {
    const w = Math.min(L, Math.max(24, 4.5 * Math.abs(s.dy)));
    const lo = clamp(s.at - w / 2, 0, L - w);
    return { lo, hi: lo + w, dy: s.dy };
  });
  const floor = (d: number) => a.y + ups.reduce((n, s) => n + (d >= s.at ? s.dy : 0), 0);
  const T = t1 - t0;
  const when = (d: number) => t0 + T * progAt(L ? d / L : 0, prof);
  const st = RIG.stance * k;
  const steps: Swing[] = [];
  const cur: Pt[] = [feet[0], feet[1]];
  const swing = (foot: 0 | 1, s0: number, s1: number, to: Pt) => {
    const d = Math.hypot(to.x - cur[foot].x, to.y - cur[foot].y);
    steps.push({ foot, t0: s0, t1: s1, from: cur[foot], to, up: LIFT * k * clamp(d / stride, 0.3, 1) });
    cur[foot] = to;
  };
  const home = (foot: 0 | 1): Pt => ({ x: b.x + (foot ? -st : st) * f, y: b.y });
  if (L > 0) {
    // n equal steps, the far foot first: each lands half a step ahead of the body and is lifted half a
    // step behind it; the last lands on its spot at the end and the other foot closes up
    const n = Math.max(1, Math.round(L / stride));
    const D = L / n;
    for (let i = 1; i <= n; i++) {
      const foot = (i % 2) as 0 | 1;
      swing(foot, when(Math.max(0, (i - 1.5) * D)), when((i - 0.5) * D), i < n ? { x: a.x + dir * i * D, y: floor(i * D) } : home(foot));
    }
    const other = (n % 2 ? 0 : 1) as 0 | 1;
    swing(other, when((n - 0.5) * D), t1, home(other));
  } else if (b.y !== a.y) {
    // up or down a step where it stands: the far foot, then the near one
    swing(1, t0, t0 + 0.6 * T, home(1));
    swing(0, t0 + 0.4 * T, t1, home(0));
  }
  return { kind: "walk", t0, t1, a, b, f, prof, feet, steps, bumps };
}

/** The feet at the end of a walk: each where its last step put it. */
function lastFeet(ph: WalkPhase): [Foot, Foot] {
  const out: [Foot, Foot] = [ph.feet[0], ph.feet[1]];
  for (const s of ph.steps) out[s.foot] = { ...s.to, lift: 0 };
  return out;
}

/** All the stretches' durations stretched by one factor when the whole is under `B` ms (a short trip is slowed, never a long one hurried). */
function fit(nat: readonly number[], B: number): number[] {
  const all = nat.reduce((a, x) => a + x, 0);
  return all >= B || !all ? [...nat] : nat.map((x) => (x * B) / all);
}

/**
 * A move's trip along its route (pure). Runs of level legs are walked (a step under STEP_MAX included:
 * the feet come down on the new floor, the body rises or sinks with them); a climb is climbed: the worker
 * walks up to the ladder and stops GAP off it, facing it from the side it came from, reaches for the rungs
 * and climbs hand over hand (a diagonal pair at a time), then steps off onto the other floor and walks on.
 * Every walk and climb starts and ends at rest — hands and feet go onto the ladder as the walk slows and
 * the climb starts, and off it as the climb ends and the next walk starts — so the body's speed never
 * jumps. Durations from WALK_SPEED and CLIMB_SPEED (× k / REF_K) and RAMP_MS: a stretch takes its
 * length ÷ the speed plus the time to get up to it, so a long way is walked at the same step as a short one;
 * the whole trip, set-off included, takes at least TRIP_MIN_MS (a short one is slowed by one factor: shorter,
 * slower steps) and has no upper limit. `k`: world px per figure unit.
 */
export function planTrip(m: Move, rt: Route, from: Pt, k = 1): Trip {
  const legs = rt.legs;
  const b = legs.length ? legs[legs.length - 1].b : from;
  const trip: Trip = { t0: m.t, t1: m.t, a: from, b, f: 1, k, phases: [], bridges: [], ladders: [] };
  // nowhere to go (no legs, or ones that add up to under a pixel: the two docks are the same spot): no steps
  if (!legs.length || legs.reduce((n, l) => n + Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), 0) < 1) return trip;
  // runs of legs, walked (level ones and steps) or climbed; a ladder is always walked to and from
  const runs: { climb: boolean; legs: Leg[] }[] = [];
  for (let i = 0; i < legs.length; ) {
    let j = i + 1;
    if (legs[i].kind === "climb") while (j < legs.length && legs[j].kind === "climb") j++;
    const part = legs.slice(i, j);
    const climb = part[0].kind === "climb" && Math.abs(part[part.length - 1].b.y - part[0].a.y) >= STEP_MAX;
    const last = runs[runs.length - 1];
    if (!climb && last && !last.climb) last.legs.push(...part);
    else runs.push({ climb, legs: part });
    i = j;
  }
  if (runs[0].climb) runs.unshift({ climb: false, legs: [] });
  if (runs[runs.length - 1].climb) runs.push({ climb: false, legs: [] });
  const dirOf = (r: { legs: Leg[] } | undefined) => (r?.legs.length ? Math.sign(r.legs[r.legs.length - 1].b.x - r.legs[0].a.x) : 0);
  // a ladder is faced from the side it is come to (else the side it is left for)
  const face = runs.map((r, i) => (r.climb ? dirOf(runs[i - 1]) || dirOf(runs[i + 1]) || 1 : 1) as 1 | -1);
  // where the body goes: along each walk, and GAP off a ladder's line (never further back than it came)
  const G = GAP * k;
  const path: { a: Pt; b: Pt }[] = [];
  let at = from;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const e = r.legs.length ? r.legs[r.legs.length - 1].b : runs[i + 1] ? at : b;
    const lx = runs[i + 1]?.climb ? runs[i + 1].legs[0].a.x : undefined;
    const x = r.climb ? at.x : lx !== undefined ? lx - face[i + 1] * Math.min(G, Math.abs(lx - at.x)) : e.x;
    path.push({ a: at, b: { x, y: e.y } });
    at = path[i].b;
  }
  const steps = (r: { legs: Leg[] }) => r.legs.reduce((n, l) => n + (l.kind === "climb" ? Math.abs(l.b.y - l.a.y) : 0), 0);
  const len = runs.map((r, i) => (r.climb ? Math.abs(path[i].b.y - path[i].a.y) : Math.abs(path[i].b.x - path[i].a.x) + steps(r)));
  // How fast the body goes along each stretch, and how fast at each corner between two (a walk and a climb): the speed is continuous along the trip, so a walk eases
  // down to the ladder and the climb starts from that pace, not from rest; the ends of the trip are at rest. Never changing speed faster than ACCEL (× the figure's scale).
  const sc = (k / REF_K) * (m.boost ?? 1);
  const A = ACCEL * sc;
  const pace = runs.map((r) => (r.climb ? CLIMB_SPEED : WALK_SPEED) * sc);
  const v: number[] = [0]; // v[i]: the speed where stretch i starts (v[n]: where the last ends)
  for (let i = 1; i < runs.length; i++) v.push(len[i - 1] > 0 && len[i] > 0 ? CORNER * Math.min(pace[i - 1], pace[i]) : 0);
  v.push(0);
  for (let i = 0; i < runs.length; i++) v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * A * len[i])); // reachable from where it starts
  for (let i = runs.length - 1; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * A * len[i])); // and stoppable in what is left
  // beside a ladder a walk takes long enough for hands and feet to get on or off, even standing
  const nat = runs.map((r, i) => {
    const T = natural(len[i], v[i], v[i + 1], pace[i], A);
    return r.climb ? T : Math.max(T, runs[i - 1]?.climb || runs[i + 1]?.climb ? 2 * GRAB_MS : 0);
  });
  const off = m.resume ? 0 : SET_OFF_MS; // a trip taking over has no beat to turn and shift weight
  const dur = fit(nat, m.resume ? 0 : TRIP_MIN_MS - SET_OFF_MS);
  const profs = runs.map((_, i) => fitProfile(len[i], dur[i], v[i], v[i + 1], A));
  const D = dur.reduce((n, x) => n + x, 0);
  const st = RIG.stance * k;
  let t = m.t + off;
  let feet: [Foot, Foot] | null = m.resume?.feet ?? null;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const { a, b: e } = path[i];
    const T = dur[i];
    // quicker than natural: longer steps as well as quicker ones (on a ladder, reaching further rungs)
    const quick = T ? Math.sqrt(nat[i] / T) : 1;
    if (!r.climb) {
      if (T > 0) {
        const f = (Math.sign(e.x - a.x) || (runs[i + 1]?.climb ? face[i + 1] : 0) || trip.phases[trip.phases.length - 1]?.f || 1) as 1 | -1;
        const start: [Foot, Foot] = feet ?? [
          { x: a.x + st * f, y: a.y, lift: 0 },
          { x: a.x - st * f, y: a.y, lift: 0 },
        ];
        const ph = walkPhase(r.legs, a, e, f, start, t, t + T, profs[i], STRIDE * k * clamp(quick, 0.7, 1.6), k);
        trip.phases.push(ph);
        feet = lastFeet(ph);
      }
      t += T;
      continue;
    }
    const x = r.legs[0].a.x;
    const rungs = rungsOf(a.y, e.y, k, quick >= 1.25 ? 6 : 4);
    trip.phases.push({ kind: "climb", t0: t, t1: t + T, a, b: e, f: face[i], prof: profs[i], x, rungs, on: 0, off: 0 });
    // off it at the ladder's foot (or top), on the floor there
    feet = [
      { x, y: e.y, lift: 0 },
      { x, y: e.y, lift: 0 },
    ];
    t += T;
    // drawn while walked: rails and rungs, the topmost leg's rails reaching POST above the upper floor
    const upper = rungs.bot - rungs.n * rungs.sp;
    for (const l of r.legs) {
      const lo = Math.min(l.a.y, l.b.y);
      const hi = Math.max(l.a.y, l.b.y);
      const top = lo <= upper + 1e-6 ? rungs.bot - rungs.top * rungs.sp : lo;
      const ys: number[] = [];
      for (let j = 1; j <= rungs.top; j++) {
        const y = rungs.bot - j * rungs.sp;
        if (y < hi - 1e-6 && y >= top - 1e-6) ys.push(y);
      }
      trip.ladders.push({ x, top, bottom: hi, rungs: ys, temp: l.temp });
    }
  }
  const ph = trip.phases;
  ph[ph.length - 1].t1 = trip.t1 = m.t + off + D;
  // hands and feet go onto and off each ladder around the climb's ends, within the walks either side
  ph.forEach((c, i) => {
    if (c.kind !== "climb") return;
    c.on = Math.min(GRAB_MS, 0.45 * (ph[i - 1].t1 - ph[i - 1].t0), 0.45 * (c.t1 - c.t0));
    c.off = Math.min(GRAB_MS, 0.45 * (ph[i + 1].t1 - ph[i + 1].t0), 0.45 * (c.t1 - c.t0));
  });
  trip.f = ph[0].f;
  trip.bridges = legs.filter((l) => l.kind === "bridge").map((l) => ({ a: l.a, b: l.b, temp: l.temp }));
  return trip;
}

/** How high a door's ladder is, in figure units: a figure's height, so that going all the way down (or up) takes all of it past the floor line. */
export const DOOR_H = 50;
/** Hands and feet go onto the ladder over the first DOOR_GRAB ms of going in, and off it over the last of coming out. */
const DOOR_GRAB = 100;
/** The climb's share of its time spent gathering speed, and again slowing (its top speed is CLIMB_SPEED). */
const DOOR_RAMP = 0.2;
/** Hands reach this far ahead of the body's line to a door's rails (the ladder runs through the body: `GAP`, as a ladder beside a node's wall is kept off it). */
const DOOR_AHEAD = 4;
const DOOR_CLIMB_MS = Math.round((DOOR_H * REF_K) / (CLIMB_SPEED * (1 - DOOR_RAMP)));
/** Going through a door — down (or up) its ladder, from the floor to all the way out of sight, or back — takes this long; a smaller figure takes as long over a shorter way. */
export const DOOR_MS = DOOR_GRAB + DOOR_CLIMB_MS;

/**
 * The trip through a door (pure), for a figure drawn at k world px per unit, the floor at (0, 0) and the ladder at x = 0, times
 * 0 … DOOR_MS: `dir` 1 — the ladder goes down from the floor (a node's top edge, on the canvas the door is in); −1 — up from it (on
 * the sub-diagram's canvas, the ladder hangs from one figure's height above the floor); `leaving`: from the floor to the far end
 * (gone from this canvas), else from the far end to the floor. Hands and feet take hold as it goes on the ladder (a standing beat
 * of DOOR_GRAB first) and let go as it steps off. It is faced `f`.
 */
export function planDoor(k: number, dir: 1 | -1, leaving: boolean, f: 1 | -1 = 1): Trip {
  const far: Pt = { x: 0, y: dir * DOOR_H * k };
  const floor: Pt = { x: 0, y: 0 };
  const [a, b] = leaving ? [floor, far] : [far, floor];
  const rungs = { ...rungsOf(a.y, b.y, k, 4), ahead: DOOR_AHEAD };
  const st = RIG.stance * k;
  const home = (foot: 0 | 1): Pt => ({ x: (foot ? -st : st) * f, y: 0 });
  const hold: [Foot, Foot] = [{ ...home(0), lift: 0 }, { ...home(1), lift: 0 }];
  const trip: Trip = { t0: 0, t1: DOOR_MS, a, b, f, k, phases: [], bridges: [], ladders: [] };
  const T = DOOR_CLIMB_MS;
  const stand = (t0: number, t1: number, feet: [Foot, Foot], steps: Swing[] = []): WalkPhase => ({ kind: "walk", t0, t1, a: floor, b: floor, f, prof: restProfile(RAMP), feet, steps, bumps: [] });
  if (leaving) {
    trip.phases.push(stand(0, DOOR_GRAB, hold), { kind: "climb", t0: DOOR_GRAB, t1: DOOR_MS, a, b, f, prof: restProfile(DOOR_RAMP), x: 0, rungs, on: DOOR_GRAB, off: 0 });
  } else {
    // stepping off onto the floor: the feet close up to where they stand
    const onLadder: [Foot, Foot] = [{ x: 0, y: 0, lift: 0 }, { x: 0, y: 0, lift: 0 }];
    const steps: Swing[] = [0, 1].map((n) => ({ foot: n as 0 | 1, t0: T + DOOR_GRAB * 0.3 * n, t1: DOOR_MS - DOOR_GRAB * 0.3 * (1 - n), from: onLadder[n], to: home(n as 0 | 1), up: LIFT * k * 0.3 }));
    trip.phases.push({ kind: "climb", t0: 0, t1: T, a, b, f, prof: restProfile(DOOR_RAMP), x: 0, rungs, on: 0, off: DOOR_GRAB }, stand(T, DOOR_MS, onLadder, steps));
  }
  return trip;
}

/** Where a walk or a climb has everything at t (hands and feet on the ladder while climbing). */
function poseIn(x: Phase, t: number, k: number): TripPose {
  const u = x.t1 > x.t0 ? clamp((t - x.t0) / (x.t1 - x.t0), 0, 1) : 1;
  if (x.kind === "climb") {
    const root = { x: x.a.x, y: mix(x.a.y, x.b.y, prog(u, x.prof)) };
    const h = holds(x.rungs, x.x, x.f, root.y, k);
    return { root, feet: h.feet, hands: h.hands, climb: 1, hip: x.rungs.hip, f: x.f };
  }
  const L = Math.abs(x.b.x - x.a.x);
  const d = L * prog(u, x.prof);
  const root = L ? { x: x.a.x + Math.sign(x.b.x - x.a.x) * d, y: x.a.y + x.bumps.reduce((n, s) => n + s.dy * smooth(clamp((d - s.lo) / (s.hi - s.lo), 0, 1)), 0) } : { x: x.a.x, y: mix(x.a.y, x.b.y, prog(u, x.prof)) };
  const feet: [Foot, Foot] = [x.feet[0], x.feet[1]];
  for (const s of x.steps) {
    if (t >= s.t1) feet[s.foot] = { ...s.to, lift: 0 };
    else if (t > s.t0) {
      const w = (t - s.t0) / (s.t1 - s.t0);
      const v = smooth(w);
      const lift = Math.sin(Math.PI * w);
      feet[s.foot] = { x: mix(s.from.x, s.to.x, v), y: mix(s.from.y, s.to.y, v) - lift * s.up, lift: Math.max(1e-3, lift) };
    }
  }
  return { root, feet, hands: null, climb: 0, hip: RIG.hip, f: x.f };
}

/** Phase i at t, with hands and feet going onto a ladder around a climb's start and off it around its end. */
function poseAt(p: Trip, i: number, t: number): TripPose {
  const x = p.phases[i];
  const base = poseIn(x, t, p.k);
  const blend = (a: Foot[], b: Foot[], w: number): [Foot, Foot] => [0, 1].map((n) => ({ x: mix(a[n].x, b[n].x, w), y: mix(a[n].y, b[n].y, w), lift: Math.max(a[n].lift, b[n].lift) })) as [Foot, Foot];
  // how far onto the ladder: 0 → 1 over `on` either side of the climb's start, 1 → 0 around its end
  const onto = (c: ClimbPhase, t: number) => (c.on && t < c.t0 + c.on ? smooth((t - c.t0 + c.on) / (2 * c.on)) : c.off && t > c.t1 - c.off ? smooth((c.t1 + c.off - t) / (2 * c.off)) : 1);
  if (x.kind === "climb") {
    const w = onto(x, t);
    if (w >= 1) return base;
    const ground = t < (x.t0 + x.t1) / 2 ? lastFeet(p.phases[i - 1] as WalkPhase) : (p.phases[i + 1] as WalkPhase).feet;
    return { ...base, feet: blend(ground, base.feet, w), climb: w, hip: mix(RIG.hip, x.rungs.hip, w) };
  }
  const next = p.phases[i + 1];
  const prev = p.phases[i - 1];
  const c = next?.kind === "climb" && t > next.t0 - next.on ? next : prev?.kind === "climb" && t < prev.t1 + prev.off ? prev : null;
  if (!c) return base;
  const w = onto(c, t);
  const h = holds(c.rungs, c.x, c.f, c === next ? c.a.y : c.b.y, p.k);
  // stepping off, it faces the ladder until its hands are off, then turns to walk on
  return { ...base, feet: blend(base.feet, h.feet, w), hands: h.hands, climb: w, hip: mix(RIG.hip, c.rungs.hip, w), f: c === prev ? c.f : base.f };
}

/** A corner between a walk and a climb, where the body turns from level to upright (at CORNER of the pace), is rounded over this much time either side: the path there is the
 * raw one plus a smooth correction that vanishes at both ends, so the velocity turns steadily (a fixed sideways acceleration of about 0.0005 px/ms²) instead of in one frame.
 * The body ends up a couple of px inside the corner at most; elsewhere the path is untouched, a start and a stop are where they are. */
export const ROUND_MS = 140;
/** Where the body is on its raw path (no rounding of the corners): the way the trace line follows. */
export function rawRoot(p: Trip, t: number): Pt {
  const ph = p.phases;
  const i = ph.findIndex((x) => t < x.t1);
  return i < 0 ? p.b : poseIn(ph[i], t, p.k).root;
}
/** The corners of a trip: the times where one phase that goes somewhere hands over to the next. */
function corners(p: Trip): number[] {
  const out: number[] = [];
  p.phases.forEach((x, i) => {
    const y = p.phases[i + 1];
    if (y && Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y) > 0 && Math.hypot(y.b.x - y.a.x, y.b.y - y.a.y) > 0) out.push(x.t1);
  });
  return out;
}
/** The root at t: the raw path with the corners rounded (see ROUND_MS). */
function roundedRoot(p: Trip, t: number): Pt {
  const raw = rawRoot(p, t);
  let x = raw.x;
  let y = raw.y;
  for (const c of corners(p)) {
    const tau = t - c;
    if (Math.abs(tau) >= ROUND_MS) continue;
    // the velocity going in and going out (px/ms), and how far the smoothed corner is from the sharp one at tau
    const e = 1;
    const a0 = rawRoot(p, c - e);
    const a1 = rawRoot(p, c);
    const b1 = rawRoot(p, c + e);
    const u = { x: a1.x - a0.x, y: a1.y - a0.y };
    const w = { x: b1.x - a1.x, y: b1.y - a1.y };
    const smoothed = ((tau + ROUND_MS) * (tau + ROUND_MS)) / (4 * ROUND_MS);
    const k = smoothed - Math.max(tau, 0);
    x += (w.x - u.x) * k;
    y += (w.y - u.y) * k;
  }
  return { x, y };
}

/** Where a worker on a trip is at t (pure): standing at the start before it sets off (turning to face
 * the way), then phase by phase, standing at the end once it is there. */
export function tripAt(p: Trip, t: number): TripPose {
  const ph = p.phases;
  if (!ph.length) return { root: p.a, feet: [{ ...p.a, lift: 0 }, { ...p.a, lift: 0 }], hands: null, climb: 0, hip: RIG.hip, f: p.f };
  if (t <= ph[0].t0) return { ...poseAt(p, 0, ph[0].t0), root: p.a, f: p.f };
  const i = ph.findIndex((x) => t < x.t1);
  if (i < 0) return { ...poseAt(p, ph.length - 1, p.t1), root: p.b };
  return { ...poseAt(p, i, t), root: roundedRoot(p, t) };
}

/** A raised hand (Loom's arm units, from the shoulder, along the facing): beside the head, clear of its circle — 5.6 put the hand's centre 3.6 inside it. */
export const RAISED: readonly [number, number] = [8.4, -16.3];
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
    T = { near: [1 - 0.5 * feet[0].x * f, hang], far: [0.2 - 0.5 * feet[1].x * f, hang], lean: mix(3, 5, climb), tilt: 0, sway: 0, prop: o.readingWhileWalking && climb < 0.5 ? "carry" : null, mark: null, facing: 1 };
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
    return [rad * Math.cos(ang), rad * Math.sin(ang)];
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
  const reach = (h: number[], at: Pt | undefined): [number, number] => {
    const x = shx + L(h[0]);
    const y = shy + h[1];
    if (!at) return [x, y];
    // onto the rung along an arc about the shoulder too (same reason as `swing`); the angles are from the facing (0 = straight ahead), so
    // from hanging (+90°) to a rung overhead (−90°) it goes through ahead, never round behind the body
    const a0 = Math.atan2(y - shy, (x - shx) * f);
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
  };
}
