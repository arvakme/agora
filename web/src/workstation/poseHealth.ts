// 姿势体检 (web/docs/workstation.md §小人 · 姿势体检): what a solved figure must look like in every frame, and the frames to look at.
//
// `checkJoints` holds one frame of `solve` (./rig.ts) against rules a person would use to say "that pose is odd": knees and elbows
// bend the way they do, nothing is folded shut, a limb is not stretched to a point it cannot reach (the IK clamps it, and a foot
// that could not reach the ground hangs, a hand that could not reach a rung lets go), feet are on the ground unless the pose lifts
// them, hands are not inside the head, the head is over the hips. `frames` sweeps every pose, every gesture on its clock, every
// pose change, the trips of a walk, the doors' ladders, turns — the frames of a 16 ms display, and `sweep` runs the rules over
// them. Pure (no DOM): it runs under vitest, and scripts/pose-check.ts prints the offending frames and draws them.
import { REF_K } from "./docks";
import { gesture, type Gesture, type GestureIn } from "./gestures";
import { route, walkMap, type WalkMap } from "./route";
import { DOOR_H, DOOR_MS, makeSprings, planDoor, planTrip, poseTargets, RIG, solve, tripAt, type Foot, type Joints, type Pose, type Springs, type Trip } from "./rig";
import type { Box } from "../canvas/clearance";

export type Issue = { rule: string; detail: string };
/** What a frame is meant to be, for the rules that depend on it. */
export type Expect = {
  /** Both soles on the ground (a stand, a walk's planted foot): the lifted foot of a step, a ladder, a seat, a landing are not. */
  ground: [boolean, boolean];
  /** On a ladder: hands and feet are on rungs, the hips sink. */
  climbing: boolean;
  /** Sitting on an edge: the feet hang over it. */
  sitting: boolean;
  /** A crouch or a landing: the knees bend far on purpose. */
  crouching: boolean;
  /** Mid-turn (the figure is edge-on): the drawing squeezes, the rules on sides do not apply. */
  turning: boolean;
  /** The standing pose (hands behind the back), settled: both hands are behind the torso's back edge. */
  handsBack?: boolean;
};

const LIMIT = {
  /** A leg clamped by more than this (figure units) is stretched to where it cannot reach: the foot hangs. An arm may overshoot more — its springs
   * swing past a raised target and the hand simply stops at the straight arm — but not so far that the hand is left well short of where it is meant to be. */
  reach: 0.8,
  reachArm: 3,
  /** A leg on a ladder reaches for its next rung: it may be a little short of it for a frame or two while the body moves on. */
  reachClimb: 1.5,
  /** An elbow bent tighter than this many degrees folds the arm onto itself. */
  foldArm: 15,
  /** A knee (or elbow) bent tighter than this many degrees is folded shut. */
  fold: 32,
  /** A knee that points backwards by more than this many units off the hip → ankle line. */
  back: 0.35,
  /** A sole that should be on the ground is off it, or below it, by more than this. */
  sole: 0.9,
  /** A hand this far inside the head circle (of its radius) is in the head. */
  head: 0.7,
};

/** The torso's half width in the drawing (figureNode.ts: paper 9.2 wide at the rig's scale, and the outline). */
const R_TORSO = (9.2 * (RIG.torso / 16.4)) / 2 + 0.45;
const deg = (r: number) => (r * 180) / Math.PI;
/** The angle at the middle joint of a limb, in degrees (180 = straight). */
function angleAt(rx: number, ry: number, jx: number, jy: number, ex: number, ey: number): number {
  const a = Math.atan2(ry - jy, rx - jx);
  const b = Math.atan2(ey - jy, ex - jx);
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return deg(d);
}
/** How far the middle joint is off the line root → end, on the side the limb bends towards (+) or away from (−); side: +1 = along the facing. */
function offLine(rx: number, ry: number, jx: number, jy: number, ex: number, ey: number, f: number): number {
  const dx = ex - rx;
  const dy = ey - ry;
  const len = Math.hypot(dx, dy) || 1;
  // the joint's distance from the line, signed so that the side of +x·f is positive
  const c = ((jx - rx) * dy - (jy - ry) * dx) / len;
  return dy >= 0 ? c * f : -c * f;
}

export function checkJoints(j: Joints, e: Expect): Issue[] {
  const out: Issue[] = [];
  const f = j.f;
  const limbs: [string, Joints["legN"], Joints["hipN"]][] = [["leg near", j.legN, j.hipN], ["leg far", j.legF, j.hipF]];
  const arms: [string, Joints["armN"], Joints["shN"]][] = [["arm near", j.armN, j.shN], ["arm far", j.armF, j.shF]];
  for (const [name, b] of [...limbs, ...arms] as [string, Joints["legN"], Pt][]) {
    if (b.over > (name.startsWith("arm") ? LIMIT.reachArm : e.climbing ? LIMIT.reachClimb : LIMIT.reach) && !(e.climbing && name.startsWith("arm"))) out.push({ rule: "reach", detail: `${name} asked ${b.over.toFixed(1)} beyond what it can reach` });
  }
  if (!e.turning) {
    for (const [name, b, r] of limbs) {
      const knee = angleAt(r.x, r.y, b.jx, b.jy, b.ex, b.ey);
      if (knee < LIMIT.fold && !e.crouching) out.push({ rule: "fold", detail: `${name}'s knee is bent to ${knee.toFixed(0)}°` });
      const off = offLine(r.x, r.y, b.jx, b.jy, b.ex, b.ey, f);
      if (off < -LIMIT.back && knee < 172) out.push({ rule: "knee", detail: `${name}'s knee points backwards (${off.toFixed(1)} off the hip–foot line)` });
    }
    for (const [name, b, r] of arms) {
      const elbow = angleAt(r.x, r.y, b.jx, b.jy, b.ex, b.ey);
      if (elbow < LIMIT.foldArm && !e.climbing) out.push({ rule: "fold", detail: `${name}'s elbow is bent to ${elbow.toFixed(0)}°` });
    }
  }
  // soles: on the ground where the frame says so, never through it (a seat and a ladder aside)
  const soles = [j.legN, j.legF];
  soles.forEach((b, i) => {
    if (e.climbing || e.sitting) return;
    if (e.ground[i] && Math.abs(b.ey) > LIMIT.sole) out.push({ rule: "sole", detail: `${i ? "far" : "near"} foot planted but ${b.ey < 0 ? `${(-b.ey).toFixed(1)} above` : `${b.ey.toFixed(1)} below`} the ground` });
    if (!e.ground[i] && b.ey > LIMIT.sole) out.push({ rule: "sole", detail: `${i ? "far" : "near"} foot is ${b.ey.toFixed(1)} below the ground` });
  });
  // hands are not in the head
  for (const [name, b] of arms) {
    if (e.climbing) break; // hands hold rungs at whatever height the rungs are
    const d = Math.hypot(b.ex - j.hx, b.ey - j.hy);
    if (d < RIG.head * LIMIT.head) out.push({ rule: "head", detail: `${name}'s hand is inside the head (${d.toFixed(1)} from its centre)` });
  }
  // standing with the hands behind the back: past the torso's back edge, not drawn over the body in front of it
  if (e.handsBack) {
    for (const [name, b] of arms) {
      const t = (b.ey - j.py) / (j.ny - j.py || -1); // where along hips → neck the hand's height is
      const axis = j.px + (j.nx - j.px) * Math.min(1, Math.max(0, t));
      const behind = (axis - b.ex) * f; // > 0: the hand is behind the axis
      if (behind < R_TORSO) out.push({ rule: "behind", detail: `${name}'s hand is ${behind.toFixed(1)} behind the body's axis: not past the back edge (${R_TORSO.toFixed(1)})` });
    }
  }
  // the head is over the hips, the hips over the feet
  if (j.hy > j.py - RIG.torso * 0.5) out.push({ rule: "body", detail: `head (y ${j.hy.toFixed(1)}) is not above the hips (y ${j.py.toFixed(1)})` });
  return out;
}
type Pt = { x: number; y: number };

// ——— the frames ———
/** `k`: world px per figure unit the frame was solved at (a trip's root is in world px). `ladder`: a door's ladder is on (which way it goes: 1 down from the floor, −1 up from it). */
export type Frame = { scenario: string; label: string; t: number; joints: Joints; expect: Expect; k: number; ladder?: { dir: 1 | -1 }; /** Cut off by the door's line (the figure is all the way down or up): nothing of it shows, so nothing is checked. */ hidden?: boolean };
const STEP = 16; // ms: one 60 Hz frame

const base = (o: Partial<Parameters<typeof solve>[0]> & { t: number; pose: Pose }) => ({ since: 0, dock: { x: 0, y: 0 }, trip: null, still: false, k: REF_K, ...o });
const standing = (over: Partial<Expect> = {}): Expect => ({ ground: [true, true], climbing: false, sitting: false, crouching: false, turning: false, ...over });
const isCrouch = (G?: Gesture) => !!G && ((G.crouch ?? 0) > 0.5 || (G.lift ?? 0) > 0.1 || (G.scale ?? 1) < 0.99);

/** The gesture at a moment, the way the overlay asks for it, with what `GestureIn` needs filled in. */
const gest = (pose: Pose, t: number, o: Partial<GestureIn> = {}): Gesture => gesture({ pose, since: t, t, wall: t, still: false, ...o });

/** Every pose at rest and the frames after one pose gives way to another (springs blend hands and lean; facing turns). */
function poses(): Frame[] {
  const all: Pose[] = ["idle", "read", "write", "exec", "think", "wait", "delegate", "handoff", "unknown"];
  const out: Frame[] = [];
  for (const p of all) {
    const sp = makeSprings();
    const j = solve(base({ t: 0, pose: p, reset: true }), sp);
    out.push({ scenario: "pose at rest", label: p, t: 0, joints: j, expect: standing({ handsBack: p === "idle" || p === "unknown" }), k: REF_K });
  }
  for (const a of all) {
    for (const b of all) {
      if (a === b) continue;
      const sp = makeSprings();
      let wall = 0;
      solve(base({ t: 0, wall: 0, pose: a, reset: true }), sp);
      for (let i = 1; i <= 90; i++) {
        wall = i * STEP;
        const T = poseTargets(b, wall, 0, { still: false });
        const j = solve(base({ t: wall, wall, dt: STEP / 1000, pose: b, since: wall }), sp);
        out.push({ scenario: "pose change", label: `${a} → ${b}`, t: wall, joints: j, expect: standing({ turning: Math.abs(j.turn) < 0.98 || (T.facing === -1 && i < 20) }), k: REF_K });
      }
    }
  }
  return out;
}

/** Standing by itself for 24 s: breathing, weight shifting, a glance. */
function stand(): Frame[] {
  const out: Frame[] = [];
  for (const pose of ["idle", "unknown"] as Pose[]) {
    const sp = makeSprings();
    let first = true;
    for (let t = 0; t <= 24_000; t += STEP) {
      const j = solve(base({ t, wall: t, dt: first ? undefined : STEP / 1000, reset: first, pose, since: t }), sp);
      first = false;
      out.push({ scenario: "stand", label: `${pose}: breathing, shifting, a glance`, t, joints: j, expect: standing({ handsBack: true }), k: REF_K });
    }
  }
  return out;
}

/** The layers: standing, an activity over it, standing again — through the raise of the hands going in and the clap coming out (起势 → 动作 → 收势). */
function layers(): Frame[] {
  const out: Frame[] = [];
  const acts: Pose[] = ["write", "read", "exec", "think", "wait", "delegate", "handoff"];
  for (const a of acts) {
    for (const b of [a, ...acts.filter((x) => x !== a).slice(0, 2)]) {
      const sp = makeSprings();
      const label = a === b ? `layer: idle → ${a} → idle` : `layer: idle → ${a} → ${b} → idle`;
      let first = true;
      const T = a === b ? [0, 1200, 3400] : [0, 1200, 2600, 4800];
      const end = T[T.length - 1] + 1600;
      for (let t = 0; t <= end; t += STEP) {
        const seg = T.filter((x) => x <= t).length - 1;
        const pose: Pose = a === b ? (seg === 1 ? a : "idle") : seg === 1 ? a : seg === 2 ? b : "idle";
        const since = t - T[Math.max(0, seg)];
        const j = solve(base({ t, wall: t, dt: first ? undefined : STEP / 1000, reset: first, pose, since }), sp);
        first = false;
        const settled = pose === "idle" && (seg === 0 ? t > 700 : t - T[seg] > 1000);
        out.push({ scenario: "layer", label, t, joints: j, expect: standing({ turning: Math.abs(j.turn) < 0.98 || pose === "handoff" || a === "handoff" || b === "handoff", handsBack: settled }), k: REF_K });
      }
    }
  }
  return out;
}

/** The gestures on their clocks: landing, looking down on arrival, a save, a run's verdict, a handover, a clash, a nod, the wave, the stretch, sitting down and getting up. */
function gestures(): Frame[] {
  const out: Frame[] = [];
  const run = (name: string, pose: Pose, from: number, to: number, ins: (t: number) => Partial<GestureIn>) => {
    const sp = makeSprings();
    let first = true;
    for (let t = from; t <= to; t += STEP) {
      const G = gest(pose, t, ins(t));
      const j = solve(base({ t, wall: t, dt: first ? undefined : STEP / 1000, reset: first, pose, since: t, gest: G }), sp);
      first = false;
      out.push({ scenario: "gesture", label: name, t, joints: j, expect: standing({ sitting: (G.sit?.w ?? 0) > 0, crouching: isCrouch(G) || (G.sit?.w ?? 0) > 0, ground: (G.sit?.w ?? 0) > 0 ? [false, false] : (G.lift ?? 0) > 0 ? [false, false] : [true, true], turning: !!G.turn || !!G.face || Math.abs(j.turn) < 0.98 }), k: REF_K });
    }
  };
  run("landing (a sub-agent dispatched)", "idle", 0, 700, () => ({ spawnAt: 0 }));
  run("looking down on arrival", "idle", 0, 900, () => ({ arrivedAt: 0 }));
  run("save (write ends)", "write", 0, 900, () => ({ savedAt: 0 }));
  run("a command's verdict", "exec", 0, 1500, () => ({ ran: { at: 0, ok: true } }));
  run("a sub-agent hands over", "wait", 0, 1600, () => ({ receive: { at: 0, dx: 40 } }));
  run("a clash writing the same file", "write", 0, 1600, () => ({ conflict: { at: 0, dx: 30 } }));
  run("a comment answered (the nod)", "idle", 0, 1200, () => ({ answeredAt: 0 }));
  run("waiting: the wave", "wait", 0, 16_000, (t) => ({ idleFor: t }));
  run("idle: stretch, sit down (20–45 s)", "idle", 18_000, 48_000, (t) => ({ idleFor: t }));
  run("idle → new work: getting up from the seat", "idle", 0, 1600, () => ({ roseAt: 0, idleFor: 60_000 }));
  run("clicked", "idle", 0, 1200, () => ({ clickAt: 0 }));
  run("talked to", "idle", 0, 1800, () => ({ talkAt: 0 }));
  run("a hello (page back)", "idle", 0, 1800, () => ({ attentionAt: 0 }));
  return out;
}

const PROTO: Record<string, Box> = {
  web: { x: 40, y: 230, w: 170, h: 72 },
  api: { x: 330, y: 230, w: 200, h: 72 },
  mysql: { x: 680, y: 120, w: 160, h: 64 },
  redis: { x: 680, y: 330, w: 160, h: 64 },
  pay: { x: 350, y: 450, w: 160, h: 64 },
  tray: { x: 620, y: 470, w: 200, h: 56 },
};
const pts = (...n: number[]) => n.filter((_, i) => i % 2 === 0).map((x, i) => ({ x, y: n[2 * i + 1] }));
const MAP: WalkMap = walkMap(new Map(Object.entries(PROTO)), [
  { from: "web", to: "api", pts: pts(210, 266, 330, 266) },
  { from: "api", to: "mysql", pts: pts(530, 252, 610, 252, 610, 152, 680, 152) },
  { from: "api", to: "redis", pts: pts(530, 280, 610, 280, 610, 362, 680, 362) },
  { from: "api", to: "pay", pts: pts(430, 302, 430, 450) },
]);
const spot = (place: string, x: number) => ({ place, at: { x, y: PROTO[place].y } });

/** The trips the sweep walks: name, from (place, x), to (place, x). */
const TRIPS: [string, string, number, string, number][] = [
  ["api → mysql (ladder up)", "api", 354, "mysql", 704],
  ["mysql → api (ladder down)", "mysql", 704, "api", 354],
  ["web → api (a bridge)", "web", 64, "api", 400],
  ["web → pay (bridge, then down beside api)", "web", 64, "pay", 374],
  ["pay → api (up beside api)", "pay", 374, "api", 354],
  ["web → the tray (a scaffold)", "web", 64, "tray", 650],
  ["a few steps on one floor", "api", 354, "api", 380],
];

const HALL = walkMap(new Map([["hall", { x: 0, y: 100, w: 3000, h: 40 }]]), []);

/** A long walk along one floor at several sizes and paces (a sub-agent is smaller; a catch-up is faster): many strides, so many arm swings. */
function walks(): Frame[] {
  const out: Frame[] = [];
  for (const scale of [0.8, 1, 1.25]) {
    for (const boost of [1, 1.6]) {
      const k = REF_K * scale;
      const from = { place: "hall", at: { x: 100, y: 100 } };
      const to = { place: "hall", at: { x: 700, y: 100 } };
      const trip = planTrip({ from: "hall", to: "hall", t: 0, slot: 0, boost }, route(HALL, from, to), from.at, k);
      out.push(...tripFrames(`a long walk (k ${k.toFixed(2)}, pace ×${boost})`, trip, k, "idle"));
    }
  }
  return out;
}

/** Walk and climb frames along `trip`, then a second of standing after it (the trip's end hands over to the pose). */
function tripFrames(name: string, trip: Trip, k: number, after: Pose): Frame[] {
  const out: Frame[] = [];
  const sp = makeSprings();
  let first = true;
  for (let t = trip.t0 - 300; t <= trip.t1 + 1200; t += STEP) {
    const j = solve(base({ t, wall: t, dt: first ? undefined : STEP / 1000, reset: first, pose: after, since: Math.max(0, t - trip.t1), dock: t < trip.t0 ? trip.a : trip.b, trip, k }), sp);
    first = false;
    const inside = t >= trip.t0 && t < trip.t1;
    const tp = inside ? tripAt(trip, t) : null;
    const lift = (f: Foot) => f.lift > 1e-6;
    out.push({
      scenario: "trip", label: name, t, joints: j,
      expect: standing({ climbing: j.climb > 0.02, ground: tp ? [!lift(tp.feet[0]), !lift(tp.feet[1])] : [true, true], turning: Math.abs(j.turn) < 0.98 || (inside && t < trip.t0 + 400) }),
      k,
    });
  }
  return out;
}

function trips(): Frame[] {
  const out: Frame[] = [];
  const k = REF_K;
  const T0 = 0;
  for (const [name, a, ax, b, bx] of TRIPS) {
    const from = spot(a, ax);
    const to = spot(b, bx);
    const rt = route(MAP, from, to);
    const trip = planTrip({ from: a, to: b, t: T0, slot: 0 }, rt, from.at, k);
    for (const after of ["idle", "read", "wait"] as Pose[]) out.push(...tripFrames(`${name}, then ${after}`, trip, k, after));
  }
  return out;
}

/** The doors' ladders (LD1): going in and coming out, on the parent's canvas (down) and the sub-diagram's (up), then standing. */
function doors(): Frame[] {
  const out: Frame[] = [];
  for (const dir of [1, -1] as const) {
    for (const leaving of [true, false]) {
      for (const k of [REF_K, REF_K * 0.8]) {
        const trip = planDoor(k, dir, leaving, 1);
        const sp = makeSprings();
        let first = true;
        for (let t = 0; t <= DOOR_MS + 1200; t += STEP) {
          const inTrip = t >= 0 && t < DOOR_MS;
          const j = solve(base({ t, wall: t, dt: first ? undefined : STEP / 1000, reset: first, pose: "idle", since: Math.max(0, t - DOOR_MS), dock: { x: 0, y: leaving ? 0 : 0 }, trip: inTrip ? trip : null, k }), sp);
          first = false;
          const hidden = inTrip && (dir === 1 ? j.root.y + (j.hy - RIG.head) * k >= 0 : j.root.y + Math.max(j.legN.ey, j.legF.ey) * k <= -DOOR_H * k);
          out.push({ hidden, scenario: "door", label: `${dir === 1 ? "down (parent canvas)" : "up (sub-diagram)"}, ${leaving ? "going in" : "coming out"}, k ${k.toFixed(2)}`, t, joints: j, expect: standing({ climbing: j.climb > 0.02, ground: j.climb > 0.02 || inTrip ? [false, false] : [true, true], turning: Math.abs(j.turn) < 0.98 }), k, ladder: inTrip || (t < 0 || t >= DOOR_MS) ? { dir } : undefined });
        }
      }
    }
  }
  return out;
}

/** The frames of every scenario. */
export function frames(): Frame[] {
  return [...poses(), ...stand(), ...layers(), ...gestures(), ...trips(), ...walks(), ...doors()];
}

export type Found = { frame: Frame; issues: Issue[] };
/** Run the rules over every frame; the frames with something wrong. */
export function sweep(fs: readonly Frame[] = frames()): Found[] {
  const found: Found[] = [];
  for (const frame of fs) {
    if (frame.hidden) continue;
    const issues = checkJoints(frame.joints, frame.expect);
    if (issues.length) found.push({ frame, issues });
  }
  return found;
}

/** Where a frame's joints are, in figure space (the root is the origin), for the frame-to-frame checks. */
const spots = (j: Joints): [string, number, number][] => [["head", j.hx, j.hy], ["hips", j.px, j.py], ["knee near", j.legN.jx, j.legN.jy], ["knee far", j.legF.jx, j.legF.jy], ["foot near", j.legN.ex, j.legN.ey], ["foot far", j.legF.ex, j.legF.ey], ["hand near", j.armN.ex, j.armN.ey], ["hand far", j.armF.ex, j.armF.ey]];
/** Consecutive frames of one run, facing the same way (a flip of the facing is drawn mirrored through the turn, so its coordinates flip while the picture does not). */
const sameRun = (a: Frame, b: Frame) => a.scenario === b.scenario && a.label === b.label && b.t - a.t === STEP && a.joints.f === b.joints.f;

/** A joint that moves further than `max` figure units in one 16 ms frame (a jump: a fast walk's foot swings 9 at most, a pop is 15 and up), except across a turn. */
export function jumps(fs: readonly Frame[], max = 10): { a: Frame; b: Frame; joint: string; d: number }[] {
  const out: { a: Frame; b: Frame; joint: string; d: number }[] = [];
  for (let i = 1; i < fs.length; i++) {
    const a = fs[i - 1];
    const b = fs[i];
    if (!sameRun(a, b) || a.expect.turning || b.expect.turning || a.hidden || b.hidden) continue;
    const pa = spots(a.joints);
    const pb = spots(b.joints);
    pa.forEach(([name, x, y], n) => {
      const d = Math.hypot(pb[n][1] - x, pb[n][2] - y);
      if (d > max) out.push({ a, b, joint: name, d });
    });
  }
  return out;
}

/** The most an elbow may move in one 16 ms frame: a flip to the other side of the arm is 10–19 units; the fastest smooth turn measured is 6.2 (a hand passing a rung at shoulder height), and walking never moves it more than 1. */
export const ELBOW_MAX = 7;
export const ELBOW_MAX_WALKING = 3;

/** An elbow that moves more than `max` figure units in one 16 ms frame: it has flipped to the other side of the arm (an arm's elbow is 9.4 from the shoulder, so a flip is 10–20). Mirrored turns and what a door's cut hides are not counted. */
export function elbowJumps(fs: readonly Frame[], max = ELBOW_MAX): { a: Frame; b: Frame; arm: string; d: number }[] {
  const out: { a: Frame; b: Frame; arm: string; d: number }[] = [];
  for (let i = 1; i < fs.length; i++) {
    const a = fs[i - 1];
    const b = fs[i];
    if (!sameRun(a, b) || a.expect.turning || b.expect.turning || a.hidden || b.hidden) continue;
    for (const [arm, ea, eb] of [["near", a.joints.armN, b.joints.armN], ["far", a.joints.armF, b.joints.armF]] as const) {
      const d = Math.hypot(eb.jx - ea.jx, eb.jy - ea.jy);
      if (d > max) out.push({ a, b, arm, d });
    }
  }
  return out;
}

/** A pop: a joint's step this frame differs from its step the frame before by more than `max` figure units (a sudden change of velocity, as scripts/motion-capture.ts counts them for the screen). */
export function snaps(fs: readonly Frame[], max = 2.5): { a: Frame; b: Frame; joint: string; d: number }[] {
  const out: { a: Frame; b: Frame; joint: string; d: number }[] = [];
  for (let i = 2; i < fs.length; i++) {
    const [z, a, b] = [fs[i - 2], fs[i - 1], fs[i]];
    if (!sameRun(z, a) || !sameRun(a, b) || [z, a, b].some((f) => f.expect.turning || f.hidden)) continue;
    const pz = spots(z.joints);
    const pa = spots(a.joints);
    const pb = spots(b.joints);
    pa.forEach(([name, x, y], n) => {
      const d = Math.hypot(pb[n][1] - x - (x - pz[n][1]), pb[n][2] - y - (y - pz[n][2]));
      if (d > max) out.push({ a, b, joint: name, d });
    });
  }
  return out;
}

// ——— the speed of a trip (what the body does along the way, before any pose is put on it) ———
/** The most a body may speed up or slow down (px/ms², for a figure at the reference scale): 1200 px/s². */
export const ACCEL_MAX = 0.0012;
export type Speed = { name: string; samples: { t: number; v: number }[]; maxV: number; maxAccel: number; /** How long it stands before the first step (the turn and the weight shift), ms. */ setOff: number; /** The moments inside the trip where the body all but stops (a leg's end and the next leg's start each go to rest). */ dips: number[] };
/** The root's speed (world px per ms) along a trip every 16 ms, where it stands before setting off, and the dips to rest between legs (walk → ladder → walk). */
export function speedOf(name: string, trip: Trip): Speed {
  const samples: { t: number; v: number }[] = [];
  let prev = tripAt(trip, trip.t0).root;
  for (let t = trip.t0 + STEP; t <= trip.t1; t += STEP) {
    const p = tripAt(trip, t).root;
    samples.push({ t, v: Math.hypot(p.x - prev.x, p.y - prev.y) / STEP });
    prev = p;
  }
  const maxV = Math.max(0, ...samples.map((s) => s.v));
  let maxAccel = 0;
  for (let i = 1; i < samples.length; i++) maxAccel = Math.max(maxAccel, Math.abs(samples[i].v - samples[i - 1].v) / STEP);
  const first = samples.findIndex((s) => s.v > 0.04 * maxV);
  const setOff = first < 0 ? trip.t1 - trip.t0 : samples[first].t - trip.t0;
  // a dip: a local minimum under a fifth of the top speed after the set-off and before the arrival (a leg ends at rest and the next starts from it)
  const dips: number[] = [];
  for (let i = Math.max(1, first + 8); i < samples.length - 8; i++) {
    const s = samples[i];
    if (s.v < 0.2 * maxV && s.v <= samples[i - 1].v && s.v < samples[i + 1].v) dips.push(s.t);
  }
  return { name, samples, maxV, maxAccel, setOff, dips };
}

/** The speed of every trip the sweep walks, and of the doors' ladders. */
export function speeds(): Speed[] {
  const out: Speed[] = [];
  const k = REF_K;
  for (const [name, a, ax, b, bx] of TRIPS) {
    const from = spot(a, ax);
    const to = spot(b, bx);
    out.push(speedOf(name, planTrip({ from: a, to: b, t: 0, slot: 0 }, route(MAP, from, to), from.at, k)));
  }
  for (const [name, dir, leaving] of [["door down, going in", 1, true], ["door down, coming out", 1, false], ["door up, going in", -1, true], ["door up, coming out", -1, false]] as const) out.push(speedOf(name, planDoor(k, dir, leaving, 1)));
  return out;
}

/** The standing pose's own motion, over `fs` (frames of one standing worker): how far the hips rise and fall, how far the body sways, how far the head tips. */
export function standRange(fs: readonly Frame[]): { hips: number; sway: number; tilt: number } {
  const ys = fs.map((f) => f.joints.py);
  const xs = fs.map((f) => f.joints.px);
  const tilts = fs.map((f) => Math.abs(deg(Math.atan2((f.joints.hx - f.joints.nx) * f.joints.f, f.joints.ny - f.joints.hy))));
  return { hips: Math.max(...ys) - Math.min(...ys), sway: Math.max(...xs) - Math.min(...xs), tilt: Math.max(...tilts) };
}

/** Frames of the blends between layers (起势/收势): no joint jumps more than `max` figure units in one frame. */
export function layerJumps(fs: readonly Frame[], max = 5): ReturnType<typeof jumps> {
  return jumps(fs.filter((f) => f.scenario === "layer"), max);
}
