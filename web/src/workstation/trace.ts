// 追踪 (web/docs/workstation.md §11): the way one agent went over a canvas, for the trace layer
// (./Overlay.tsx). Pure: from the run, the canvas's context and t —
//   - the places it went to, in order (numbered on the canvas): where it appeared, then each place it
//     walked to (a glance is not a visit; coming back is a new stop), reached when the figure stops
//     walking there, and — when it worked on files its node claims through a sub-diagram — that entry;
//   - each walk between two stops along the route the walk takes: the same legs (floors, bridges,
//     ladders) its trip is planned on and its bridges and ladders are drawn from (./route.ts via the
//     context), and how much of it has been walked at t (up to the walker's feet);
//   - where each of its sub-agents was sent from, the places it went and where it handed back.
// Only the stretch of work t is in (the figure is on the canvas for that stretch only; a sub-agent's is
// its whole errand). In replay what comes after t in that stretch is listed too, not yet reached.
import { arrivalOf, bursts, isCut, outsideProject, OUTSIDE, planFor, stateAt, type Ctx } from "./place";
import { rawRoot, type Move, type Pt, type Trip } from "./rig";
import type { Leg } from "./route";
import type { RunSeg, WorkRun } from "./runs/types";

/**
 * One tool call (or dispatch) of the trace, shown at the stop where it happened (web/docs/workstation.md §11
 * 按轮追踪): `tool` = a lane segment of the run that has a transcript item (`itemId`: the session's
 * trajectory row — the link both ways), `spawn` = it sent a sub-agent, `back` = the sub-agent handed back.
 */
export type Call = { kind: "tool" | "spawn" | "back"; label: string; at: number; run: string; itemId?: string; child?: string };

/** One place it went to: a node's element id, or OUTSIDE (the 图外 tray). */
export type Stop = {
  place: string;
  /** When it set off for it (the first: when it appeared there). */
  t0: number;
  /** When it got there: its walk's end (with reduced motion, when it set off — it fades across). */
  at: number;
  /** Got there by t. */
  done: boolean;
  /** The tool calls made here, in order (this turn's only, when a turn is traced). */
  calls: Call[];
  /** It worked below this node, in the sub-diagram the node opens: that canvas, and the nodes it went to in there, in order. */
  portal?: { canvasId: string; labels: string[] };
};
/** The walk from stop `from` to stop `to`: set off at t0, there at t1, along `legs` (`len` world px). `trip`: the planned walk (null with reduced motion). */
export type Way = { from: number; to: number; t0: number; t1: number; legs: Leg[]; len: number; trip: Trip | null };
/** A sub-agent's errand: sent from where its dispatcher stood, the places it went (the first is `sent`), back where it handed over (null until then). */
export type SubTrace = { id: string; sent: Stop; back: Stop | null; stops: Stop[] };
export type Trace = { id: string; stops: Stop[]; ways: Way[]; subs: SubTrace[] };

/** The stretch of work t is in (before any, the first): when it began and when its last work ended. A sub-agent's: its errand. */
function stretchOf(run: WorkRun, t: number): { start: number; end: number } | null {
  if (run.parentId) {
    if (run.spawnAt == null) return null;
    let end = Math.max(run.spawnAt, run.doneAt ?? -Infinity);
    for (const g of run.segs) end = Math.max(end, g.end);
    return { start: run.spawnAt, end };
  }
  const bs = bursts(run.segs);
  if (!bs.length) return null;
  let b = bs[0];
  for (const x of bs) if (x[0].start <= t) b = x;
  let end = -Infinity;
  for (const g of b) end = Math.max(end, g.end);
  return { start: b[0].start, end };
}

/**
 * Pure: the run's trace at t on the canvas `ctx` describes. `known`: the end of what has happened (live:
 * now) — a scripted log (the dev mock) knows its future, a live one does not; later moves are left out.
 */
export function traceAt(run: WorkRun, t: number, ctx: Ctx, known = Infinity, win?: { start: number; end: number }): Trace {
  const out: Trace = { id: run.id, stops: [], ways: [], subs: [] };
  const span = win ?? stretchOf(run, t);
  if (!span) return out;
  // Every move of the stretch (the state at its end has them all, a sub-agent's walk back included).
  const end = stateAt(run, span.end, ctx);
  // (a turn's window can lie inside a longer burst of work: the moves before it belong to the turns before)
  const moves = end.moves.filter((m) => m.from !== m.to && m.t <= known && (!win || m.t >= win.start));
  // where it appeared: the first move sets off from there (no move: it stays where it is — for a turn, where it stood as the turn began)
  out.stops.push({ place: moves[0]?.from ?? (win ? stateAt(run, win.start, ctx).at : (end.moves[0]?.from ?? end.at)), t0: span.start, at: span.start, done: span.start <= t, calls: [] });
  for (const m of moves) {
    // a cut (./place.ts `isCut`: the figure is across in CUT_MS, no walk) has no route and arrives when the cut is over
    const cut = isCut(m, ctx);
    const trip = ctx.reduced || cut ? null : planFor(m, ctx);
    const at = cut ? arrivalOf(m, ctx) : trip ? trip.t1 : m.t;
    const legs = cut ? [] : legsOf(m, ctx);
    out.ways.push({ from: out.stops.length - 1, to: out.stops.length, t0: m.t, t1: at, legs, len: lengthOf(legs), trip });
    out.stops.push({ place: m.to, t0: m.t, at, done: at <= t, calls: [] });
  }
  entries(run, { start: span.start, end: Math.min(span.end, known) }, out.stops, ctx);
  attachCalls(run, { start: span.start, end: Math.min(span.end, known) }, out.stops, ctx);
  for (const c of run.children) {
    // one known only by its receipts never walks: there is no way to show
    if (c.coarse || c.spawnAt == null || c.spawnAt > t || c.spawnAt < span.start || c.spawnAt > span.end) continue;
    const k = traceAt(c, t, ctx, known);
    if (!k.stops.length) continue;
    const back = c.doneAt != null && c.doneAt <= t ? k.stops[k.stops.length - 1] : null;
    out.subs.push({ id: c.id, sent: k.stops[0], back, stops: k.stops });
  }
  return out;
}

/** How long after a call begins its walk may set off (its stop then still gets the call). */
const SET_OFF_MS = 3000;
const clip = (s: string, n = 72) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** What one segment says as a tool call (null: not a call — thinking). */
function callLabel(run: WorkRun, g: RunSeg): string | null {
  switch (g.kind) {
    case "read":
      return `Read ${g.path ?? ""}`.trim();
    case "write":
      return `Edit ${g.path ?? ""}`.trim();
    case "exec":
      return `Bash ${clip(g.cmd ?? "")}`.trim();
    case "wait":
      return `问你：${clip(g.question ?? "")}`;
    case "delegate": {
      const c = run.children.find((x) => x.id === g.child);
      return `派出 ${c?.name ?? "子代理"}${c?.task ? `：${clip(c.task, 48)}` : ""}`;
    }
    default:
      return null;
  }
}

/**
 * The tool calls of the stretch, each at the stop where it happened: a call on a file goes to the latest stop
 * at that file's node (a glance from elsewhere is still "on that node"), a file no node claims to the 图外
 * tray, one outside the project (or with no file) to the stop the agent stood at. Sub-agents' dispatch and
 * hand-back are calls of their dispatcher.
 */
function attachCalls(run: WorkRun, span: { start: number; end: number }, stops: Stop[], ctx: Ctx) {
  const standing = (at: number) => {
    let s = stops[0];
    for (const x of stops) if (x.t0 <= at) s = x;
    return s;
  };
  // a walk sets off a moment after the call that sends it there begins: that call is still the walk's own
  const stopAt = (place: string, at: number) => {
    let s: Stop | undefined;
    for (const x of stops) if (x.place === place && x.t0 <= at + SET_OFF_MS) s = x;
    return s ?? standing(at);
  };
  const dispatched = new Set<string>();
  // a dispatch segment that does not say which run it sent (the page could not link them) is the nearest one sent just after it
  const claim = (g: RunSeg) => {
    if (g.child) return g.child;
    let best: WorkRun | undefined;
    for (const c of run.children) if (!dispatched.has(c.id) && c.spawnAt != null && Math.abs(c.spawnAt - g.start) <= 10_000 && (!best || Math.abs(c.spawnAt - g.start) < Math.abs(best.spawnAt! - g.start))) best = c;
    return best?.id;
  };
  for (const g of run.segs) {
    if (g.start < span.start || g.start > span.end) continue;
    const child = g.kind === "delegate" ? claim(g) : g.child;
    const label = callLabel(run, child === g.child ? g : { ...g, child });
    if (label == null) continue;
    if (g.kind === "delegate" && child) dispatched.add(child);
    const target = g.path && !outsideProject(g.path) ? (ctx.locate(g.path)?.place ?? OUTSIDE) : null;
    const stop = target ? stopAt(target, g.start) : standing(g.start);
    stop.calls.push({ kind: g.kind === "delegate" ? "spawn" : "tool", label, at: g.start, run: run.id, ...(g.itemId ? { itemId: g.itemId } : {}), ...(child ? { child } : {}) });
  }
  for (const c of run.children) {
    if (c.spawnAt == null || c.spawnAt < span.start || c.spawnAt > span.end) continue;
    if (!dispatched.has(c.id)) standing(c.spawnAt).calls.push({ kind: "spawn", label: `派出 ${c.name}${c.task ? `：${clip(c.task, 48)}` : ""}`, at: c.spawnAt, run: run.id, child: c.id });
    if (c.doneAt != null && c.doneAt <= span.end) standing(c.doneAt).calls.push({ kind: "back", label: `${c.name} 交回`, at: c.doneAt, run: run.id, child: c.id });
  }
  for (const s of stops) s.calls.sort((a, b) => a.at - b.at);
}

/** The sub-diagram entries: a file its node claims through a child canvas, worked on while it stood there (a glance from elsewhere does not count). */
function entries(run: WorkRun, span: { start: number; end: number }, stops: Stop[], ctx: Ctx) {
  for (const g of run.segs) {
    if (!g.path || g.start < span.start || g.start > span.end) continue;
    const w = ctx.locate(g.path);
    if (!w?.portal) continue;
    let s: Stop | undefined;
    for (const x of stops) if (x.t0 <= g.start) s = x;
    if (!s || s.place !== w.place) continue;
    s.portal ??= { canvasId: w.portal.canvasId, labels: [] };
    if (!s.portal.labels.includes(w.portal.label)) s.portal.labels.push(w.portal.label);
  }
}

const legCache = new WeakMap<object, Map<string, Leg[]>>();
const STRAIGHT = {};
/** A move's legs: the route its trip is planned on (./place.ts planFor: same docks, same walk map), memoised per map. */
function legsOf(m: Move, ctx: Ctx): Leg[] {
  const a = ctx.dock(m.from);
  const b = ctx.dock(m.to);
  let byKey = legCache.get(ctx.route ?? STRAIGHT);
  if (!byKey) legCache.set(ctx.route ?? STRAIGHT, (byKey = new Map()));
  const key = `${m.from}|${m.to}|${a.x},${a.y}|${b.x},${b.y}`;
  let legs = byKey.get(key);
  if (!legs) {
    if (byKey.size > 2000) byKey.clear();
    legs = ctx.route ? ctx.route({ place: m.from, at: a }, { place: m.to, at: b }).legs : straight(a, b);
    byKey.set(key, legs);
  }
  return legs;
}

/** Without a walk map (as ./place.ts plans it then): across at the start's height, then up or down. */
function straight(a: Pt, b: Pt): Leg[] {
  const legs: Leg[] = [];
  if (a.x !== b.x) legs.push({ kind: "walk", a, b: { x: b.x, y: a.y }, temp: false });
  if (a.y !== b.y) legs.push({ kind: "climb", a: { x: b.x, y: a.y }, b, temp: false });
  return legs;
}

const lengthOf = (legs: readonly Leg[]) => legs.reduce((n, l) => n + Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y), 0);

/** The point `d` world px along the legs (clamped to their ends). */
export function pointAt(legs: readonly Leg[], d: number): Pt {
  if (!legs.length) return { x: 0, y: 0 };
  let left = Math.max(0, d);
  for (const l of legs) {
    const n = Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
    if (left <= n) {
      const u = n ? left / n : 0;
      return { x: l.a.x + (l.b.x - l.a.x) * u, y: l.a.y + (l.b.y - l.a.y) * u };
    }
    left -= n;
  }
  return { ...legs[legs.length - 1].b };
}

/** How far along the legs the point nearest to p is (world px). */
function along(legs: readonly Leg[], p: Pt): number {
  let best = Infinity;
  let at = 0;
  let from = 0;
  for (const l of legs) {
    const dx = l.b.x - l.a.x;
    const dy = l.b.y - l.a.y;
    const n2 = dx * dx + dy * dy;
    const u = n2 ? Math.max(0, Math.min(1, ((p.x - l.a.x) * dx + (p.y - l.a.y) * dy) / n2)) : 0;
    const dist = Math.hypot(l.a.x + dx * u - p.x, l.a.y + dy * u - p.y);
    const n = Math.sqrt(n2);
    if (dist < best - 1e-6) {
      best = dist;
      at = from + n * u;
    }
    from += n;
  }
  return at;
}

/**
 * How much of a way has been walked by t (world px along its legs): none before it sets off, all of it
 * once there. On the way it keeps up with the walker: through each stretch of the walk (along a floor,
 * up or down a ladder) in step with how far the walker is through it — so it grows smoothly and its end
 * stays at the walker's feet (a climber keeps a little off its ladder). Reduced motion: all of it from
 * when it sets off.
 */
export function walkedAt(w: Way, t: number): number {
  if (t >= w.t1) return w.len;
  if (t < w.t0) return 0;
  if (!w.trip) return w.len;
  const ph = w.trip.phases;
  if (!ph.length || t <= ph[0].t0) return 0;
  const x = ph.find((p) => t < p.t1) ?? ph[ph.length - 1];
  const s = along(w.legs, x.a);
  const e = along(w.legs, x.b);
  const r = rawRoot(w.trip, t); // along the way as planned, not the body with its corners rounded (rig.ts ROUND_MS)
  const L = Math.abs(x.b.x - x.a.x);
  const H = Math.abs(x.b.y - x.a.y);
  const f = L > 1e-6 ? Math.abs(r.x - x.a.x) / L : H > 1e-6 ? Math.abs(r.y - x.a.y) / H : 1;
  return Math.max(0, Math.min(w.len, s + (e - s) * Math.max(0, Math.min(1, f))));
}

// ——— by turn (web/docs/workstation.md §11): the trace of one turn of a session, and the way to and from its rows ———

/** One turn of a session as the trace's stretch: `end` null = still running (up to now). */
export type TurnWindow = { n: number; start: number; end: number | null };

/** The turn `n` of a run as the segments say it (the session's turn numbers): from its first segment to its last (running: to now). */
export function turnWindowOf(run: WorkRun, n: number): TurnWindow | null {
  const segs = run.segs.filter((g) => g.turn === n);
  if (!segs.length) return null;
  const last = Math.max(...run.segs.map((g) => g.turn ?? 0));
  return { n, start: Math.min(...segs.map((g) => g.start)), end: run.running && n === last ? null : Math.max(...segs.map((g) => g.end)) };
}
/** The run's current (or latest) turn — what tracing a figure starts on. Null when its segments carry no turn numbers. */
export function latestTurnWindow(run: WorkRun): TurnWindow | null {
  const last = Math.max(0, ...run.segs.map((g) => g.turn ?? 0));
  return last ? turnWindowOf(run, last) : null;
}
/** A window as the stretch traceAt takes: a running turn ends now. */
export const spanOf = (w: TurnWindow, now: number) => ({ start: w.start, end: w.end ?? Math.max(now, w.start) });

/** The stop (and whose: the traced run's or a sub-agent's) whose calls include this transcript item — the canvas end of a trajectory row. */
export function stopForItem(tr: Trace, itemId: string): { run: string; index: number } | null {
  const find = (stops: Stop[]) => stops.findIndex((s) => s.calls.some((c) => c.itemId === itemId));
  const i = find(tr.stops);
  if (i >= 0) return { run: tr.id, index: i };
  for (const k of tr.subs) {
    const j = find(k.stops);
    if (j >= 0) return { run: k.id, index: j };
  }
  return null;
}
/** The transcript item a stop stands for: its first call that has one — the trajectory end of a stop. */
export function itemOfStop(tr: Trace, runId: string, index: number): string | null {
  const stops = runId === tr.id ? tr.stops : tr.subs.find((k) => k.id === runId)?.stops;
  return stops?.[index]?.calls.find((c) => c.itemId)?.itemId ?? null;
}
/** Every call of a stop that has a transcript item, in time order — the rows that light together when the stop is clicked. */
export function itemsOfStop(tr: Trace, runId: string, index: number): string[] {
  const stops = runId === tr.id ? tr.stops : tr.subs.find((k) => k.id === runId)?.stops;
  const ids = (stops?.[index]?.calls ?? []).flatMap((c) => (c.itemId ? [c.itemId] : []));
  return [...new Set(ids)];
}
