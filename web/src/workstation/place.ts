// Where a worker is and what it does at time t — a pure function of its run and t, so scrubbing
// to a moment and playing up to it agree exactly (web/docs/workstation.md §回放).
//
//   - A top-level worker appears when its work starts: where that work is when its first call has a
//     place, else where it stood (the tray the first time, where the last stretch ended after that) —
//     never by a call that has not started yet, which a live session does not have. It walks to the node
//     of each file it reads or writes (moves start as the call starts) — except a short read (a glance:
//     under GLANCE_MS with the reads right after it at that node, no write or command there), which it
//     looks over at from where it stands — or, over CUT_DISTANCE, is cut across (`RunState.cut`, drawn by
//     ./director.ts: fading out where it was as it fades in where it goes). After a minute with nothing
//     going on it leaves the canvas (fades out) — not while its turn is still running.
//   - A turn that works on a canvas comment (its segments carry it: lanes.ts `commentOf`) is done at
//     the comment: what it does without a file, it does at the node the comment is on (`ctx.anchor`);
//     its files still take it to their nodes. When the turn ends its answer goes to the thread.
//   - Doors (`ctx.door`, §评论联动与进出子图): a file in a node's sub-diagram takes the worker to that
//     node and in — down a ladder from the node's top edge over DOOR_MS, the body cut off by that line — and is
//     not on this canvas while it works in there — and back up it before it walks on. On a child canvas the
//     files not on it lie behind its entrance: it comes in down a ladder from above the entrance and leaves up
//     it. Before its first file a worker is where that file is.
//   - A sub-agent appears at its dispatcher's spot when dispatched, walks to its own files, and
//     when it reports back walks to the dispatcher, hands over (or goes in, when the dispatcher is
//     behind a door), and fades out. A receipts-only worker never moves.
// Places are node element ids or OUTSIDE (the 图外 tray next to the diagram).
import { REF_K } from "./docks";
import { DOOR_MS, planTrip, SUB_SCALE, tripAt, type Foot, type Move, type Pose, type Pt, type Trip } from "./rig";
import type { Leg, Route } from "./route";
import { isNodePath } from "./runs/nodePath";
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
/** Going through a door — down (or up) its ladder, all the way out of sight, or back — takes this long (./rig.ts `planDoor`). */
export { DOOR_MS };
/** A comment's turn has ended — its answer went to the thread — for this long: the pin's check, a nod. */
export const ANSWER_MS = 1000;
/** A call seen this long after it began (or more) is history — a page that opened with the log already there: it starts when it began. */
export const SEEN_LAG_MAX_MS = 5000;
/** When a segment's work starts as far as this page is concerned: when it began, or, for a live call that reached the page late, when it did. */
export const startOf = (s: RunSeg): number => (s.seen != null && s.seen > s.start && s.seen - s.start < SEEN_LAG_MAX_MS ? s.seen : s.start);

/** A stretch of work that starts more than this many world units from where it is is not walked to: the worker is cut across — it fades out where it was as it fades in
 * where it goes, over CUT_MS (web/docs/workstation.md §导演层). Never a jump, never a long walk that takes the person's eye across the diagram. */
export const CUT_DISTANCE = 650;
export const CUT_MS = 300;

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
  /** Top-level workers that stay standing where they finished instead of leaving after a minute idle: the traced one, while its route shows. */
  stay?: ReadonlySet<string>;
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
  /** The last move is a cut (over CUT_DISTANCE): from the time it set off (`t`) for CUT_MS the worker is at `to` (this state's `at`) fading in while it
   * fades out at `from` (./director.ts draws both); no trip is walked. */
  cut?: { t: number; from: string; to: string };
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
  /** Every door it goes through, in time order (those still to come after a walk to them included). */
  doors: DoorRec[];
  /** Going through a door at `at` (ctx.door): `in` — down (or up) the ladder, out of sight; `behind` — in there,
   * not on this canvas (present false); `out` — coming back the way it went. */
  portalPhase?: "in" | "behind" | "out";
  /** The door's ladder goes `below` the floor (on the canvas the door is in) or `above` it (on the sub-diagram's canvas: it hangs from above the entrance). */
  portalSide?: Side;
  /** ms since the phase began (in, out: of the climb, 0 … DOOR_MS; behind: since it was all the way down, Infinity when it began there). */
  portalT?: number;
  /** Coming `out`: how long it was all the way down before (ms; Infinity when it began there). */
  portalBelow?: number;
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
export type Side = "below" | "above";
/** A door it goes through: when it starts on the ladder, going in (out of this canvas) or out, which way the ladder goes, and at what place. */
export type DoorRec = { t: number; into: boolean; side: Side; at: string };
type Door = DoorRec;
/** The ladder of a door goes up from the entrance of a child canvas (unless it leads into a node's own sub-diagram), else down from a node. */
const sideOf = (ctx: Ctx, portal: Located["portal"]): Side => (ctx.door?.entrance && !portal ? "above" : "below");
/** A walk so far: where it is (behind that place's door or not), whether it started behind one, when it
 * last went in, what it glances at, its moves and the doors it went through, in time order. */
type Walk = { /** It started this stretch at a place that is not where its work is (the tray, where the last stretch ended): its first move is a cut when far. */ appear?: boolean; at: string; portal?: Located["portal"]; behind: boolean; startBehind: boolean; startSide: Side; inAt: number; glance?: { place: string }; moves: Move[]; doors: Door[] };

/** Where a segment's work is on this canvas (its file's node, the tray, a comment's node), or null: wherever the worker already is. */
export const placeOfSeg = (ctx: Ctx, s: RunSeg): string | null => where(ctx, s)?.place ?? null;

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
  // a file no node has is at the tray; a node the page does not have (any more) is nowhere: the worker stays where it is
  return s.path && !isNodePath(s.path) ? { place: OUTSIDE } : null;
}

/** Whether segs[i], at `place`, is a glance: one read of a real, short length (under GLANCE_MS) and nothing else right after it at that
 * place. A read whose length was padded (`durationKnown: false`), several reads in a row there, a write or a command there, or a longer read
 * is work at that node: the worker walks over. */
function glanced(ctx: Ctx, segs: readonly RunSeg[], i: number, place: string): boolean {
  let j = i;
  while (j + 1 < segs.length && where(ctx, segs[j + 1])?.place === place) j++;
  return j === i && segs[i].kind === "read" && segs[i].durationKnown !== false && segs[i].end - segs[i].start < GLANCE_MS;
}

/** When the worker behind a door may come out for work starting at t0, seen at t: not before the canvas on the other side of the door has it there (Infinity while it does not yet). */
const outAfter = (ctx: Ctx, s: Walk, run: WorkRun | undefined, t0: number, t: number) => {
  const d = ctx.door;
  return run && d ? Math.max(t0, (s.portal ? d.leave?.(run, s.portal.canvasId, t0, t) : d.enter?.(run, t0, t)) ?? t0) : t0;
};

const through = (ctx: Ctx, s: Walk, t: number, into: boolean, place: string, portal: Located["portal"]) => {
  s.doors.push({ t, into, side: sideOf(ctx, portal), at: place });
  s.behind = into;
  if (into) s.inAt = t;
};

/** The moves that are cuts rather than walks. Only the first move of a stretch of work is ever one — a worker that starts (from the tray, or
 * from where the last stretch ended) far from its first work is cut across instead of walking through the diagram; once it is at work it walks
 * from node to node as it always did. Moves are made anew with every `stateAt`, so the set is by object. */
const cutMoves = new WeakSet<Move>();
export const isCut = (m: Move, _ctx?: unknown): boolean => cutMoves.has(m);
/** Whether the move `m` about to be its stretch's first is over CUT_DISTANCE: not a trip taken over from one under way, not a sub-agent's walk back to its dispatcher (the handover needs the walk), and never with reduced motion (which walks nowhere at all). */
const farStart = (m: Move, ctx: Pick<Ctx, "dock" | "reduced">, o: { ret?: boolean }): boolean => {
  if (ctx.reduced || m.resume || o.ret) return false;
  const a = ctx.dock(m.from);
  const b = ctx.dock(m.to);
  return Math.hypot(b.x - a.x, b.y - a.y) > CUT_DISTANCE;
};
/** When a move is over: a cut after CUT_MS, a walk when its trip ends. */
export const arrivalOf = (m: Move, ctx: Pick<Ctx, "dock" | "route" | "reduced">): number => (isCut(m, ctx) ? m.t + CUT_MS : planFor(m, ctx).t1);

/**
 * Take the walk to `w` at t0, as of t: out of the door it is behind, over to the place (as a move), and
 * in at the other end when `w` lies behind a door. A walk that would only start after t (it is still
 * coming out, or still walking to the last place) is not taken yet: it waits for that. `ret`: a sub-agent's walk back to hand over (a
 * move even to the same place, as the handover needs one).
 */
function step(ctx: Ctx, s: Walk, w: Here, t0: number, t: number, o: { run?: WorkRun; sub?: boolean; ret?: boolean; next?: number; cut?: boolean } = {}): "moved" | "waiting" | "stayed" {
  const behind = !!w.behind;
  // still on its way to a door when it has to go elsewhere: it never went in (more work behind the same door does not change that: it goes in when it gets there)
  if (s.behind && t0 < s.inAt && !(behind && w.place === s.at)) {
    s.doors.pop();
    s.behind = false;
  }
  let r: "moved" | "waiting" | "stayed" = "stayed";
  if (w.place === s.at && (!o.ret || (behind && s.behind))) {
    if (behind && !s.behind) through(ctx, s, t0, true, w.place, w.portal);
    else if (!behind && s.behind) {
      // coming out where it stands (the work is at the node it went in by): not before the canvas on the other side of the door has it there
      const tOut = outAfter(ctx, s, o.run, t0, t);
      if (tOut > t) return "waiting";
      through(ctx, s, tOut, false, s.at, s.portal);
      s.portal = undefined;
    }
  } else {
    // it sets off only once it is out of the door it came through (that may have been the work before, at the entrance itself)
    const out = s.doors[s.doors.length - 1];
    let t1 = out && !out.into ? Math.max(t0, out.t + DOOR_MS) : t0;
    if (s.behind) {
      // coming out: what it works on now is not in there. Not before the canvas on the other side of the door has it
      // there (it walked to the door or to the entrance first): the two canvases show the same moment
      const tOut = outAfter(ctx, s, o.run, t0, t);
      if (tOut > t) return "waiting";
      through(ctx, s, tOut, false, s.at, s.portal);
      s.portal = undefined;
      t1 = tOut + DOOR_MS;
    }
    // still walking to the last place: it arrives first, then sets off (never cut short, never a jump) — unless that
    // would leave it CATCH_UP_MS behind: then it drops that stop and heads for this place from where it is
    const last = s.moves[s.moves.length - 1];
    let take: Pick<Move, "from" | "resume" | "boost"> = { from: s.at };
    if (last && !ctx.reduced) {
      const lp = isCut(last, ctx) ? null : planFor(last, ctx);
      const lt1 = lp ? lp.t1 : last.t + CUT_MS;
      if (lp && lt1 - t1 > CATCH_UP_MS) {
        const now = tripAt(lp, t1);
        const near = (p: string) => Math.hypot(ctx.dock(p).x - now.root.x, ctx.dock(p).y - now.root.y);
        take = { from: near(last.from) <= near(last.to) ? last.from : last.to, resume: { at: now.root, feet: now.feet.map((f) => ({ x: f.x, y: now.root.y, lift: 0 })) as [Foot, Foot] }, boost: BOOST };
      } else t1 = Math.max(t1, lt1);
      if (!take.boost && t1 - t0 > BOOST_AFTER_MS) take.boost = BOOST;
    }
    // a stop it would only set off for after newer work has begun is dropped: it never went (`next`: when that work began)
    if (o.next != null && !take.resume && t1 > o.next) return "waiting";
    if (t1 > t) return "waiting";
    const m: Move = { ...take, to: w.place, t: t1, slot: 0, ...(o.ret ? { ret: true } : {}), ...(o.sub ? { sub: true } : {}) };
    // a stretch's first move when far, or a move its call says is a cut (the build replay: `RunSeg.cut`); never with reduced motion
    if (((s.appear && !s.moves.length && farStart(m, ctx, o)) || (o.cut && !ctx.reduced))) cutMoves.add(m);
    s.moves.push(m);
    if (behind) through(ctx, s, ctx.reduced ? t1 : arrivalOf(m, ctx), true, w.place, w.portal);
    r = "moved";
  }
  s.at = w.place;
  s.portal = w.portal;
  return r;
}

/** From `from`, along a run's segments up to t: the moves to each new place (not for a glance), the doors
 * it goes through, where it is, and what it glances at, if anything, at t. */
function follow(ctx: Ctx, run: WorkRun, segs: readonly RunSeg[], t: number, from: Here, sub: boolean, appear = false): Walk {
  const s: Walk = { appear, at: from.place, portal: from.portal, behind: !!from.behind, startBehind: !!from.behind, startSide: sideOf(ctx, from.portal), inAt: -Infinity, moves: [], doors: [] };
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
    step(ctx, s, w, startOf(g), t, { run, sub, next, ...(g.cut ? { cut: true } : {}) });
  }
  return s;
}

/** Where a worker's state puts it as a place to go to: behind the door while it goes in or is in there. */
const hereOf = (st: RunState): Here => (st.portalPhase === "in" || st.portalPhase === "behind" ? { place: st.at, behind: true } : { place: st.at });

type DoorNow = { phase?: "in" | "behind" | "out"; fade: number; side?: Side; t?: number; below?: number };
/** The door at t: going in, in there, or coming out, how far into it, and — with reduced motion, which has no ladder — how visible the figure is meanwhile. */
function doorAt(s: Walk, t: number, still: boolean): DoorNow {
  let i = -1;
  s.doors.forEach((d, n) => d.t <= t && (i = n));
  const last = s.doors[i];
  if (!last) return s.startBehind ? { phase: "behind", fade: 1, side: s.startSide, t: Infinity } : { fade: 1 };
  const ms = t - last.t;
  if (ms >= DOOR_MS) return last.into ? { phase: "behind", fade: 1, side: last.side, t: ms - DOOR_MS } : { fade: 1 };
  const u = ms / DOOR_MS;
  const fade = still ? (last.into ? 1 - u : u) : 1;
  if (last.into) return { phase: "in", fade, side: last.side, t: ms };
  const prev = s.doors[i - 1];
  return { phase: "out", fade, side: last.side, t: ms, below: prev?.into ? Math.max(0, last.t - prev.t - DOOR_MS) : Infinity };
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
        arrive = r === "waiting" ? Infinity : r === "moved" ? (walkOn ? arrivalOf(m, ctx) : m.t) : run.doneAt;
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
      // It appears where its work is when that work starts at once (its first call has a place); otherwise where it stood (the tray the
      // first time, where the last stretch ended after that) and it walks to where the work lands as that work starts. Never by work
      // that has not started at t: in a live session that is not known yet, and a start at "where the first file will be" jumped when
      // the file came.
      const prev = bi > 0 ? [...bs[bi - 1]].reverse().map((g) => where(ctx, g)).find(Boolean) : null;
      // (a child canvas is not where the work is until the worker comes in by the entrance: there the start is behind it)
      const home: Here = ctx.door?.entrance ? { place: ctx.door.entrance, behind: true } : { place: OUTSIDE };
      // (a comment's turn that starts without a file works at the pin, but it does not appear there: it comes from where it stood — the tray — and walks to it)
      const head = b[0].comment && !b[0].path ? null : where(ctx, b[0]);
      walk = follow(ctx, run, b, t, head ?? prev ?? home, false, !head);
      const lastEnd = Math.max(...b.filter((g) => g.start <= t).map((g) => g.end));
      const idle = t - lastEnd;
      fade = Math.min(1, (t - b[0].start) / APPEAR_MS);
      // a turn that is still running does not go home however long it has gone without a call (it is thinking, or waiting on a command)
      const going = run.running && bi === bs.length - 1;
      if (idle > IDLE_LEAVE_MS && !ctx.stay?.has(run.id) && !going) {
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
  let cut: RunState["cut"];
  if (walkOn && moves.length) {
    const lastMove = moves[moves.length - 1];
    if (isCut(lastMove, ctx)) {
      // over CUT_DISTANCE: no walk; the state is at the new place from the moment it sets off, and says it is a cut for CUT_MS
      if (t >= lastMove.t && t < lastMove.t + CUT_MS) cut = { t: lastMove.t, from: lastMove.from, to: lastMove.to };
    } else {
      trip = planFor(lastMove, ctx);
      w = t >= trip.t1 ? 1 : Math.min(0.999, Math.max(0, (t - trip.t0) / (trip.t1 - trip.t0)));
    }
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
    ...(cut ? { cut } : {}),
    ...(walk.glance && w >= 1 ? { glance: walk.glance } : {}),
    seg,
    pose,
    since: seg ? t - seg.start : 0,
    receipt,
    ...(walk.portal ? { portal: walk.portal } : {}),
    doorsIn: walk.doors.filter((d) => d.into).map((d) => d.t),
    doors: walk.doors,
    ...(door.phase ? { portalPhase: door.phase, portalSide: door.side, portalT: door.t } : {}),
    ...(door.below != null ? { portalBelow: door.below } : {}),
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

const contextOf = (id: string) => canvasWhere.get(id)?.ctx;
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
