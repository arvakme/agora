// The workers' procedural rig (web/docs/workstation.md §小人).
//
// Inspired by Loom Studio (loom-studio-sep-2026.moldandyeast.com, by RM / moldandyeast), whose page
// describes its figures: poses solved every frame with no keyframes, second-order dynamics on the
// body and joints, two-bone IK for arms and legs, and footsteps planned ahead so feet plant. None
// of its code is used here; this is an independent implementation of those published techniques
// (first written for the 工位视图 prototype, then ported here).
//
// What keeps replay exact:
//   - WHAT a worker does and WHERE its feet are is a pure function of the timeline time t
//     (stateAt in ./place.ts, planWalk / feetAt here). Scrubbing to t and playing up to t agree.
//   - Springs only smooth hands, lean and head between those targets. On a jump (seek, time going
//     backwards, a long gap) they are reset to the target, so a paused frame is always the exact pose.
// Times are milliseconds; lengths are figure units (1 unit = 1 CSS px at scale 1), ground y = 0, up −y.

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

export type Bone = { jx: number; jy: number; ex: number; ey: number };
/** Two-bone IK by the law of cosines: root (rx, ry) → target (tx, ty), bones a and b. bend +1 bends clockwise (y down). */
export function ik(rx: number, ry: number, tx: number, ty: number, a: number, b: number, bend: number): Bone {
  const dx = tx - rx;
  const dy = ty - ry;
  const d0 = Math.hypot(dx, dy) || 1e-3;
  const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, d0));
  const base = Math.atan2(dy, dx);
  const A = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
  const ang = base + bend * A;
  return { jx: rx + a * Math.cos(ang), jy: ry + a * Math.sin(ang), ex: rx + (dx / d0) * d, ey: ry + (dy / d0) * d };
}

export const RIG = { hip: 21, thigh: 11.6, shin: 11.2, torso: 15, upper: 8.4, fore: 8.2, head: 8.6, stance: 2.6 };
const smooth = (u: number) => u * u * (3 - 2 * u);

/** One walk from one dock to another, starting at t (ms). `slot` is the spot at the destination. */
export type Move = { from: string; to: string; t: number; slot: number; fromSlot?: number; ret?: boolean };
export type Step = { foot: 0 | 1; t0: number; t1: number; from: Pt; to: Pt };
export type WalkPlan = { a: Pt; b: Pt; f: 1 | -1; steps: Step[]; t0: number; t1: number; dist: number; path: Pt[] };

/** World px per ms (cruising). */
export const WALK_SPEED = 0.15;
export const WALK_MIN_MS = 700;
export const WALK_MAX_MS = 2600;
/** How long a turn takes (from facing one way to the other, through edge-on). */
export const TURN_MS = 200;
/** A beat to turn and shift weight before the first step: the turn is over before a foot lifts. */
export const SET_OFF_MS = 240;

/** Progress along the path at time fraction u: sine ease-in-out (starts and stops gently). */
const ease = (u: number) => (1 - Math.cos(Math.PI * u)) / 2;
/** Its inverse: the time fraction at which progress p is reached. */
const easeInv = (p: number) => Math.acos(1 - 2 * Math.max(0, Math.min(1, p))) / Math.PI;

/** A point `s` along a polyline (and the length). */
function along(path: Pt[]): { len: number; at: (s: number) => Pt } {
  const seg = path.slice(1).map((p, i) => Math.hypot(p.x - path[i].x, p.y - path[i].y));
  const len = seg.reduce((n, x) => n + x, 0);
  return {
    len,
    at(s: number) {
      let left = Math.max(0, Math.min(len, s));
      for (let i = 0; i < seg.length; i++) {
        if (left <= seg[i] || i === seg.length - 1) {
          const k = seg[i] ? left / seg[i] : 0;
          return { x: path[i].x + (path[i + 1].x - path[i].x) * k, y: path[i].y + (path[i + 1].y - path[i].y) * k };
        }
        left -= seg[i];
      }
      return path[path.length - 1];
    },
  };
}

/**
 * Footstep plan for one move (pure): after a short set-off, n steps of equal length along the path
 * (through `via`, the waypoints around nodes in the way) so the last one lands on the dock, then a
 * short closing step. Step times follow an ease-in-out curve, so the walk starts and stops gently
 * instead of at constant speed. Feet are planted except while they swing.
 */
export function planWalk(m: Move, a: Pt, b: Pt, via: Pt[] = []): WalkPlan {
  const path = [a, ...via, b];
  const P = along(path);
  const dist = P.len;
  const dur = Math.max(WALK_MIN_MS, Math.min(WALK_MAX_MS, (dist / WALK_SPEED) * 1.25));
  const n = Math.max(2, Math.round(dist / 16));
  const dx = b.x - a.x;
  const f: 1 | -1 = Math.abs(dx) < 8 ? 1 : dx > 0 ? 1 : -1;
  const start = m.t + SET_OFF_MS;
  const time = (k: number) => start + dur * easeInv(k / n);
  const steps: Step[] = [];
  let feet: Pt[] = [
    { x: a.x + RIG.stance * f, y: a.y },
    { x: a.x - RIG.stance * f, y: a.y },
  ];
  for (let k = 1; k <= n; k++) {
    const foot = (k % 2) as 0 | 1; // far foot leads
    const p = P.at((dist * k) / n);
    const to = k === n ? { x: b.x + (foot ? -1 : 1) * RIG.stance * f, y: b.y } : p;
    steps.push({ foot, t0: time(k - 1), t1: time(k), from: feet[foot], to });
    feet = feet.map((x, i) => (i === foot ? to : x));
  }
  const last = steps[steps.length - 1].foot;
  const other = (1 - last) as 0 | 1;
  const close = { x: b.x + (other ? -1 : 1) * RIG.stance * f, y: b.y };
  const sd = Math.max(120, (dur / n) * 1.4);
  steps.push({ foot: other, t0: start + dur, t1: start + dur + sd, from: feet[other], to: close });
  return { a, b, f, steps, t0: m.t, t1: start + dur + sd, dist, path };
}

/** Walk progress at t along the plan (0 → 1, eased), for bubbles and tests. */
export const walkProgress = (plan: WalkPlan, t: number) => (t <= plan.t0 + SET_OFF_MS ? 0 : t >= plan.t1 ? 1 : ease(Math.min(1, (t - plan.t0 - SET_OFF_MS) / (plan.t1 - plan.t0 - SET_OFF_MS))));

/**
 * Waypoints around the nodes a straight walk from a to b would cross (a simple hop over them):
 * docks sit on nodes' top edges, so the walk rises above the highest box in the way and comes
 * down at the destination. `boxes` are node boxes in world coordinates. Pure.
 */
export function routeAround(a: Pt, b: Pt, boxes: readonly { x: number; y: number; w: number; h: number }[], clearance = 18): Pt[] {
  const on = (p: Pt, r: { x: number; y: number; w: number; h: number }) => p.x >= r.x - 2 && p.x <= r.x + r.w + 2 && p.y >= r.y - 2 && p.y <= r.y + r.h + 2;
  const hits = boxes.filter((r) => {
    if (on(a, r) || on(b, r)) return false;
    const i = { x: r.x - 6, y: r.y - 6, w: r.w + 12, h: r.h + 12 };
    // segment / rectangle intersection by sampling (boxes are few; this runs once per walk plan)
    for (let k = 1; k < 24; k++) {
      const x = a.x + ((b.x - a.x) * k) / 24;
      const y = a.y + ((b.y - a.y) * k) / 24;
      if (x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + i.h) return true;
    }
    return false;
  });
  if (!hits.length) return [];
  const top = Math.min(a.y, b.y, ...hits.map((r) => r.y)) - clearance;
  return [
    { x: a.x, y: top },
    { x: b.x, y: top },
  ];
}

export type Foot = Pt & { lift: number };
/** Where both feet are at time t during a walk (pure), which one swings, and how far through its swing. */
export function feetAt(plan: WalkPlan, t: number): { feet: [Foot, Foot]; swing: -1 | 0 | 1; phase: number } {
  const first = (foot: 0 | 1) => plan.steps.find((s) => s.foot === foot)!.from;
  const feet: [Foot, Foot] = [
    { ...first(0), lift: 0 },
    { ...first(1), lift: 0 },
  ];
  let swing: -1 | 0 | 1 = -1;
  let phase = 0;
  for (const s of plan.steps) {
    if (t >= s.t1) {
      feet[s.foot] = { ...s.to, lift: 0 };
      continue;
    }
    if (t > s.t0) {
      const u = smooth((t - s.t0) / (s.t1 - s.t0));
      feet[s.foot] = { x: s.from.x + (s.to.x - s.from.x) * u, y: s.from.y + (s.to.y - s.from.y) * u, lift: Math.sin(Math.PI * u) * 4.5 };
      swing = s.foot;
      phase = u;
    }
    break;
  }
  return { feet, swing, phase };
}

/**
 * Where the body is along a walk at t: on the path at the eased progress — a continuous glide,
 * so the body never lurches with each step; the feet are planted and swing around it.
 */
export function rootAt(plan: WalkPlan, t: number): Pt {
  if (t <= plan.t0) return plan.a;
  if (t >= plan.t1) return plan.b;
  return along(plan.path).at(plan.dist * walkProgress(plan, t));
}

export type Pose = "walk" | "read" | "write" | "exec" | "think" | "wait" | "idle" | "delegate" | "handoff" | "unknown";
export type Prop = "laptop" | "terminal" | "sheet" | "carry" | null;
export type Targets = { near: [number, number]; far: [number, number]; lean: number; tilt: number; sway: number; prop: Prop; mark: "?" | "!" | null; markMuted?: boolean; facing: 1 | -1 };

/**
 * The pose's targets at time t (ms; pure). Hands are relative to the shoulder, x along the facing.
 * `since`: ms into the current segment. `bump`: 0→1→0 over the first 800 ms of a conflict.
 */
export function poseTargets(pose: Pose, t: number, since: number, o: { still: boolean; conflict?: boolean; bump?: number; unknownReceipt?: boolean; coarse?: boolean }): Targets {
  // `t` drives only the small loops (breathing, typing): the caller passes wall-clock time, so a
  // 16× replay does not make hands flicker. What the worker does comes from the timeline.
  const s = t / 1000;
  const osc = (period: number, amp: number, off = 0) => (o.still ? 0 : Math.sin((s / period + off) * 2 * Math.PI) * amp);
  const T: Targets = { near: [1.6, 16.4], far: [-1.4, 16.6], lean: 0, tilt: 0, sway: osc(3.6, 0.7), prop: null, mark: null, facing: 1 };
  switch (pose) {
    case "write": {
      const tap = (off: number) => (o.still ? 0 : Math.max(0, Math.sin((s / 0.3 + off) * 2 * Math.PI)) * 1.6);
      T.near = [13.5, 12 - tap(0)];
      T.far = [10.5, 12.4 - tap(0.5)];
      T.lean = 3;
      T.tilt = 6;
      T.prop = "laptop";
      T.sway = 0;
      break;
    }
    case "exec": {
      // a gesture: reach out and press enter, then watch the run
      const u = since / 1000;
      const press = o.still ? 0 : u < 0.7 ? Math.sin(Math.PI * (u / 0.7)) : Math.max(0, Math.sin(((u - 0.7) / 2.4) * 2 * Math.PI)) ** 8 * 0.6;
      T.near = [8 + press * 8, 11 - press * 2];
      T.far = [2.5, 13];
      T.lean = 1 + press * 3;
      T.tilt = 3;
      T.prop = "terminal";
      T.sway = 0;
      break;
    }
    case "read":
      T.near = [8.6, 7 + osc(2.6, 0.5)];
      T.far = [7, 8 + osc(2.6, 0.5)];
      T.tilt = 10;
      T.lean = 1.5;
      T.prop = "sheet";
      T.sway = osc(4, 0.4);
      break;
    case "think":
      T.near = [4.8, -2.4];
      T.far = [3.2, 9.5];
      T.tilt = -8 + osc(3.2, 2);
      T.lean = -1.5;
      break;
    case "wait":
      T.near = [10 + osc(1.1, 1.8), -15];
      T.far = [0.5, 16];
      T.tilt = -10;
      T.lean = -2;
      T.mark = "?";
      break;
    case "idle":
      T.near = [1.2, 16.6];
      T.far = [-1.2, 16.6];
      T.sway = osc(5, 0.9);
      break;
    case "delegate": // points: "you, go do this"
      T.near = [13 + osc(0.9, 1), 0.5];
      T.far = [2.5, 13];
      T.lean = 2;
      T.tilt = -4;
      T.sway = 0;
      break;
    case "handoff": // turn to the dispatcher and hold out the result
      T.facing = -1;
      T.near = [12.5, 7.5];
      T.far = [6, 9.5];
      T.lean = 4;
      T.tilt = 4;
      T.prop = "carry";
      T.sway = 0;
      break;
    case "unknown":
      T.near = [2.2, 14];
      T.far = [-0.5, 14.5];
      T.sway = osc(6, 0.6);
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
    // blocked: a visible bump when both reach the same file, then keep going, flagged
    T.mark = "!";
    const bump = o.bump ?? 0;
    if (bump > 0) {
      T.lean = -9 * bump;
      T.near = [6, 2 - 6 * bump];
      T.far = [4, 4 - 5 * bump];
      T.tilt = -12 * bump;
    }
  }
  return T;
}

/** A worker's springs (smooth hands, lean, head tilt, sway), kept per run between frames. */
export type Springs = { t: number | null; nx: Spring; ny: Spring; fx: Spring; fy: Spring; lean: Spring; tilt: Spring; sway: Spring; /** The turn in progress: from `turnFrom` (−1 = still facing the old way) to 1, starting at wall time `turnAt`. */
  turnFrom: number; turnAt: number; f: 1 | -1 | 0; prop: Spring; propKind: Prop };
export function makeSprings(): Springs {
  const hand = () => new Spring(3.2, 0.55, 0.4);
  // The body settles with a small, damped overshoot (arriving, standing up from a pose).
  const body = () => new Spring(2.2, 0.5, 0.3);
  return { t: null, nx: hand(), ny: hand(), fx: hand(), fy: hand(), lean: body(), tilt: new Spring(3, 0.45, 1.2), sway: body(), turnFrom: 1, turnAt: -Infinity, f: 0, prop: new Spring(4, 0.9, 0), propKind: null };
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
  walking: boolean;
};

/**
 * Solve one worker at timeline time t: from its dock (standing) or its walk plan (walking), the
 * pose's targets and its springs. Springs integrate wall-clock time (`dt`, seconds), so a replay at
 * 16× still blends at human speed. They are reset only on a real jump (`reset`: a seek or scrub,
 * or the tab coming back after a long pause), so a paused frame is exact and live updates blend.
 */
export function solve(o: { t: number; wall?: number; dt?: number; reset?: boolean; pose: Pose; since: number; dock: Pt; walk: WalkPlan | null; still: boolean; conflict?: boolean; bump?: number; unknownReceipt?: boolean; coarse?: boolean; readingWhileWalking?: boolean }, sp: Springs): Joints {
  const { t, still } = o;
  const wall = o.wall ?? t;
  const walking = !still && o.walk && t >= o.walk.t0 && t < o.walk.t1 ? o.walk : null;
  let root: Pt;
  let feet: Foot[];
  let f: 1 | -1 = 1;
  let bob = 0;
  let swingFoot = -1;
  let swingPhase = 0;
  if (walking) {
    const r = feetAt(walking, t);
    feet = r.feet;
    f = walking.f;
    swingFoot = r.swing;
    swingPhase = r.phase;
    root = rootAt(walking, t);
    bob = Math.min(2.2, (Math.abs(feet[0].x - feet[1].x) + Math.abs(feet[0].y - feet[1].y)) * 0.09);
  } else {
    root = { ...o.dock };
    feet = [
      { x: o.dock.x + RIG.stance, y: o.dock.y, lift: 0 },
      { x: o.dock.x - RIG.stance, y: o.dock.y, lift: 0 },
    ];
  }
  let T: Targets;
  if (walking) {
    const sw = swingFoot === 0 ? Math.sin(Math.PI * swingPhase) : swingFoot === 1 ? -Math.sin(Math.PI * swingPhase) : 0;
    T = { near: [-4.5 * sw, 15.8], far: [4.5 * sw, 15.8], lean: 3, tilt: 0, sway: 0, prop: o.readingWhileWalking ? "carry" : null, mark: null, facing: 1 };
  } else T = poseTargets(o.pose, wall, o.since, { still, conflict: o.conflict, bump: o.bump, unknownReceipt: o.unknownReceipt, coarse: o.coarse });
  if (!walking && T.facing === -1) {
    f = -1;
    feet = [
      { x: o.dock.x - RIG.stance, y: o.dock.y, lift: 0 },
      { x: o.dock.x + RIG.stance, y: o.dock.y, lift: 0 },
    ];
  }
  // Without an explicit wall-clock step (tests, one-off solves), fall back to the timeline step.
  const dt = o.dt ?? (sp.t == null ? -1 : (t - sp.t) / 1000);
  const jump = still || !!o.reset || sp.t == null || dt < 0 || dt > 1;
  sp.t = t;
  const step = Math.min(dt, 0.05);
  const S = (s: Spring, x: number) => (jump ? s.reset(x) : s.step(step, x));
  const near = [S(sp.nx, T.near[0]), S(sp.ny, T.near[1])];
  const far = [S(sp.fx, T.far[0]), S(sp.fy, T.far[1])];
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
  const py = -RIG.hip + bob * 0.6;
  const leanR = (lean * Math.PI) / 180;
  const nx = px + Math.sin(leanR) * RIG.torso * f;
  const ny = py - Math.cos(leanR) * RIG.torso;
  const shx = nx - L(0.4);
  const shy = ny + 2.2;
  const tiltR = (tilt * Math.PI) / 180;
  const hx = nx + L(0.8) + Math.sin(tiltR) * 2 * f;
  const hy = ny - RIG.head - 0.6 + Math.abs(Math.sin(tiltR)) * 0.8;
  const k = (p: Foot) => ({ x: p.x - root.x, y: p.y - root.y - p.lift });
  const fN = k(feet[0]);
  const fF = k(feet[1]);
  const hipN = { x: px + L(0.8), y: py };
  const hipF = { x: px - L(0.8), y: py };
  const shN = { x: shx + L(0.6), y: shy };
  const shF = { x: shx - L(0.6), y: shy };
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
    legN: ik(hipN.x, hipN.y, fN.x, fN.y, RIG.thigh, RIG.shin, -f),
    legF: ik(hipF.x, hipF.y, fF.x, fF.y, RIG.thigh, RIG.shin, -f),
    armN: ik(shN.x, shN.y, shx + L(near[0]), shy + near[1], RIG.upper, RIG.fore, f),
    armF: ik(shF.x, shF.y, shx + L(far[0]), shy + far[1], RIG.upper, RIG.fore, f),
    hipN,
    hipF,
    shN,
    shF,
    prop: sp.propKind,
    propAlpha: Math.max(0, Math.min(1, propAlpha)),
    turn: Math.max(-1, Math.min(1, turn)),
    mark: T.mark,
    markMuted: !!T.markMuted,
    walking: !!walking,
  };
}
