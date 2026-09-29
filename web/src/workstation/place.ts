// Where a worker is and what it does at time t — a pure function of its run and t, so scrubbing
// to a moment and playing up to it agree exactly (web/docs/workstation.md §回放).
//
//   - A top-level worker appears when its work starts, at the first node it will work on in that
//     stretch, and walks to the node of each file it reads or writes (moves start as the call
//     starts) — except a short read (a glance: under GLANCE_MS with the reads right after it at that
//     node, no write or command there), which it looks over at from where it stands. After a minute
//     with nothing going on it leaves the canvas (fades out); when work starts again it reappears
//     where that work is. So it never stands at a stale place.
//   - A turn that works on a canvas comment (its segments carry it: lanes.ts `commentOf`) is done at
//     the comment: what it does without a file, it does at the node the comment is on (`ctx.anchor`);
//     its files still take it to their nodes. When the turn ends its answer goes to the thread.
//   - Doors (`ctx.door`, §评论联动与进出子图): a file in a node's sub-diagram takes the worker to that
//     node and in — it shrinks and fades at the node's top edge over DOOR_MS and is not on this canvas
//     while it works in there — and back out the same way before it walks on. On a child canvas the
//     files not on it lie behind its entrance. Before its first file a worker is where that file is.
//   - A sub-agent appears at its dispatcher's spot when dispatched, walks to its own files, and
//     when it reports back walks to the dispatcher, hands over (or goes in, when the dispatcher is
//     behind a door), and fades out. A receipts-only worker never moves.
// Places are node element ids or OUTSIDE (the 图外 tray next to the diagram).
import { REF_K } from "./docks";
import { planTrip, SUB_SCALE, tripAt, type Foot, type Move, type Pose, type Pt, type Trip } from "./rig";
import type { Leg, Route } from "./route";
import { receiptAt, type WorkRun, type ReceiptState, type RunSeg } from "./runs/types";

export const OUTSIDE = "\u0000outside";
/** Idle this long and the worker leaves the canvas. */
export const IDLE_LEAVE_MS = 60_000;
export const HANDOFF_MS = 1100;
/** Work that starts while the worker is still walking to the last place waits for it to get there — unless it
 * would arrive more than this after the new work started: then the worker drops that stop and walks to the
 * new place from where it is. Held back more than BOOST_AFTER_MS (or catching up) it walks BOOST× as fast. */
export const CATCH_UP_MS = 1500;
export const BOOST_AFTER_MS = 1000;
export const BOOST = 1.5;
export const FADE_MS = 800;
/** A worker fades in when it appears (never pops in). */
export const APPEAR_MS = 320;
/** A read shorter than this (with the reads right after it at the same node), with no write or command
 * there, is a glance: the worker looks over from where it stands instead of walking there. */
export const GLANCE_MS = 2500;
/** Going through a door takes this long: the figure shrinks to DOOR_SCALE and fades out at the node's
 * top edge (coming out, the reverse). */
export const DOOR_MS = 400;
export const DOOR_SCALE = 0.5;
/** A comment's turn has ended — its answer went to the thread — for this long: the pin's check, a nod. */
export const ANSWER_MS = 1000;

/** A path outside the project: absolute (`/…`, or a Windows drive `C:\` / `C:/`). The server turns every file
 * of the repository, other worktrees included, into a relative path; what is still absolute lies elsewhere
 * (an agent's scratchpad, /tmp, ~/.claude). Such work happens where the worker stands, like thinking. */
export const outsideProject = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

export type Located = { place: string; portal?: { canvasId: string; label: string } };
/** Where a worker stands: its place and its feet (world coordinates). */
export type Spot = { place: string; at: Pt };
/** A project-relative file → the node it belongs to on this canvas (null = outside the diagram). */
export type Locate = (path: string) => Located | null;

export type Ctx = {
  locate: Locate;
  /** The dock (feet position, world coordinates) at a place. */
  dock: (place: string) => Pt;
  /** The way from one spot to another on this canvas (./route.ts on its walk map); without it, straight across and up or down. */
  route?: (from: Spot, to: Spot) => Route;
  /** Where a canvas comment pinned to these elements is worked on (./scenePlaces.ts `anchorPlace`); null
   * when they are not on this canvas. Without it a comment's turn has no place of its own. */
  anchor?: (ids: readonly string[]) => Located | null;
  /** Doors (./scenePlaces.ts `scenePlaces`): with it a worker goes into a node's sub-diagram and is not
   * on this canvas while it works in there; on a child canvas `entrance` is the node it comes in by, and
   * files not on it lie behind that. Without it the worker stands on the node (its bubble names the
   * sub-diagram) and files off the canvas go to the 图外 tray. */
  door?: {
    entrance?: string;
    /** On a child canvas: when the worker is through the door on the canvas outside (its `doorsIn` + DOOR_MS) for the
     * work starting at t0, seen at t; Infinity while it is not yet. It comes in by the entrance only then. */
    enter?: (run: WorkRun, t0: number, t: number) => number;
    /** On the canvas outside: when the worker is through the door at the entrance of child canvas `canvasId` (its way
     * there walked) for the work starting at t0, seen at t; Infinity while it is not yet. It comes out only then. */
    leave?: (run: WorkRun, canvasId: string | undefined, t0: number, t: number) => number;
  };
  reduced: boolean;
  /** The dispatcher of a sub-agent, to find where it was and where to hand back. */
  run: (id: string) => WorkRun | undefined;
};

/** A comment's turn on a run's timeline: its first segment's start to its last one's end. `open`: the
 * turn is still going (not answered yet). */
export type CommentSpan = { n: number; anchor: string[]; turn?: number; start: number; end: number; open: boolean };

export type RunState = {
  present: boolean;
  /** 1 = fully there; fades to 0 while leaving (or going through a door). */
  fade: number;
  at: string;
  from: string;
  /** The trip in progress or the last one, when walking is on. */
  trip: Trip | null;
  /** 0 → 1 along the current trip; 1 once arrived. */
  w: number;
  /** Reading a node it stays away from (a short read): it looks over there from where it stands. */
  glance?: { place: string };
  seg: RunSeg | null;
  pose: Pose;
  /** ms into the current segment. */
  since: number;
  receipt: ReceiptState | null;
  /** The file it works on lies in a child canvas of `at` (it stands at the parent node, or is in there). */
  portal?: Located["portal"];
  /** When it starts going through each door into a node's sub-diagram (ms): its walk to the door is over then. */
  doorsIn: number[];
  /** Going through a door at `at` (ctx.door): `in` — shrinking and fading into it; `behind` — in there,
   * not on this canvas (present false); `out` — coming back out. */
  portalPhase?: "in" | "behind" | "out";
  /** Its scale while it goes through a door (DOOR_SCALE … 1), about its feet; its opacity is in `fade`. */
  portalScale?: number;
  /** The canvas comment it is working on (its turn began with it). */
  comment?: CommentSpan;
  /** It answered a comment (the turn ended) less than ANSWER_MS ago. */
  answered?: CommentSpan;
  handoff: boolean;
  moves: Move[];
};

/** Where a segment's work happens: a place, and whether that lies behind the place's door. */
type Here = Located & { behind?: boolean };
/** Through the door at the place it is at: in (then behind it), or out. */
type Door = { t: number; into: boolean };
/** A walk so far: where it is (behind that place's door or not), whether it started behind one, when it
 * last went in, what it glances at, its moves and the doors it went through, in time order. */
type Walk = { at: string; portal?: Located["portal"]; behind: boolean; startBehind: boolean; inAt: number; glance?: { place: string }; moves: Move[]; doors: Door[] };

/** Where a segment's work happens on this canvas: its file's node (with doors, a file in a node's
 * sub-diagram lies behind that node's door and, on a child canvas, one not on it behind the entrance;
 * without, the 图外 tray); in a comment's turn, without a file, the comment's node; else null — wherever
 * the worker already is. */
function where(ctx: Ctx, s: RunSeg): Here | null {
  let l: Located | null;
  if (s.path && outsideProject(s.path)) return null;
  if (s.path) l = ctx.locate(s.path);
  else if (s.comment?.anchor.length && ctx.anchor) l = ctx.anchor(s.comment.anchor);
  else return null;
  if (l) return ctx.door && l.portal ? { ...l, behind: true } : l;
  if (ctx.door?.entrance) return { place: ctx.door.entrance, behind: true };
  return s.path ? { place: OUTSIDE } : null;
}

/** Whether segs[i], at `place`, is a glance: it and the segments right after it at that place are all
 * reads, together shorter than GLANCE_MS. (A later write or command there, or a longer read, walks.) */
function glanced(ctx: Ctx, segs: readonly RunSeg[], i: number, place: string): boolean {
  let j = i;
  while (j + 1 < segs.length && where(ctx, segs[j + 1])?.place === place) j++;
  return segs.slice(i, j + 1).every((g) => g.kind === "read") && segs[j].end - segs[i].start < GLANCE_MS;
}

const through = (s: Walk, t: number, into: boolean) => {
  s.doors.push({ t, into });
  s.behind = into;
  if (into) s.inAt = t;
};

/**
 * Take the walk to `w` at t0, as of t: out of the door it is behind, over to the place (as a move), and
 * in at the other end when `w` lies behind a door. A walk that would only start after t (it is still
 * coming out, or still walking to the last place) is not taken yet: it waits for that. `ret`: a sub-agent's walk back to hand over (a
 * move even to the same place, as the handover needs one).
 */
function step(ctx: Ctx, s: Walk, w: Here, t0: number, t: number, o: { run?: WorkRun; sub?: boolean; ret?: boolean; next?: number } = {}): "moved" | "waiting" | "stayed" {
  // still on its way to a door when it has to go elsewhere: it never went in
  if (s.behind && t0 < s.inAt) {
    s.doors.pop();
    s.behind = false;
  }
  const behind = !!w.behind;
  let r: "moved" | "waiting" | "stayed" = "stayed";
  if (w.place === s.at && (!o.ret || (behind && s.behind))) {
    if (behind !== s.behind) through(s, t0, behind);
  } else {
    let t1 = t0;
    if (s.behind) {
      // coming out: what it works on now is not in there. Not before the canvas on the other side of the door has it
      // there (it walked to the door or to the entrance first): the two canvases show the same moment
      const d = ctx.door;
      const tOut = o.run && d ? Math.max(t0, (s.portal ? d.leave?.(o.run, s.portal.canvasId, t0, t) : d.enter?.(o.run, t0, t)) ?? t0) : t0;
      if (tOut > t) return "waiting";
      through(s, tOut, false);
      s.portal = undefined;
      t1 = tOut + DOOR_MS;
    }
    // still walking to the last place: it arrives first, then sets off (never cut short, never a jump) — unless that
    // would leave it CATCH_UP_MS behind: then it drops that stop and heads for this place from where it is
    const last = s.moves[s.moves.length - 1];
    let take: Pick<Move, "from" | "resume" | "boost"> = { from: s.at };
    if (last && !ctx.reduced) {
      const lp = planFor(last, ctx);
      if (lp.t1 - t1 > CATCH_UP_MS) {
        const now = tripAt(lp, t1);
        const near = (p: string) => Math.hypot(ctx.dock(p).x - now.root.x, ctx.dock(p).y - now.root.y);
        take = { from: near(last.from) <= near(last.to) ? last.from : last.to, resume: { at: now.root, feet: now.feet.map((f) => ({ x: f.x, y: now.root.y, lift: 0 })) as [Foot, Foot] }, boost: BOOST };
      } else t1 = Math.max(t1, lp.t1);
      if (!take.boost && t1 - t0 > BOOST_AFTER_MS) take.boost = BOOST;
    }
    // a stop it would only set off for after newer work has begun is dropped: it never went (`next`: when that work began)
    if (o.next != null && !take.resume && t1 > o.next) return "waiting";
    if (t1 > t) return "waiting";
    const m: Move = { ...take, to: w.place, t: t1, slot: 0, ...(o.ret ? { ret: true } : {}), ...(o.sub ? { sub: true } : {}) };
    s.moves.push(m);
    if (behind) through(s, ctx.reduced ? t1 : planFor(m, ctx).t1, true);
    r = "moved";
  }
  s.at = w.place;
  s.portal = w.portal;
  return r;
}

/** From `from`, along a run's segments up to t: the moves to each new place (not for a glance), the doors
 * it goes through, where it is, and what it glances at, if anything, at t. */
function follow(ctx: Ctx, run: WorkRun, segs: readonly RunSeg[], t: number, from: Here, sub: boolean): Walk {
  const s: Walk = { at: from.place, portal: from.portal, behind: !!from.behind, startBehind: !!from.behind, inAt: -Infinity, moves: [], doors: [] };
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    if (g.start > t) break;
    const w = where(ctx, g);
    if (!w) continue;
    if (w.place !== s.at && glanced(ctx, segs, i, w.place)) {
      if (t < g.end && !s.behind) s.glance = { place: w.place };
      continue;
    }
    // the next work that moves it, if it has begun by t
    let next: number | undefined;
    for (let j = i + 1; j < segs.length && segs[j].start <= t; j++) {
      const v = where(ctx, segs[j]);
      if (v && v.place !== w.place && !glanced(ctx, segs, j, v.place)) {
        next = segs[j].start;
        break;
      }
    }
    step(ctx, s, w, g.start, t, { run, sub, next });
  }
  return s;
}

/** Where a worker's state puts it as a place to go to: behind the door while it goes in or is in there. */
const hereOf = (st: RunState): Here => (st.portalPhase === "in" || st.portalPhase === "behind" ? { place: st.at, behind: true } : { place: st.at });

const FRONT = { fade: 1, scale: 1 } as const;
const BEHIND = { phase: "behind", fade: 0, scale: DOOR_SCALE } as const;
const smooth = (u: number) => u * u * (3 - 2 * u);
/** The door at t: going in, in there, or coming out, and how visible and how big it is meanwhile (with
 * reduced motion it only fades). */
function doorAt(s: Walk, t: number, still: boolean): { phase?: "in" | "behind" | "out"; fade: number; scale: number } {
  let last: Door | undefined;
  for (const d of s.doors) if (d.t <= t) last = d;
  if (!last) return s.startBehind ? BEHIND : FRONT;
  const u = (t - last.t) / DOOR_MS;
  if (u >= 1) return last.into ? BEHIND : FRONT;
  const k = still ? 0 : smooth(u);
  return last.into ? { phase: "in", fade: 1 - u, scale: still ? 1 : 1 - (1 - DOOR_SCALE) * k } : { phase: "out", fade: u, scale: still ? 1 : DOOR_SCALE + (1 - DOOR_SCALE) * k };
}

/** Work stretches: segments split where nothing happened for longer than IDLE_LEAVE_MS. */
export function bursts(segs: readonly RunSeg[]): RunSeg[][] {
  const out: RunSeg[][] = [];
  let end = -Infinity;
  for (const s of segs) {
    if (!out.length || s.start - end > IDLE_LEAVE_MS) out.push([]);
    out[out.length - 1].push(s);
    end = Math.max(end, s.end);
  }
  return out;
}

const spans = new WeakMap<WorkRun, CommentSpan[]>();
/** A run's comment turns in order: the consecutive segments of one turn that carry the same comment. */
export function commentSpans(run: WorkRun): CommentSpan[] {
  let out = spans.get(run);
  if (out) return out;
  out = [];
  let cur: CommentSpan | undefined;
  for (const g of run.segs) {
    const c = g.comment;
    if (!c) {
      cur = undefined;
      continue;
    }
    if (cur && cur.n === c.n && cur.turn === g.turn) {
      cur.end = Math.max(cur.end, g.end);
      if (c.open) cur.open = true;
    } else out.push((cur = { n: c.n, anchor: c.anchor, ...(g.turn != null ? { turn: g.turn } : {}), start: g.start, end: g.end, open: !!c.open }));
  }
  spans.set(run, out);
  return out;
}

const cache = new WeakMap<Ctx, WeakMap<WorkRun, Map<number, RunState>>>();

/** Pure: the run's state at t (memoised per context, run object and t). */
export function stateAt(run: WorkRun, t: number, ctx: Ctx): RunState {
  let byRun = cache.get(ctx);
  if (!byRun) cache.set(ctx, (byRun = new WeakMap()));
  let m = byRun.get(run);
  const hit = m?.get(t);
  if (hit) return hit;
  const s = compute(run, t, ctx);
  if (!m || m.size >= 64) byRun.set(run, (m = new Map()));
  m.set(t, s);
  return s;
}

function compute(run: WorkRun, t: number, ctx: Ctx): RunState {
  const walkOn = !ctx.reduced;
  const parent = run.parentId ? ctx.run(run.parentId) : undefined;
  const receipt = receiptAt(run, t);
  const seg = run.segs.find((g) => g.start <= t && t < g.end) ?? null;
  let walk: Walk;
  let present = true;
  let fade = 1;
  let handoff = false;

  if (parent) {
    // A sub-agent starts where its dispatcher was when it sent it (in its sub-diagram, if it was in one).
    walk = follow(ctx, run, run.segs, t, run.spawnAt != null ? hereOf(stateAt(parent, run.spawnAt, ctx)) : { place: OUTSIDE }, true);
    if (run.spawnAt == null || t < run.spawnAt) present = false;
    else fade = Math.min(1, (t - run.spawnAt) / APPEAR_MS);
    if (run.doneAt != null && t >= run.doneAt) {
      let arrive = run.doneAt;
      let inside = false;
      if (!run.coarse) {
        // back to the dispatcher to hand over — into its sub-diagram, out of sight, if it is in one
        const to = hereOf(stateAt(parent, run.doneAt, ctx));
        const r = step(ctx, walk, to, run.doneAt, t, { run, sub: true, ret: true });
        const m = walk.moves[walk.moves.length - 1];
        arrive = r === "waiting" ? Infinity : r === "moved" ? (walkOn ? planFor(m, ctx).t1 : m.t) : run.doneAt;
        inside = !!to.behind;
        walk.portal = undefined;
      }
      const end = run.coarse ? run.doneAt : arrive + (inside ? DOOR_MS : HANDOFF_MS);
      if (!run.coarse && !inside && t >= arrive && t < end) handoff = true;
      if (t >= end) fade = Math.min(fade, Math.max(0, 1 - (t - end) / FADE_MS));
      if (fade <= 0) present = false;
    }
  } else {
    // A top-level worker: the stretch of work t is in (or the last one before it).
    const bs = bursts(run.segs);
    let bi = -1;
    for (let i = 0; i < bs.length; i++) if (bs[i][0].start <= t) bi = i;
    if (bi < 0) {
      present = false;
      walk = follow(ctx, run, [], t, { place: OUTSIDE }, false);
    } else {
      const b = bs[bi];
      // It appears where this stretch's work first lands (else where the last one ended).
      const first = b.map((g) => where(ctx, g)).find(Boolean);
      const prev = bi > 0 ? [...bs[bi - 1]].reverse().map((g) => where(ctx, g)).find(Boolean) : null;
      walk = follow(ctx, run, b, t, first ?? prev ?? { place: OUTSIDE }, false);
      const lastEnd = Math.max(...b.filter((g) => g.start <= t).map((g) => g.end));
      const idle = t - lastEnd;
      fade = Math.min(1, (t - b[0].start) / APPEAR_MS);
      if (idle > IDLE_LEAVE_MS) {
        fade = Math.min(fade, Math.max(0, 1 - (idle - IDLE_LEAVE_MS) / FADE_MS));
        if (fade <= 0) present = false;
      }
    }
  }

  // Through a door: its opacity joins the fade; behind one it is not on this canvas.
  const door = doorAt(walk, t, ctx.reduced);
  fade *= door.fade;
  if (door.phase === "behind") present = false;
  const moves = walk.moves;
  let trip: Trip | null = null;
  let w = 1;
  if (walkOn && moves.length) {
    trip = planFor(moves[moves.length - 1], ctx);
    w = t >= trip.t1 ? 1 : Math.min(0.999, Math.max(0, (t - trip.t0) / (trip.t1 - trip.t0)));
  }
  let pose: Pose = w < 1 ? "walk" : seg ? seg.kind : "idle";
  if (handoff) pose = "handoff";
  else if (parent && pose === "idle" && (run.doneAt == null || t < run.doneAt)) pose = run.coarse ? "unknown" : "think";
  const cs = commentSpans(run);
  const comment = cs.find((c) => c.start <= t && t < c.end);
  const answered = cs.find((c) => !c.open && c.end <= t && t < c.end + ANSWER_MS);
  return {
    present,
    fade,
    at: walk.at,
    from: moves.length ? moves[moves.length - 1].from : walk.at,
    trip,
    w,
    ...(walk.glance && w >= 1 ? { glance: walk.glance } : {}),
    seg,
    pose,
    since: seg ? t - seg.start : 0,
    receipt,
    ...(walk.portal ? { portal: walk.portal } : {}),
    doorsIn: walk.doors.filter((d) => d.into).map((d) => d.t),
    ...(door.phase ? { portalPhase: door.phase } : {}),
    ...(door.phase !== "behind" && door.scale !== 1 ? { portalScale: door.scale } : {}),
    ...(comment ? { comment } : {}),
    ...(answered ? { answered } : {}),
    handoff,
    moves,
  };
}

const trips = new WeakMap<object, Map<string, Trip>>();
const STRAIGHT = {};
/** The trip of a move between two docks, along the canvas's walk map (memoised per map: docks move
 * when the diagram does). Planned for the figure's size at the reference view (a sub-agent's is smaller). */
export function planFor(m: Move, ctx: Pick<Ctx, "dock" | "route">): Trip {
  const a = m.resume?.at ?? ctx.dock(m.from);
  const b = ctx.dock(m.to);
  let byMove = trips.get(ctx.route ?? STRAIGHT);
  if (!byMove) trips.set(ctx.route ?? STRAIGHT, (byMove = new Map()));
  const key = `${m.t}|${m.sub ? 1 : 0}|${m.from}|${m.to}|${a.x},${a.y}|${b.x},${b.y}|${m.boost ?? 1}`;
  let p = byMove.get(key);
  if (!p) {
    if (byMove.size > 4000) byMove.clear();
    const rt = ctx.route ? ctx.route({ place: m.from, at: a }, { place: m.to, at: b }) : straight(a, b);
    byMove.set(key, (p = planTrip(m, rt, a, REF_K * (m.sub ? SUB_SCALE : 1))));
  }
  return p;
}

/** Without a walk map: across at the start's height, then up or down. */
function straight(a: Pt, b: Pt): Route {
  const legs: Leg[] = [];
  if (a.x !== b.x) legs.push({ kind: "walk", a, b: { x: b.x, y: a.y }, temp: false });
  if (a.y !== b.y) legs.push({ kind: "climb", a: { x: b.x, y: a.y }, b, temp: false });
  return { legs, len: Math.abs(b.x - a.x) + Math.abs(b.y - a.y) };
}

export type WriteConflict = { path: string; start: number; end: number; runs: [string, string] };
/** Two runs (sub-agents included) writing the same file at overlapping times. Pure; computed on data changes. */
export function writeConflicts(runs: readonly WorkRun[]): WriteConflict[] {
  // grouped by file first: only writes to the same path can clash (near-linear with many agents)
  const byPath = new Map<string, { r: string; g: RunSeg }[]>();
  for (const r of runs) for (const g of r.segs) if (g.kind === "write" && g.path) byPath.set(g.path, [...(byPath.get(g.path) ?? []), { r: r.id, g }]);
  const out: WriteConflict[] = [];
  for (const writes of byPath.values())
    for (let i = 0; i < writes.length; i++)
      for (let j = i + 1; j < writes.length; j++) {
        const a = writes[i];
        const b = writes[j];
        if (a.r !== b.r && a.g.start < b.g.end && b.g.start < a.g.end) out.push({ path: a.g.path!, start: Math.max(a.g.start, b.g.start), end: Math.min(a.g.end, b.g.end), runs: [a.r, b.r] });
      }
  return out.sort((x, y) => x.start - y.start);
}
export const conflictAt = (list: readonly WriteConflict[], runId: string, t: number) => list.find((c) => c.start <= t && t < c.end && c.runs.includes(runId)) ?? null;

// The two canvases either side of a door show the same moment (the worker is through the door on one when it
// comes out on the other). Each asks the other for its door times — the outside for `enter`, the inside for
// `leave` — from a context without those two functions, so they never ask each other in circles.
const bare = new WeakMap<Ctx, Ctx>();
const untimed = (c: Ctx): Ctx => {
  let b = bare.get(c);
  if (!b) bare.set(c, (b = { ...c, door: c.door && { entrance: c.door.entrance } }));
  return b;
};
const throughAt = (times: readonly number[], t0: number) => {
  const d = times.find((x) => x >= t0 - 1);
  return d == null ? Infinity : d + DOOR_MS;
};
/** `door.enter` for a child canvas: `outer` is the canvas outside its door (undefined: no delay). */
export const enterAfter =
  (outer: () => Ctx | undefined): NonNullable<Ctx["door"]>["enter"] =>
  (run, t0, t) => {
    const c = outer();
    return c ? throughAt(stateAt(run, t, c).doorsIn, t0) : t0;
  };
/** `door.leave` for the canvas outside a child's door: `child` gives a child canvas's context by its id. */
export const leaveAfter =
  (child: (canvasId: string) => Ctx | undefined): NonNullable<Ctx["door"]>["leave"] =>
  (run, canvasId, t0, t) => {
    const c = canvasId ? child(canvasId) : undefined;
    return c ? throughAt(stateAt(run, t, untimed(c)).doorsIn, t0) : t0;
  };

/** Each canvas's current context and place names, published by its overlay for the timeline
 * (walk bars, 「在 API 服务」 rows, the detail card) — read at ≤ 4 Hz, never per frame. */
/** `empty`: the canvas has nothing drawn on it (its 「一张空白画布」 guide shows): the overlay draws no one, the strip says so. */
export const canvasWhere = new Map<string, { ctx: Ctx; label: (place: string) => string; empty?: boolean }>();

const contextOf = (id: string) => canvasWhere.get(id)?.ctx ?? canvasWhere.get(`follow:${id}`)?.ctx;
/** The door timing of the canvas `canvasId` (a child canvas when `parents` has it), from the canvases the overlays have published:
 * `enter` from the nearest published canvas outside it, `leave` from a child canvas by its id. */
export function doorTiming(canvasId: string, parents: ReadonlyMap<string, { canvasId: string }>): Pick<NonNullable<Ctx["door"]>, "enter" | "leave"> {
  const outer = () => {
    let p = parents.get(canvasId)?.canvasId;
    for (let n = 0; p && n < 16; n++, p = parents.get(p)?.canvasId) {
      const c = contextOf(p);
      if (c) return c;
    }
    return undefined;
  };
  return { ...(parents.has(canvasId) ? { enter: enterAfter(outer) } : {}), leave: leaveAfter(contextOf) };
}
