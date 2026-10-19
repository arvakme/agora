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
import { ladderShape } from "./hatch";
import { route, walkMap, type Leg, type Route, type WalkMap } from "./route";
import { CLIMB_SPEED, DOOR_H, DOOR_MS, makeSprings, planDoor, planTrip, poseTargets, RIG, rungGrid, solve, tripAt, type Foot, type Joints, type Pose, type Springs, type Trip } from "./rig";
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
/** The same diagram with no arrows: every way between nodes is a hop (§5 跳过去), as to the 图外 tray. */
const BARE: WalkMap = walkMap(new Map(Object.entries(PROTO)), []);
/** The demo project's slanted arrow (api → cache), glided straight along its slant. */
const SLANT: Record<string, Box> = { api: { x: 360, y: 210, w: 80, h: 101.3 }, cache: { x: 506.4, y: 445.6, w: 100, h: 79 } };
const SLANTED: WalkMap = walkMap(new Map(Object.entries(SLANT)), [{ from: "api", to: "cache", pts: pts(439.3, 317.3, 524.6, 439.6) }]);
const spot = (place: string, x: number, boxes: Record<string, Box> = PROTO) => ({ place, at: { x, y: boxes[place].y } });

/** No walk map (./place.ts `straight`): along at the start's height, then a ladder up or down — the only ladders left on a trip (§5 跳过去), climbed as before. */
const LADDER = null;
/** The trips the sweep walks: name, the map (LADDER: none), from (place, x), to (place, x). */
const TRIPS: [string, WalkMap | null, string, number, string, number][] = [
  ["api → mysql (glide along the SQL arrow, up)", MAP, "api", 354, "mysql", 704],
  ["mysql → api (glide along the SQL arrow, down)", MAP, "mysql", 704, "api", 354],
  ["web → api (glide along the HTTP arrow)", MAP, "web", 64, "api", 400],
  ["web → pay (not one arrow: a hop down past api)", MAP, "web", 64, "pay", 374],
  ["pay → api (glide up the api → pay arrow)", MAP, "pay", 374, "api", 354],
  ["api → cache (glide along a slanted arrow)", SLANTED, "api", 380, "cache", 530],
  ["api → mysql, no arrow (hop up)", BARE, "api", 354, "mysql", 704],
  ["mysql → api, no arrow (hop down)", BARE, "mysql", 704, "api", 354],
  ["web → api, no arrow (a level hop over the gap)", BARE, "web", 64, "api", 400],
  ["api → pay, no arrow (off api's edge, round its wall, down onto pay)", BARE, "api", 354, "pay", 374],
  ["pay → api, no arrow (up round api's wall onto its top)", BARE, "pay", 374, "api", 354],
  ["mysql → redis (not one arrow: off mysql's edge down onto redis)", MAP, "mysql", 704, "redis", 704],
  ["web → mysql (not one arrow: a long hop up)", MAP, "web", 64, "mysql", 704],
  ["web → the tray (a hop over api)", MAP, "web", 64, "tray", 650],
  ["the tray → mysql (a hop up past redis)", MAP, "tray", 650, "mysql", 704],
  ["api → mysql with no way map (a ladder up)", LADDER, "api", 354, "mysql", 704],
  ["mysql → api with no way map (a ladder down)", LADDER, "mysql", 704, "api", 354],
  ["a few steps on one floor", MAP, "api", 354, "api", 380],
];
/** A trip of TRIPS, planned for a figure at k world px per unit, starting at t. */
function tripOf([, map, a, ax, b, bx]: (typeof TRIPS)[number], k: number, t = 0): Trip {
  const boxes = map === SLANTED ? SLANT : PROTO;
  const from = spot(a, ax, boxes);
  const to = spot(b, bx, boxes);
  return planTrip({ from: a, to: b, t, slot: 0 }, map ? route(map, from, to) : straight(from.at, to.at), from.at, k);
}
/** As ./place.ts plans a move without a walk map: along at the start's height, then up or down. */
function straight(a: { x: number; y: number }, b: { x: number; y: number }): Route {
  const legs: Leg[] = [];
  if (a.x !== b.x) legs.push({ kind: "walk", a, b: { x: b.x, y: a.y }, temp: false });
  if (a.y !== b.y) legs.push({ kind: "climb", a: { x: b.x, y: a.y }, b, temp: false });
  return { legs, len: Math.abs(b.x - a.x) + Math.abs(b.y - a.y) };
}

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
  for (const tr of TRIPS) {
    const name = tr[0];
    const trip = tripOf(tr, k, T0);
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
          const hidden = (leaving && t >= DOOR_MS) || inTrip && (dir === 1 ? j.root.y + (j.hy - RIG.head) * k >= 0 : j.root.y + Math.max(j.legN.ey, j.legF.ey) * k <= -DOOR_H * k);
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
export type Speed = { name: string; samples: { t: number; v: number }[]; maxV: number; maxAccel: number; /** How long it stands before the first step (the turn and the weight shift), ms. */ setOff: number; /** The moments inside the trip where the body all but stops (a leg's end and the next leg's start each go to rest). */ dips: number[];
  /** Along arrows (as a capsule): the top speed and the steepest change of it, and how many glides. */ glideMaxV: number; glideMaxAccel: number; glides: number;
  /** Hopping (§5 跳过去): the top speed in the air, the steepest change of speed in the air (gravity; the frames where the feet leave or touch down aside), and how many hops. */ hopMaxV: number; hopMaxAccel: number; hops: number };
/** A capsule gliding along an arrow changes its speed at most this fast (px/ms², rig.ts GLIDE_ACCEL 0.003 and a margin for the sampling). */
export const GLIDE_ACCEL_MAX = 0.0035;
/** In the air a hop goes no faster than this (px/ms: 19 px a frame at 60 fps; a fall from 350 px up meets the floor at 1 px/ms) and changes speed no faster than its gravity (route.ts HOP_G, 0.0013, and a margin for the sampling and the swing out). */
export const HOP_V_MAX = 1.2;
export const HOP_ACCEL_MAX = 0.0016;
/** The root's speed (world px per ms) along a trip every 16 ms, where it stands before setting off, and the dips to rest between legs (walk → ladder → walk). */
export function speedOf(name: string, trip: Trip): Speed {
  const samples: { t: number; v: number }[] = [];
  let prev = tripAt(trip, trip.t0).root;
  for (let t = trip.t0 + STEP; t <= trip.t1; t += STEP) {
    const p = tripAt(trip, t).root;
    samples.push({ t, v: Math.hypot(p.x - prev.x, p.y - prev.y) / STEP });
    prev = p;
  }
  // gliding along an arrow (a capsule, not a body that walks: §5 沿箭头滑行) has its own limits; the walking and climbing ones hold everywhere else
  const gliding = (t: number) => trip.glides.some((g) => t > g.t0 - STEP && t <= g.t1 + STEP);
  // so has a hop (§5 跳过去): in the air it goes as gravity has it, and the feet leaving and touching down change its speed at once (the push and the catch are the legs')
  const hopping = (t: number) => trip.hops.some((h) => t > h.t0 && t <= h.t1 + STEP);
  const atHop = (t: number) => trip.hops.some((h) => Math.abs(t - h.t0) <= 2 * STEP || Math.abs(t - h.t1) <= 2 * STEP);
  const walked = samples.filter((s) => !gliding(s.t) && !hopping(s.t));
  const glided = samples.filter((s) => gliding(s.t));
  const maxV = Math.max(0, ...walked.map((s) => s.v));
  const glideMaxV = Math.max(0, ...glided.map((s) => s.v));
  const hopMaxV = Math.max(0, ...samples.filter((s) => hopping(s.t)).map((s) => s.v));
  let maxAccel = 0;
  let glideMaxAccel = 0;
  let hopMaxAccel = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = Math.abs(samples[i].v - samples[i - 1].v) / STEP;
    if (hopping(samples[i].t) || hopping(samples[i - 1].t)) {
      if (!atHop(samples[i].t) && !atHop(samples[i - 1].t)) hopMaxAccel = Math.max(hopMaxAccel, a);
    } else if (gliding(samples[i].t) || gliding(samples[i - 1].t)) glideMaxAccel = Math.max(glideMaxAccel, a);
    else maxAccel = Math.max(maxAccel, a);
  }
  const first = samples.findIndex((s) => s.v > 0.04 * maxV);
  const setOff = first < 0 ? trip.t1 - trip.t0 : samples[first].t - trip.t0;
  // a dip: a local minimum under a fifth of the top speed (of the climbing pace, if that is lower: a walk eases to 0.6 of it at a ladder) after the set-off and before the arrival (a leg ends at rest and the next starts from it).
  // A glide starts and ends at rest on purpose (the figure stops at the node's edge and folds into its capsule): those are not dips.
  // So does a hop: it stops to crouch, and stands in the squash of its landing.
  const hopPhases = trip.phases.filter((x) => x.kind === "hop");
  const atGlide = (t: number) => trip.glides.some((g) => Math.abs(t - g.t0) <= 3 * STEP || Math.abs(t - g.t1) <= 3 * STEP) || hopPhases.some((x) => t >= x.t0 - 3 * STEP && t <= x.t1 + 3 * STEP);
  const dips: number[] = [];
  for (let i = Math.max(1, first + 8); i < samples.length - 8; i++) {
    const s = samples[i];
    if (s.v < 0.2 * Math.min(maxV, CLIMB_SPEED) && s.v <= samples[i - 1].v && s.v < samples[i + 1].v && !atGlide(s.t)) dips.push(s.t);
  }
  return { name, samples, maxV, maxAccel, setOff, dips, glideMaxV, glideMaxAccel, glides: trip.glides.length, hopMaxV, hopMaxAccel, hops: trip.hops.length };
}

/** The speed of every trip the sweep walks, and of the doors' ladders. */
export function speeds(): Speed[] {
  const out: Speed[] = [];
  const k = REF_K;
  for (const tr of TRIPS) out.push(speedOf(tr[0], tripOf(tr, k)));
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

// ——— the gait on a ladder (POL3) ———
/** Hands and feet change over (a diagonal pair lets go and reaches for its next rungs) no more often than this many times a second: at 3.2 a pair goes every 312 ms. */
export const SWAP_MAX = 3.2;
/** A foot (or a hand) that is on a rung is within this many figure units of it: not hanging in the air, not through the rung's line. */
export const RUNG_OFF_MAX = 1;
/** On a ladder the hips rise and fall no more than this many figure units against the body, once the slow settling of the pose is taken off (the legs' work must not shake the trunk). */
export const HIP_SHAKE_MAX = 0.6;
export type Gait = {
  name: string;
  /** When (ms) each diagonal pair let go, feet and hands together: the moments a foot came off its rung. */
  swaps: number[];
  /** Changes a second, at each change: 1000 ÷ the time since the one before. */
  rates: { t: number; rate: number }[];
  maxRate: number;
  /** The most a hand or a foot resting on a rung is off it (figure units). */
  offRung: number;
  /** How far the hips move against the body while it climbs (figure units). */
  hipShake: number;
  /** How long the whole trip takes (ms), and how much of it is spent on ladders. */
  ms: number;
  climbMs: number;
};
/** How far world y is from the nearest drawn rung: a trip's ladders' rungs, or a door's (./hatch.ts: the ladder goes on the same way below the floor line, where the body is cut off). */
function offRungAt(y: number, trip: Trip, door: { dir: 1 | -1 } | null): number {
  const k = trip.k;
  if (door) {
    const r = ladderShape(door.dir).rungs.map((v) => v * k);
    const sp = r[0] - r[1];
    return Math.abs((y - r[0]) / sp - Math.round((y - r[0]) / sp)) * (sp / k);
  }
  const rungs = trip.ladders.flatMap((l) => l.rungs);
  return rungs.length ? Math.min(...rungs.map((v) => Math.abs(v - y))) / k : 0;
}
/** How far a series wobbles: the range of what is left of it once its slow drift (a mean over ±HIP_DRIFT frames: the pose settling into the climb) is taken off. */
const HIP_DRIFT = 10;
function shake(v: readonly number[]): number {
  const res = v.map((x, i) => {
    const w = v.slice(Math.max(0, i - HIP_DRIFT), i + HIP_DRIFT + 1);
    return x - w.reduce((a, b) => a + b, 0) / w.length;
  });
  return res.length ? Math.max(...res) - Math.min(...res) : 0;
}
/** How a trip climbs: when the pairs change over, how far the hands and feet on rungs are off the drawn rungs, how much the hips shake — sampled every 4 ms (the hands and feet) and every 16 ms (the hips). */
export function gaitOf(name: string, trip: Trip, door: { dir: 1 | -1 } | null = null): Gait {
  const k = trip.k;
  const swaps: number[] = [];
  let offRung = 0;
  let prev: ReturnType<typeof tripAt> | null = null;
  for (let t = trip.t0; t <= trip.t1; t += 4) {
    const p = tripAt(trip, t);
    if (p.climb >= 0.999 && p.hands) {
      if (prev && prev.climb >= 0.999 && p.feet.some((f, i) => f.lift > 0 && !(prev!.feet[i].lift > 0))) swaps.push(t);
      for (const f of [...p.feet, ...p.hands]) {
        if (f.lift > 0) continue;
        offRung = Math.max(offRung, offRungAt(f.y, trip, door));
      }
    }
    prev = p;
  }
  // both feet lifting at once (two frames apart) is one change
  const once = swaps.filter((t, i) => i === 0 || t - swaps[i - 1] > 40);
  const rates = once.slice(1).map((t, i) => ({ t, rate: 1000 / (t - once[i]) }));
  const py: number[][] = []; // one series to each stretch on a ladder
  const sp = makeSprings();
  sp.seed = 0; // breathing at the same beat every run
  let first = true;
  let lastOn = false;
  for (let t = trip.t0 - 200; t <= trip.t1 + 200; t += STEP) {
    const j = solve(base({ t, wall: t, dt: first ? undefined : STEP / 1000, reset: first, pose: "idle", since: 0, dock: trip.a, trip, k }), sp);
    first = false;
    if (t >= trip.t0 && t < trip.t1 && j.climb >= 0.999) {
      if (!lastOn) py.push([]);
      py[py.length - 1].push(j.py);
    }
    lastOn = t >= trip.t0 && t < trip.t1 && j.climb >= 0.999;
  }
  return { name, swaps: once, rates, maxRate: Math.max(0, ...rates.map((r) => r.rate)), offRung, hipShake: Math.max(0, ...py.map(shake)), ms: trip.t1 - trip.t0, climbMs: trip.phases.filter((x) => x.kind === "climb").reduce((n, x) => n + x.t1 - x.t0, 0) };
}

/** The gait of every ladder the sweep climbs: the trips with one and the doors' (both ways, both sizes). */
export function gaits(): Gait[] {
  const out: Gait[] = [];
  const k = REF_K;
  for (const tr of TRIPS) {
    const trip = tripOf(tr, k);
    if (rungGrid(trip).length) out.push(gaitOf(tr[0], trip));
  }
  for (const size of [1, 0.8]) {
    for (const [name, dir, leaving] of [["door down, going in", 1, true], ["door down, coming out", 1, false], ["door up, going in", -1, true], ["door up, coming out", -1, false]] as const) out.push(gaitOf(`${name}, k ${(k * size).toFixed(2)}`, planDoor(k * size, dir, leaving, 1), { dir }));
  }
  return out;
}
