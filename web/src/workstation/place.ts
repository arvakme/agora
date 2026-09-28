// Where a worker is and what it does at time t — a pure function of its run and t, so scrubbing
// to a moment and playing up to it agree exactly (web/docs/workstation.md §回放).
//
//   - A top-level worker appears when its work starts, at the first node it will work on in that
//     stretch, and walks to the node of each file it reads or writes (moves start as the call
//     starts) — except a short read (a glance: under GLANCE_MS with the reads right after it at that
//     node, no write or command there), which it looks over at from where it stands. After a minute
//     with nothing going on it leaves the canvas (fades out); when work starts again it reappears
//     where that work is. So it never stands at a stale place.
//   - A sub-agent appears at its dispatcher's spot when dispatched, walks to its own files, and
//     when it reports back walks to the dispatcher, hands over, and fades out. A receipts-only
//     worker never moves.
// Places are node element ids or OUTSIDE (the 图外 tray next to the diagram).
import { REF_K } from "./docks";
import { planTrip, SUB_SCALE, type Move, type Pose, type Pt, type Trip } from "./rig";
import type { Leg, Route } from "./route";
import { receiptAt, type WorkRun, type ReceiptState, type RunSeg } from "./runs/types";

export const OUTSIDE = "\u0000outside";
/** Idle this long and the worker leaves the canvas. */
export const IDLE_LEAVE_MS = 60_000;
export const HANDOFF_MS = 1100;
export const FADE_MS = 800;
/** A worker fades in when it appears (never pops in). */
export const APPEAR_MS = 320;
/** A read shorter than this (with the reads right after it at the same node), with no write or command
 * there, is a glance: the worker looks over from where it stands instead of walking there. */
export const GLANCE_MS = 2500;

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
  reduced: boolean;
  /** The dispatcher of a sub-agent, to find where it was and where to hand back. */
  run: (id: string) => WorkRun | undefined;
};

export type RunState = {
  present: boolean;
  /** 1 = fully there; fades to 0 while leaving. */
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
  /** The file it works on lies in a child canvas of `at` (it stands at the parent node). */
  portal?: Located["portal"];
  handoff: boolean;
  moves: Move[];
};

const where = (ctx: Ctx, s: RunSeg): Located | null => (s.path ? (ctx.locate(s.path) ?? { place: OUTSIDE }) : null);

/** Whether segs[i], at `place`, is a glance: it and the segments right after it at that place are all
 * reads, together shorter than GLANCE_MS. (A later write or command there, or a longer read, walks.) */
function glanced(ctx: Ctx, segs: readonly RunSeg[], i: number, place: string): boolean {
  let j = i;
  while (j + 1 < segs.length && where(ctx, segs[j + 1])?.place === place) j++;
  return segs.slice(i, j + 1).every((g) => g.kind === "read") && segs[j].end - segs[i].start < GLANCE_MS;
}

/** From `from`, along a run's segments up to t: the moves to each new place (not for a glance), where it
 * is, and what it glances at, if anything, at t. */
function follow(ctx: Ctx, segs: readonly RunSeg[], t: number, from: Located, sub: boolean) {
  let at = from.place;
  let portal = from.portal;
  let glance: RunState["glance"];
  const moves: Move[] = [];
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    if (g.start > t) break;
    const w = where(ctx, g);
    if (!w) continue;
    if (w.place !== at) {
      if (glanced(ctx, segs, i, w.place)) {
        if (t < g.end) glance = { place: w.place };
        continue;
      }
      moves.push({ from: at, to: w.place, t: g.start, slot: 0, ...(sub ? { sub } : {}) });
    }
    at = w.place;
    portal = w.portal;
  }
  return { at, portal, glance, moves };
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
  let moves: Move[] = [];
  let at: string;
  let portal: Located["portal"];
  let glance: RunState["glance"];
  let present = true;
  let fade = 1;
  let handoff = false;

  if (parent) {
    // A sub-agent starts where its dispatcher was when it sent it.
    ({ at, portal, glance, moves } = follow(ctx, run.segs, t, { place: run.spawnAt != null ? stateAt(parent, run.spawnAt, ctx).at : OUTSIDE }, true));
    if (run.spawnAt == null || t < run.spawnAt) present = false;
    else fade = Math.min(1, (t - run.spawnAt) / APPEAR_MS);
    if (run.doneAt != null && t >= run.doneAt) {
      let arrive = run.doneAt;
      if (!run.coarse) {
        const pAt = stateAt(parent, run.doneAt, ctx).at;
        moves.push({ from: at, to: pAt, t: run.doneAt, slot: 0, ret: true, sub: true });
        if (walkOn) arrive = planFor(moves[moves.length - 1], ctx).t1;
        at = pAt;
        portal = undefined;
      }
      const end = run.coarse ? run.doneAt : arrive + HANDOFF_MS;
      if (!run.coarse && t >= arrive && t < end) handoff = true;
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
      at = OUTSIDE;
    } else {
      const b = bs[bi];
      // It appears where this stretch's work first lands (else where the last one ended).
      const first = b.map((g) => where(ctx, g)).find(Boolean);
      const prev = bi > 0 ? [...bs[bi - 1]].reverse().map((g) => where(ctx, g)).find(Boolean) : null;
      ({ at, portal, glance, moves } = follow(ctx, b, t, first ?? prev ?? { place: OUTSIDE }, false));
      const lastEnd = Math.max(...b.filter((g) => g.start <= t).map((g) => g.end));
      const idle = t - lastEnd;
      fade = Math.min(1, (t - b[0].start) / APPEAR_MS);
      if (idle > IDLE_LEAVE_MS) {
        fade = Math.min(fade, Math.max(0, 1 - (idle - IDLE_LEAVE_MS) / FADE_MS));
        if (fade <= 0) present = false;
      }
    }
  }

  let trip: Trip | null = null;
  let w = 1;
  if (walkOn && moves.length) {
    trip = planFor(moves[moves.length - 1], ctx);
    w = t >= trip.t1 ? 1 : Math.min(0.999, Math.max(0, (t - trip.t0) / (trip.t1 - trip.t0)));
  }
  let pose: Pose = w < 1 ? "walk" : seg ? seg.kind : "idle";
  if (handoff) pose = "handoff";
  else if (parent && pose === "idle" && (run.doneAt == null || t < run.doneAt)) pose = run.coarse ? "unknown" : "think";
  return {
    present,
    fade,
    at,
    from: moves.length ? moves[moves.length - 1].from : at,
    trip,
    w,
    ...(glance && w >= 1 ? { glance } : {}),
    seg,
    pose,
    since: seg ? t - seg.start : 0,
    receipt,
    ...(portal ? { portal } : {}),
    handoff,
    moves,
  };
}

const trips = new WeakMap<object, Map<string, Trip>>();
const STRAIGHT = {};
/** The trip of a move between two docks, along the canvas's walk map (memoised per map: docks move
 * when the diagram does). Planned for the figure's size at the reference view (a sub-agent's is smaller). */
export function planFor(m: Move, ctx: Pick<Ctx, "dock" | "route">): Trip {
  const a = ctx.dock(m.from);
  const b = ctx.dock(m.to);
  let byMove = trips.get(ctx.route ?? STRAIGHT);
  if (!byMove) trips.set(ctx.route ?? STRAIGHT, (byMove = new Map()));
  const key = `${m.t}|${m.sub ? 1 : 0}|${m.from}|${m.to}|${a.x},${a.y}|${b.x},${b.y}`;
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

/** Each canvas's current context and place names, published by its overlay for the timeline
 * (walk bars, 「在 API 服务」 rows, the detail card) — read at ≤ 4 Hz, never per frame. */
export const canvasWhere = new Map<string, { ctx: Ctx; label: (place: string) => string }>();
