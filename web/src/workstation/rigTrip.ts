// A worker's trips (./rig.ts): walks, climbs, glides and hops planned ahead so feet plant, and the pose
// at any time t along one (planTrip / tripAt). Pure functions of t, so scrubbing and playing agree.

import { REF_K } from "./docks";
import { arcAt, hopAir, HOP_CROUCH_MS, HOP_G, HOP_LAND_MS, type Arc, type Leg, type Route } from "./route";
import { clamp, mix, type Pt, RIG, smooth, wrapAngle } from "./rigCore";

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
export const CLIMB_SPEED = 0.0625;
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
/** Along an arrow (§5 沿箭头滑行) a worker goes as a capsule, like the data the arrow carries: the glide takes GLIDE_BASE_MS plus GLIDE_PER_PX
 * a world px, within GLIDE_MIN_MS … GLIDE_MAX_MS — so a long arrow does not take ages (a 300 px one 0.77 s, anything over 890 px 1.6 s) — easing in
 * and out at up to GLIDE_ACCEL (px/ms², 3000 px/s²: it is not a body that walks) and steady in the middle. */
export const GLIDE_BASE_MS = 350;
export const GLIDE_PER_PX = 1.4;
export const GLIDE_MIN_MS = 500;
export const GLIDE_MAX_MS = 1600;
export const GLIDE_ACCEL = 0.003;
/** The figure turns into the capsule over this long at the start of a glide (shrinking to its feet as it sets off), and back at the end. */
export const MORPH_MS = 180;
/** How long a glide of L world px takes, before its ends are fitted to the walks either side. */
export const glideMs = (L: number) => clamp(GLIDE_BASE_MS + GLIDE_PER_PX * L, GLIDE_MIN_MS, GLIDE_MAX_MS);

// The gait, in figure units (× the trip's k for world px).
const STRIDE = 15; // between footfalls at the natural pace (Loom's 15.3)
const LIFT = 3.4; // how high a swinging foot comes up (and how far a hand or foot comes off a ladder)
/** The rungs are at most this far apart (figure units): a ladder's height is split evenly into as many as it takes (`rungCount`; hatch.ts draws a door's ladder with the same). Far enough apart that a limb's move is a whole reach, not a flick: a limb
 * reaches 4 rungs a move (the leg's reach, with the bent knee), so a pair of them changes over every 2 rungs of climbing, 16 units of body. */
export const RUNG = 8.5;
/** How many rungs a ladder of height `h` (figure units) has: the fewest that keep them within RUNG of each other. */
export const rungCount = (h: number) => Math.max(1, Math.ceil(h / RUNG - 1e-9));
/** Hands and feet change over (a diagonal pair lets go and reaches on) this many times a second at the top of a climb, at most: the top pace of a ladder is what its rungs allow at that rate (`climbPace`). 3.125 is one change every 320 ms. */
export const CLIMB_SWAPS = 3.125;
const GAP = 4; // the body keeps this far off a ladder it climbs; hands and feet reach forward to it
const GRAB_MS = 150; // hands and feet go onto a ladder over this much either side of where the climb starts (and off it where it ends)
const RAMP = 0.3; // a walk or a climb gathers speed over this share of its time, and slows over as much
/** World px/ms² at the reference scale (× the figure's scale): no walk or climb gathers speed (or slows) harder — 1200 px/s², under 0.02 px/ms of change a frame at 60 fps. */
export const ACCEL = 0.0008;
/** Between a walk and a climb (a corner: the body turns from level to upright) it goes at this share of the slower one's pace: it eases into the corner and out, never stops. */
const CORNER = 0.6;
/** How far the shoulders sit below the top of the torso. */
export const SHOULDER = 2.2;

/** A foot (or a hand on a ladder), world coordinates. `lift`: 0 planted or holding … 1 fully off, mid-move. */
export type Foot = Pt & { lift: number };
type Swing = { foot: 0 | 1; t0: number; t1: number; from: Pt; to: Pt; up: number };
/** One ladder's holds: rung j at y = bot − j·sp (0 the lower floor, n the upper one, top the rails' ends).
 * A limb holds every R-th rung, a diagonal pair moving while the other holds; hands hold m rungs over
 * the feet; `hip`: the hips' height above the feet on it (figure units, knees bent). */
type Rungs = { bot: number; sp: number; n: number; top: number; R: number; m: number; hip: number; /** The hands hold this far ahead of the feet's line (figure units): a door's ladder runs through the body, so without it a hand on a rung passes the shoulder within a unit and the elbow whips round (web/docs/workstation.md §16). */ ahead: number; /** Going down a ladder beside a node's wall: the body comes in to it (DOWN_LEAN…). */ snug: boolean };
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
/** A glide along `pts` (the arrow's line, the node outlines at its ends; `cum`: the length up to each point, `L` the whole): a capsule over the middle,
 * the figure at the ends, morphing over `morph` ms; facing `f` over the first half and `fOut` over the second (the way the walk after it goes). */
type GlidePhase = Span & { kind: "glide"; pts: Pt[]; cum: number[]; ts: number[]; vs: number[]; L: number; morph: number; fOut: 1 | -1 };
/** A hop (§5 跳过去) from `a` to `b` along `arc`: crouching over `crouch` ms where it stands (the last of it a push up out of the crouch), in the air for `air` ms, the squash of
 * the landing over `land` ms; the feet from where the walk before left them (`pre`) to where the walk after takes them up (`post`); `pts` / `cum`: the arc in HOP_STEPS
 * pieces and the length up to each point (the share of it covered, for the trace). */
type HopPhase = Span & { kind: "hop"; arc: Arc; crouch: number; air: number; land: number; pre: [Foot, Foot]; post: [Foot, Foot]; pts: Pt[]; cum: number[] };
type Phase = WalkPhase | ClimbPhase | GlidePhase | HopPhase;
/** What a trip draws while it is walked: bridges (level, across a gap) and ladders (rails from `bottom`
 * up to `top`, rungs at `rungs`); `temp`: a scaffold's, not a connector's. */
export type Bridge = { a: Pt; b: Pt; temp: boolean };
export type Ladder = { x: number; top: number; bottom: number; rungs: number[]; temp: boolean };
/** A move planned along its route: t0 → t1 (the turn at set-off included), a → b, for a figure drawn at k world px per figure unit. */
/** A glide's line while it is glided (the arrow lit under the capsule), and when. */
export type GlideLine = { pts: Pt[]; t0: number; t1: number };
/** A hop's arc (§5 跳过去) and when it is in the air: from takeoff (`t0`) to touchdown (`t1`). */
export type HopLine = { pts: Pt[]; t0: number; t1: number };
export type Trip = { t0: number; t1: number; a: Pt; b: Pt; f: 1 | -1; k: number; phases: Phase[]; bridges: Bridge[]; ladders: Ladder[]; glides: GlideLine[]; hops: HopLine[] };
/** A worker on a trip at t: root and feet (world), its hands' holds while on a ladder, how far into the
 * climbing stance it is (0 walking … 1 on the ladder), its hip height (figure units) and facing. */
export type TripPose = { root: Pt; feet: [Foot, Foot]; hands: [Foot, Foot] | null; climb: number; hip: number; f: 1 | -1; /** On a ladder the body comes in to (going down one beside a node's wall: `Rungs.snug`). */ snug?: boolean;
  /** Gliding along an arrow: 0 the figure … 1 the capsule, and the capsule's heading (radians, world: 0 = +x, y down) along the line. */ capsule?: number; heading?: number;
  /** Hopping (§5 跳过去): where the hands go (figure units from the shoulder, x along the facing, as `RAISED`) and the lean (°) — swung back in the crouch, up in the air, out for the landing —
   * and how far off the floor it is (0 on it … 1 in the air, over the first and last AIR_FADE ms of the flight: its shadow goes). */ arms?: { near: [number, number]; far: [number, number]; lean: number }; air?: number };

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
  const j = mix(src, dst, fr < 0.5 ? smooth(fr / 0.5) : 1); // a move that would start below the ladder's foot (or end above its top) is a shorter one over the same time, not one that starts late (or stops early)
  // between two rungs it is off the ladder (lift > 0 however close to one it is); on a rung, 0
  const up = j > src && j < dst ? Math.sin((Math.PI * (j - src)) / (dst - src)) : 0;
  return { j, up, lift: up ? Math.max(1e-3, up) : 0 };
}

/** Hands and feet on the ladder at x with the body at height y: the near hand moves with the far foot,
 * the far hand with the near foot, the pairs taking turns; a limb between rungs comes off toward the body. */
export function holds(r: Rungs, x: number, f: 1 | -1, y: number, k: number): { feet: [Foot, Foot]; hands: [Foot, Foot] } {
  const z = (r.bot - y) / r.sp;
  // a foot off its rung comes toward the body, a hand away from it: a hand that came in would pass within a few units of the shoulder, and the elbow whips round it
  const at = (h: { j: number; up: number; lift: number }, ahead = 0, off = -1): Foot => ({ x: x + f * (ahead + off * h.up * LIFT) * k, y: r.bot - h.j * r.sp, lift: h.lift });
  const half = r.R / 2;
  // one pair is always on the move (each moves for half the time), so a climb that starts at the foot (or the top) has one pair at the start of its move, not half way through it: its
  // first change is a full one later, not a few ms after it starts (four rungs a move; with two rungs a move the rungs allow no such phase)
  const p = r.R % 4 === 0 ? r.R / 4 : 0;
  return {
    feet: [at(holdAt(z, p, r.R, 0, r.n)), at(holdAt(z, p + half, r.R, 0, r.n))],
    hands: [at(holdAt(z + r.m, (p + half + r.m) % r.R, r.R, 1, r.top), r.ahead, 1), at(holdAt(z + r.m, (p + r.m) % r.R, r.R, 1, r.top), r.ahead, 1)],
  };
}

/** Going down, the hips may stay this share of the standing height (higher than going up, 0.8: the legs long, not folded like a seat) if the reach allows it (`rungsOf`). */
const DOWN_HIP = 0.9;
/** …its body comes in to the ladder: it leans this much more to it (°), its hips end up this far behind the feet's line and shift at most this far (figure units) to get there, and its hands hold this far ahead of the rails, clear of the shoulders that came forward. */
export const DOWN_LEAN = 6;
export const DOWN_BEHIND = 0.8;
export const DOWN_SWAY_MAX = 3;
const DOWN_AHEAD = 2.5;
/** A hand on a ladder is at least this far (figure units) over the shoulder, at the low end of its reach — and the rails reach as far above the upper floor as the shoulder plus that (about 33: the door's ladder on the parent canvas, HATCH_POST 34): a handhold getting on and off, never one that brings the hand down through the shoulder, where the elbow would whip round. */
const HAND_MIN = 3;
/** The rungs of a ladder from y0 to y1 for a figure at k world px per unit: the height split evenly into rungs at most RUNG apart, a limb reaching 4 of them a move (the body goes 2 between one diagonal pair's move and the other's). Going down
 * (y1 below y0), the hips are up to `downHip` of the standing height (0.8 going up) if the reach allows it, the hands ahead of the rails. */
function rungsOf(y0: number, y1: number, k: number, downHip = DOWN_HIP): Rungs {
  const down = y1 > y0;
  const bot = Math.max(y0, y1);
  const H = bot - Math.min(y0, y1);
  const n = rungCount(H / k);
  const sp = H / n;
  const R = 4;
  // hips low enough that a foot at the bottom of its reach (R/4 rungs under the body) still gets there
  const hip = Math.min((down ? downHip : 0.8) * RIG.hip, 0.97 * (RIG.thigh + RIG.shin) - (R / 4) * (sp / k));
  // the hands hold m rungs over the feet: the fewest that keep a hand (which ranges R/4 rungs either side of that) off the shoulder, where the elbow would whip round
  const shoulder = hip + RIG.torso - SHOULDER;
  const m = Math.max(1, Math.ceil((shoulder + HAND_MIN + (R / 4) * (sp / k)) / (sp / k) - 1e-9));
  return { bot, sp, n, top: n + Math.max(1, Math.ceil((shoulder + HAND_MIN) / (sp / k) - 1e-9)), R, m, hip, ahead: down ? DOWN_AHEAD : 0, snug: down };
}
/** How fast the body climbs a ladder of height `h` (world px) at most, for a figure at k world px per unit (× its scale): CLIMB_SPEED, or slower if the rungs are nearer than that pace allows for CLIMB_SWAPS changes a second. */
export function climbPace(h: number, k: number): number {
  const sp = h / rungCount(h / k);
  return Math.min(CLIMB_SPEED * (k / REF_K), (CLIMB_SWAPS * 2 * sp) / 1000);
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

/** All the stretches' durations stretched by one factor when the whole is under `B` ms (a short trip is slowed, never a long one hurried). A glide (`fixed`) keeps its time. */
function fit(nat: readonly number[], B: number, fixed: readonly boolean[] = []): number[] {
  const all = nat.reduce((a, x) => a + x, 0);
  const free = nat.reduce((a, x, i) => a + (fixed[i] ? 0 : x), 0);
  return all >= B || !free ? [...nat] : nat.map((x, i) => (fixed[i] ? x : (x * (B - all + free)) / free));
}

/** The point `s` px along a polyline (`cum`: the length up to each point), clamped to its ends. */
export function along(pts: readonly Pt[], cum: readonly number[], s: number): Pt {
  if (s <= 0) return pts[0];
  const L = cum[cum.length - 1];
  if (s >= L) return pts[pts.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const u = (s - cum[lo]) / (cum[hi] - cum[lo] || 1);
  return { x: mix(pts[lo].x, pts[hi].x, u), y: mix(pts[lo].y, pts[hi].y, u) };
}

/** Through a bend a capsule turns at most this hard sideways (px/ms², v²/r): it slows for a tight one (an arrow's rounded elbow) and keeps its speed on a straight. */
export const GLIDE_TURN = 0.0035;
/**
 * A glide's timetable along `pts`: the speed at each point (`vs`, px/ms) and when it gets there (`ts`, ms), from `vin` to `vout`, never faster through a
 * bend than GLIDE_TURN allows, never changing speed faster than GLIDE_ACCEL (between two points the speed changes evenly), and on the straights as fast
 * as it takes to be done in `want` ms (if the bends allow it). Pure.
 */
function glideLine(pts: Pt[], vin: number, vout: number, want: number): { pts: Pt[]; cum: number[]; ts: number[]; vs: number[] } {
  const n = pts.length;
  const cum = [0];
  for (let j = 1; j < n; j++) cum.push(cum[j - 1] + Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y));
  const cap = pts.map((p, j) => {
    if (j === 0 || j === n - 1) return Infinity;
    const a = Math.atan2(p.y - pts[j - 1].y, p.x - pts[j - 1].x);
    const b = Math.atan2(pts[j + 1].y - p.y, pts[j + 1].x - p.x);
    const th = Math.abs(wrapAngle(b - a));
    return th < 1e-4 ? Infinity : Math.sqrt((GLIDE_TURN * (cum[j + 1] - cum[j - 1])) / 2 / th);
  });
  const plan = (vc: number) => {
    const vs = cap.map((c) => Math.min(c, vc));
    vs[0] = vin;
    vs[n - 1] = vout;
    for (let j = 1; j < n; j++) vs[j] = Math.min(vs[j], Math.sqrt(vs[j - 1] ** 2 + 2 * GLIDE_ACCEL * (cum[j] - cum[j - 1])));
    for (let j = n - 2; j >= 1; j--) vs[j] = Math.min(vs[j], Math.sqrt(vs[j + 1] ** 2 + 2 * GLIDE_ACCEL * (cum[j + 1] - cum[j])));
    const ts = [0];
    for (let j = 1; j < n; j++) ts.push(ts[j - 1] + (2 * (cum[j] - cum[j - 1])) / Math.max(1e-6, vs[j - 1] + vs[j]));
    return { vs, ts };
  };
  let lo = 0.02;
  let hi = 3;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (plan(mid).ts[n - 1] > want) lo = mid;
    else hi = mid;
  }
  return { pts, cum, ...plan(hi) };
}
/** How far along its line a glide is `tau` ms after it set off. */
function glideS(x: { cum: number[]; ts: number[]; vs: number[]; L: number }, tau: number): number {
  const { ts, vs, cum } = x;
  if (tau <= 0) return 0;
  if (tau >= ts[ts.length - 1]) return x.L;
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= tau) lo = mid;
    else hi = mid;
  }
  const h = ts[hi] - ts[lo];
  const d = tau - ts[lo];
  return Math.min(cum[hi], cum[lo] + vs[lo] * d + (h > 0 ? ((vs[hi] - vs[lo]) / h) * d * d : 0) / 2);
}

/**
 * A move's trip along its route (pure). Runs of level legs are walked (a step under STEP_MAX included:
 * the feet come down on the new floor, the body rises or sinks with them); a run of glide legs (an arrow:
 * ./route.ts) is glided — the worker walks to where the glide starts, turns into a capsule as it sets off along
 * the line, and back into itself as it arrives, then walks on; a hop's legs (§5 跳过去, one arc) are hopped — the
 * worker walks to the takeoff and stops, crouches (HOP_CROUCH_MS, swinging its arms back, then pushing up out of
 * it), flies the arc under HOP_G (arms up, feet tucked, then reaching down for the floor) and lands into a squash
 * (HOP_LAND_MS), then walks on; a climb (a ladder: only a way planned with no walk map has one) is climbed: the worker
 * walks up to the ladder and stops GAP off it, facing it from the side it came from, reaches for the rungs
 * and climbs hand over hand (a diagonal pair at a time), then steps off onto the other floor and walks on.
 * The speed is continuous along the whole trip — a walk eases into a climb or a glide at CORNER of the slower
 * pace, never stopping — and only its ends (and a glide's or a hop's) are at rest. Durations from WALK_SPEED and CLIMB_SPEED (× k / REF_K)
 * and ACCEL: a stretch takes its length ÷ the speed plus the time to get up to it, so a long way is walked at
 * the same step as a short one; a glide takes `glideMs` (GLIDE_ACCEL to change speed), a hop its crouch, its time in the air and its squash. The whole trip, set-off
 * included, takes at least TRIP_MIN_MS (a short one's walks are slowed by one factor: shorter, slower steps) and
 * has no upper limit. `k`: world px per figure unit.
 */
export function planTrip(m: Move, rt: Route, from: Pt, k = 1): Trip {
  const legs = rt.legs;
  const b = legs.length ? legs[legs.length - 1].b : from;
  const trip: Trip = { t0: m.t, t1: m.t, a: from, b, f: 1, k, phases: [], bridges: [], ladders: [], glides: [], hops: [] };
  // nowhere to go (no legs, or ones that add up to under a pixel: the two docks are the same spot): no steps
  if (!legs.length || legs.reduce((n, l) => n + Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), 0) < 1) return trip;
  // runs of legs, walked (level ones and steps), climbed, glided or hopped (one run to a hop: its pieces share its arc); a ladder, a glide or a hop is always walked to and from (a run that may take no time)
  type Run = { mode: "walk" | "climb" | "glide" | "hop"; legs: Leg[] };
  const runs: Run[] = [];
  const walkRun = (): Run => ({ mode: "walk", legs: [] });
  for (let i = 0; i < legs.length; ) {
    let j = i + 1;
    const kind = legs[i].kind;
    if (kind === "climb" || kind === "glide") while (j < legs.length && legs[j].kind === kind) j++;
    if (kind === "hop") while (j < legs.length && legs[j].kind === "hop" && legs[j].arc === legs[i].arc) j++;
    const part = legs.slice(i, j);
    const mode: Run["mode"] = kind === "glide" || kind === "hop" ? kind : kind === "climb" && Math.abs(part[part.length - 1].b.y - part[0].a.y) >= STEP_MAX ? "climb" : "walk";
    const last = runs[runs.length - 1];
    if (mode === "walk" && last?.mode === "walk") last.legs.push(...part);
    else {
      if (mode !== "walk" && (!last || last.mode !== "walk")) runs.push(walkRun());
      runs.push({ mode, legs: part });
    }
    i = j;
  }
  if (runs[runs.length - 1].mode !== "walk") runs.push(walkRun());
  const dirOf = (r: Run | undefined) => (r?.legs.length ? Math.sign(r.legs[r.legs.length - 1].b.x - r.legs[0].a.x) : 0);
  // a ladder is faced from the side it is come to (else the side it is left for); a glide sets off facing the way it was walking
  const face = runs.map((r, i) => (r.mode !== "walk" ? dirOf(runs[i - 1]) || dirOf(runs[i + 1]) || 1 : 1) as 1 | -1);
  // where the body goes: along each walk, GAP off a ladder's line (never further back than it came), along a glide's line
  const G = GAP * k;
  const path: { a: Pt; b: Pt }[] = [];
  let at = from;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const e = r.legs.length ? r.legs[r.legs.length - 1].b : runs[i + 1] ? (runs[i + 1].legs[0]?.a ?? at) : b;
    const lx = runs[i + 1]?.mode === "climb" ? runs[i + 1].legs[0].a.x : undefined;
    const x = r.mode === "climb" ? at.x : lx !== undefined ? lx - face[i + 1] * Math.min(G, Math.abs(lx - at.x)) : e.x;
    path.push({ a: at, b: { x, y: e.y } });
    at = path[i].b;
  }
  const lineOf = (r: Run) => [r.legs[0].a, ...r.legs.map((l) => l.b)];
  const steps = (r: Run) => r.legs.reduce((n, l) => n + (l.kind === "climb" ? Math.abs(l.b.y - l.a.y) : 0), 0);
  const len = runs.map((r, i) => (r.mode === "climb" ? Math.abs(path[i].b.y - path[i].a.y) : r.mode === "glide" || r.mode === "hop" ? r.legs.reduce((n, l) => n + Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), 0) : Math.abs(path[i].b.x - path[i].a.x) + steps(r)));
  // How fast the body goes along each stretch, and how fast at each corner between two (a walk and a climb or a glide): the speed is continuous along the trip, so a walk eases
  // down to the ladder (or the arrow) and the next stretch starts from that pace, not from rest; the ends of the trip are at rest. Never changing speed faster than ACCEL
  // (× the figure's scale) walking or climbing, GLIDE_ACCEL gliding.
  const sc = (k / REF_K) * (m.boost ?? 1);
  const A = ACCEL * sc;
  const acc = runs.map((r) => (r.mode === "glide" ? GLIDE_ACCEL : A));
  const want = runs.map((r, i) => (r.mode === "glide" ? glideMs(len[i]) / (m.boost ?? 1) : 0));
  const pace = runs.map((r, i) => (r.mode === "climb" ? climbPace(len[i], k) * (m.boost ?? 1) : r.mode === "glide" ? len[i] / want[i] : WALK_SPEED * sc));
  const v: number[] = [0]; // v[i]: the speed where stretch i starts (v[n]: where the last ends)
  // (a glide starts and ends at rest: the figure stops at the edge, folds into its capsule as it sets off and unfolds as it comes to rest — no corner to cut at speed, where the body would sink into the node;
  // a hop too: it stops at the takeoff to crouch, and lands into a squash)
  const still = (r: Run) => r.mode === "glide" || r.mode === "hop";
  for (let i = 1; i < runs.length; i++) v.push(len[i - 1] > 0 && len[i] > 0 && !still(runs[i - 1]) && !still(runs[i]) ? CORNER * Math.min(pace[i - 1], pace[i]) : 0);
  v.push(0);
  for (let i = 0; i < runs.length; i++) v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * acc[i] * len[i])); // reachable from where it starts
  for (let i = runs.length - 1; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * acc[i] * len[i])); // and stoppable in what is left
  // beside a ladder a walk takes long enough for hands and feet to get on or off, even standing
  // a glide's timetable: as quick as its time asks, slower through the arrow's bends
  const lines = runs.map((r, i) => (r.mode === "glide" ? glideLine(lineOf(r), v[i], v[i + 1], want[i]) : null));
  const nat = runs.map((r, i) => {
    if (r.mode === "glide") return lines[i]!.ts[lines[i]!.ts.length - 1];
    if (r.mode === "hop") return HOP_CROUCH_MS + hopAir(r.legs[0].arc!) + HOP_LAND_MS;
    const T = natural(len[i], v[i], v[i + 1], pace[i], A);
    return r.mode === "climb" ? T : Math.max(T, runs[i - 1]?.mode === "climb" || runs[i + 1]?.mode === "climb" ? 2 * GRAB_MS : 0);
  });
  const off = m.resume ? 0 : SET_OFF_MS; // a trip taking over has no beat to turn and shift weight
  const dur = fit(nat, m.resume ? 0 : TRIP_MIN_MS - SET_OFF_MS, runs.map(still));
  const profs = runs.map((_, i) => fitProfile(len[i], dur[i], v[i], v[i + 1], acc[i]));
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
    if (r.mode === "walk") {
      if (T > 0) {
        const f = (Math.sign(e.x - a.x) || (runs[i + 1]?.mode === "climb" ? face[i + 1] : 0) || trip.phases[trip.phases.length - 1]?.f || 1) as 1 | -1;
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
    if (r.mode === "glide") {
      const { pts, cum, ts, vs } = lines[i]!;
      const f = (trip.phases[trip.phases.length - 1]?.f ?? (Math.sign(e.x - a.x) || 1)) as 1 | -1;
      const after = runs[i + 1];
      const end = after?.legs.length ? after.legs[after.legs.length - 1].b.x : b.x;
      const fOut = (Math.sign(end - e.x) || f) as 1 | -1;
      trip.phases.push({ kind: "glide", t0: t, t1: t + T, a, b: e, f, prof: profs[i], pts, cum, ts, vs, L: cum[cum.length - 1], morph: Math.min(MORPH_MS, T / 2.5), fOut });
      trip.glides.push({ pts, t0: t, t1: t + T });
      feet = [
        { x: e.x + st * fOut, y: e.y, lift: 0 },
        { x: e.x - st * fOut, y: e.y, lift: 0 },
      ];
      t += T;
      continue;
    }
    if (r.mode === "hop") {
      const arc = r.legs[0].arc!;
      // it faces the way it jumps (straight up or down: the way it was going)
      const f = (Math.sign(arc.b.x - arc.a.x) || trip.phases[trip.phases.length - 1]?.f || 1) as 1 | -1;
      const pre: [Foot, Foot] = feet ?? [
        { x: a.x + st * f, y: a.y, lift: 0 },
        { x: a.x - st * f, y: a.y, lift: 0 },
      ];
      // it lands with its feet set for the walk after it (the way that goes), as it comes out of a glide
      const after = runs[i + 1];
      const fOut = (Math.sign((after?.legs.length ? after.legs[after.legs.length - 1].b.x : b.x) - e.x) || f) as 1 | -1;
      const post: [Foot, Foot] = [
        { x: e.x + st * fOut, y: e.y, lift: 0 },
        { x: e.x - st * fOut, y: e.y, lift: 0 },
      ];
      const pts = [r.legs[0].a, ...r.legs.map((l) => l.b)];
      const cum = [0];
      for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1] + Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y));
      const air = hopAir(arc);
      trip.phases.push({ kind: "hop", t0: t, t1: t + T, a, b: e, f, prof: profs[i], arc, crouch: HOP_CROUCH_MS, air, land: T - HOP_CROUCH_MS - air, pre, post, pts, cum });
      trip.hops.push({ pts, t0: t + HOP_CROUCH_MS, t1: t + HOP_CROUCH_MS + air });
      feet = post;
      t += T;
      continue;
    }
    const x = r.legs[0].a.x;
    const rungs = rungsOf(a.y, e.y, k);
    trip.phases.push({ kind: "climb", t0: t, t1: t + T, a, b: e, f: face[i], prof: profs[i], x, rungs, on: 0, off: 0 });
    // off it at the ladder's foot (or top), on the floor there
    feet = [
      { x, y: e.y, lift: 0 },
      { x, y: e.y, lift: 0 },
    ];
    t += T;
    // drawn while walked: rails and rungs, the topmost leg's rails reaching `rungs.top` rungs above the upper floor
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
  // (only a scaffold's are drawn: a level walk off the floors — out from under a node, along under its bottom line — has nothing under it to draw; no route builds a scaffold since 跳过去)
  trip.bridges = legs.filter((l) => l.kind === "bridge" && l.temp).map((l) => ({ a: l.a, b: l.b, temp: l.temp }));
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
/** Down a door's ladder the hips stay this share of the standing height: higher and the head would still show over the floor line when the door closes behind it (DOOR_H is one figure's height). */
const DOOR_DOWN_HIP = 0.835;
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
  const rungs = { ...rungsOf(a.y, b.y, k, DOOR_DOWN_HIP), ahead: DOOR_AHEAD, snug: false };
  const st = RIG.stance * k;
  const home = (foot: 0 | 1): Pt => ({ x: (foot ? -st : st) * f, y: 0 });
  const hold: [Foot, Foot] = [{ ...home(0), lift: 0 }, { ...home(1), lift: 0 }];
  const trip: Trip = { t0: 0, t1: DOOR_MS, a, b, f, k, phases: [], bridges: [], ladders: [], glides: [], hops: [] };
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

/** The rungs each climb of a trip holds: rung j is at world y = bot − j·sp (0 the lower floor). What the hands and feet are put on, for the pose check (./poseHealth.ts) to hold against the drawn rungs. */
export function rungGrid(p: Trip): { bot: number; sp: number; n: number }[] {
  return p.phases.flatMap((x) => (x.kind === "climb" ? [{ bot: x.rungs.bot, sp: x.rungs.sp, n: x.rungs.n }] : []));
}

/** A hop's crouch takes the hips down to this height (figure units: the knees bent to about 85°), its push up out of it to this (the legs all but straight, as the feet leave). */
const HOP_LOW = 18;
const HOP_EXT = 25.9;
/** In the air the feet come up this far under the body (figure units), and are down again for the landing over the last HOP_REACH of the arc. */
const HOP_TUCK = 9;
const HOP_REACH = 0.18;
/** The push out of the crouch (and the catch of the landing) lasts as long as it takes the hips to go from HOP_LOW to HOP_EXT at the speed the arc leaves (or meets) the floor
 * — so the body does not change speed as the feet leave or touch down — within these (ms). */
const PUSH_MIN = 24;
const PUSH_MAX = 70;
/** Where the hands go hopping (figure units from the shoulder, x along the facing; [near, far]): swung back in the crouch, up and forward as it goes up, out ahead for the landing, low in the squash. */
const ARMS_BACK: [number, number][] = [[-5, 14], [-4.2, 14.6]];
const ARMS_UP: [number, number][] = [[7, -12], [5.8, -12.6]];
const ARMS_OUT: [number, number][] = [[10, 3], [9, 4]];
const ARMS_CATCH: [number, number][] = [[9, 8], [8, 9]];
/** A hop's shadow goes as its feet leave the floor and comes back as they meet it, over this long (ms). */
const AIR_FADE = 60;
/** How long the push out of a hop's crouch (or the catch of its landing) takes, for a figure at k world px per unit leaving (or meeting) the floor at vy px/ms. */
const pushMs = (vy: number, k: number) => clamp((2 * (HOP_EXT - HOP_LOW) * k) / Math.max(1e-6, vy), PUSH_MIN, PUSH_MAX);

/** A hop at t: crouching (and pushing up out of it) where it stands, the feet planted; along the arc, the feet tucked under it and down again for the landing; the squash where it lands. */
function hopPose(x: HopPhase, t: number, k: number): TripPose {
  const tau = t - x.t0;
  const arms = (a: [number, number][], lean: number) => ({ near: a[0], far: a[1], lean });
  const vy = (h: number) => Math.sqrt(2 * HOP_G * Math.max(0, h));
  if (tau < x.crouch) {
    const push = Math.min(pushMs(vy(x.arc.a.y - x.arc.top), k), 0.6 * x.crouch);
    const down = x.crouch - push;
    // down into the crouch (eased), then up out of it gathering speed: the hips are going up as fast as the arc starts when the feet leave
    const hip = tau < down ? mix(RIG.hip, HOP_LOW, smooth(tau / down)) : mix(HOP_LOW, HOP_EXT, ((tau - down) / push) ** 2);
    return { root: x.a, feet: x.pre, hands: null, climb: 0, hip, f: x.f, arms: tau < down ? arms(ARMS_BACK, 9) : arms(ARMS_UP, 4) };
  }
  if (tau < x.crouch + x.air) {
    const u = (tau - x.crouch) / x.air;
    const root = arcAt(x.arc, u);
    const v = smooth(u);
    const tuck = u < 1 - HOP_REACH ? Math.sin((Math.PI * u) / (1 - HOP_REACH)) : 0;
    const foot = (n: 0 | 1): Foot => ({ x: root.x + mix(x.pre[n].x - x.a.x, x.post[n].x - x.b.x, v), y: root.y + mix(x.pre[n].y - x.a.y, x.post[n].y - x.b.y, v) - tuck * HOP_TUCK * k, lift: Math.max(1e-3, tuck) });
    const air = smooth(clamp(Math.min(tau - x.crouch, x.crouch + x.air - tau) / AIR_FADE, 0, 1));
    return { root, feet: [foot(0), foot(1)], hands: null, climb: 0, hip: mix(HOP_EXT, RIG.hip, Math.sin(Math.PI * u)), f: x.f, arms: u < 0.55 ? arms(ARMS_UP, 2) : arms(ARMS_OUT, 4), air };
  }
  // the catch: the hips go on down from where the legs met the floor, slowing to the bottom of the squash, then up to standing
  const w = tau - x.crouch - x.air;
  const c = Math.min(pushMs(vy(x.arc.b.y - x.arc.top), k), 0.5 * x.land);
  const hip = w < c ? mix(HOP_EXT, HOP_LOW, 1 - (1 - w / c) ** 2) : mix(HOP_LOW, RIG.hip, smooth((w - c) / Math.max(1, x.land - c)));
  return { root: x.b, feet: x.post, hands: null, climb: 0, hip, f: x.f, arms: w < c + 0.4 * (x.land - c) ? arms(ARMS_CATCH, 8) : undefined };
}

/** Where a walk or a climb has everything at t (hands and feet on the ladder while climbing). */
function poseIn(x: Phase, t: number, k: number): TripPose {
  if (x.kind === "hop") return hopPose(x, t, k);
  const u = x.t1 > x.t0 ? clamp((t - x.t0) / (x.t1 - x.t0), 0, 1) : 1;
  if (x.kind === "climb") {
    const root = { x: x.a.x, y: mix(x.a.y, x.b.y, prog(u, x.prof)) };
    const h = holds(x.rungs, x.x, x.f, root.y, k);
    return { root, feet: h.feet, hands: h.hands, climb: 1, hip: x.rungs.hip, f: x.f, snug: x.rungs.snug };
  }
  if (x.kind === "glide") {
    const s = glideS(x, t - x.t0);
    const root = along(x.pts, x.cum, s);
    // the heading: the line's direction around here (a chord over ±4 px, so it turns smoothly through a rounded elbow)
    const h0 = along(x.pts, x.cum, Math.min(s, x.L - 8) - 4);
    const h1 = along(x.pts, x.cum, Math.max(s, 8) + 4);
    const tau = t - x.t0;
    const T = x.t1 - x.t0;
    const capsule = x.morph > 0 ? smooth(clamp(Math.min(tau, T - tau) / x.morph, 0, 1)) : 1;
    const f = tau < T / 2 ? x.f : x.fOut;
    // the feet stay under it as it shrinks into the capsule (and come out from under it as it grows back)
    const st = RIG.stance * k * (1 - capsule);
    return { root, feet: [{ x: root.x + st * f, y: root.y, lift: 0 }, { x: root.x - st * f, y: root.y, lift: 0 }], hands: null, climb: 0, hip: RIG.hip, f, capsule, heading: Math.atan2(h1.y - h0.y, h1.x - h0.x) };
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

/** How much of a stretch of a trip its body has covered at t (0 … 1, by its speed profile): along a glide, the share of the line's length. */
export function phaseShare(x: Trip["phases"][number], t: number): number {
  if (x.kind === "glide") return x.L ? glideS(x, t - x.t0) / x.L : 1;
  if (x.kind === "hop") {
    // along the arc by its length: none while it crouches, all of it once it has landed
    const u = clamp((t - x.t0 - x.crouch) / x.air, 0, 1) * (x.pts.length - 1);
    const i = Math.min(x.pts.length - 2, Math.floor(u));
    const L = x.cum[x.cum.length - 1];
    return L ? mix(x.cum[i], x.cum[i + 1], u - i) / L : 1;
  }
  return prog(x.t1 > x.t0 ? clamp((t - x.t0) / (x.t1 - x.t0), 0, 1) : 1, x.prof);
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
  return { ...base, feet: blend(base.feet, h.feet, w), hands: h.hands, climb: w, hip: mix(RIG.hip, c.rungs.hip, w), f: c === prev ? c.f : base.f, snug: c.rungs.snug };
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
