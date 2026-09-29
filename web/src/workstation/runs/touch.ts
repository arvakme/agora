// The agent's canvas edits as work of the 工位视图 (web/docs/workstation.md §2 智能体改图). `agora canvas apply | anim | child` run on the page
// (session/agentBridge.ts): the page knows which nodes it changed and when, so it says so (`touches.record`) — nothing is read out of a log. Here
// the change becomes segments of that session's run: a `write` at a node (its path is `nodePath(canvas, id)`, ./nodePath.ts) a slice at a time — what one
// stance reaches (`REACH_PX`, the build replay's rule) is drawn from where the figure stands, so 30 nodes are a handful of stops, not 30 walks — in
// the order they were drawn, nearest next. The picture never waits: the whole show is over in BUDGET_MS (or 1.5 × the time the change itself took,
// an animation), and a change made while the last is still being shown follows it, or, far behind, is shown as one stop at its last node.
// Pure but for the small store at the bottom (./store.ts feeds `mergeTouches` from it).
import { REACH_PX } from "../../buildreplay/plan";
import { nodePath, parseNodePath } from "./nodePath";
import { setTouched } from "./touched";
import type { RunSeg, WorkRun } from "./types";

/** A node the change touched, at its centre (scene coordinates). */
export type TouchNode = { id: string; x: number; y: number };
/** One change the page made for a session: on which canvas, when (wall clock, ms; `until` for a change that plays over time), which nodes, in the order they were drawn. */
export type Touch = { session: string; canvas: string; at: number; until: number; nodes: TouchNode[]; say: string };
/** The part of an element `touchNodesOf` reads (an Excalidraw element has it). */
export type TouchEl = { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; containerId?: string | null; startBinding?: { elementId?: string } | null; endBinding?: { elementId?: string } | null };

/**
 * The nodes among the elements a change touched, at their centres, in the order they were touched: the places the figure works at. Text is part of the node
 * or arrow that holds it, an arrow is work at the node it starts from (else the one it ends at), lines and scribbles are nobody's place; an arrow with
 * nothing bound to a node, or a node gone, is no place at all.
 */
export function touchNodesOf(ids: Iterable<string>, map: ReadonlyMap<string, TouchEl>): TouchNode[] {
  const live = (e: TouchEl | undefined): e is TouchEl => !!e && !e.isDeleted;
  const resolve = (e: TouchEl | undefined, depth = 0): TouchEl | undefined => {
    if (!live(e) || depth > 3) return undefined;
    if (e.type === "arrow") return resolve(map.get(e.startBinding?.elementId ?? ""), depth + 1) ?? resolve(map.get(e.endBinding?.elementId ?? ""), depth + 1);
    if (e.type === "text") return e.containerId ? resolve(map.get(e.containerId), depth + 1) : undefined;
    return e.type === "line" || e.type === "freedraw" ? undefined : e;
  };
  const out = new Map<string, TouchNode>();
  for (const id of ids) {
    const e = resolve(map.get(id));
    if (e && !out.has(e.id)) out.set(e.id, { id: e.id, x: e.x + e.width / 2, y: e.y + e.height / 2 });
  }
  return [...out.values()];
}

export type Slice = { stance: string; nodes: TouchNode[] };

/** The whole show of a change lasts this long at most (more when the change itself took longer: 1.5 ×). */
export const BUDGET_MS = 8000;
/** A change starting later than this behind the one before is not shown node by node: one stop, at its last node. */
export const BACKLOG_MS = 3000;
/** The pace of a walk in the diagram, as the build replay plans it (../../buildreplay/plan.ts): a settle, then the way (with a detour) at 220 px a second. */
const SETTLE_MS = 500;
const DETOUR = 1.4;
const WALK_PX_MS = 0.22;
/** The first stop's walk (from wherever the figure stood: not known here), and the longest walk worth taking: a farther stop is a cut (./place.ts, `RunSeg.cut`). */
const FIRST_WALK_MS = 2500;
const MAX_WALK_MS = 4000;
const CUT_MS = 300;

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The stops of a change: each node joins the first slice whose first node is within REACH_PX (so far-apart nodes drawn in turn are still two stops, not
 * a walk back and forth), the stance of a slice is the node from which all of them are nearest, and the slices go nearest first from the first one.
 */
export function sliceNodes(nodes: readonly TouchNode[]): Slice[] {
  const groups: TouchNode[][] = [];
  for (const n of nodes) {
    const g = groups.find((x) => dist(x[0], n) <= REACH_PX);
    if (g) g.push(n);
    else groups.push([n]);
  }
  const slices = groups.map((g) => {
    let stance = g[0];
    let radius = Infinity;
    for (const cand of g) {
      const r = Math.max(...g.map((n) => dist(cand, n)));
      if (r < radius) [stance, radius] = [cand, r];
    }
    return { stance: stance.id, at: stance, nodes: g };
  });
  const out: typeof slices = [];
  const left = [...slices];
  let here = left.shift();
  while (here) {
    out.push(here);
    let best = -1;
    let d = Infinity;
    left.forEach((s, i) => {
      const dd = dist(here!.at, s.at);
      if (dd < d) [best, d] = [i, dd];
    });
    here = best < 0 ? undefined : left.splice(best, 1)[0];
  }
  return out.map(({ stance, nodes: ns }) => ({ stance, nodes: ns }));
}

const dwellOf = (count: number) => Math.min(2000, Math.max(900, 700 + 150 * count));
const walkMs = (a: TouchNode, b: TouchNode) => SETTLE_MS + ((Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * DETOUR) / WALK_PX_MS;

type Stop = { slice: Slice; cut: boolean; ms: number };
/** The stops for these slices in order, each with what it costs: its walk (or a cut) and its work. */
function costStops(slices: readonly Slice[], centre: Map<string, TouchNode>, before?: TouchNode): Stop[] {
  return slices.map((slice, i) => {
    const me = centre.get(slice.stance)!;
    const prev = i ? centre.get(slices[i - 1].stance)! : before;
    const w = prev ? walkMs(prev, me) : FIRST_WALK_MS;
    const cut = !!prev && w > MAX_WALK_MS;
    return { slice, cut, ms: Math.round((cut ? CUT_MS : w) + dwellOf(slice.nodes.length)) };
  });
}

/** The segments of one change, from `from` (the earliest they may start: when the figure is free) on; `before`: where the figure stood for the change before, when that was on this canvas. */
export function planTouch(t: Touch, from: number, before?: TouchNode): RunSeg[] {
  const slices = sliceNodes(t.nodes);
  if (!slices.length) return [];
  const start = Math.max(t.at, from);
  const centre = new Map(t.nodes.map((n) => [n.id, n] as const));
  const budget = Math.max(BUDGET_MS, 1.5 * (t.until - t.at));
  // As many stops as the budget has room for, spread over the change (the first and the last always): the rest are on the canvas already, and no stop is
  // hurried — a figure that has to be somewhere sooner than it can walk drops stops and jerks (./place.ts CATCH_UP_MS).
  const spread = (m: number) => Array.from({ length: m }, (_, i) => slices[m === 1 ? slices.length - 1 : Math.round((i * (slices.length - 1)) / (m - 1))]);
  let stops = costStops(spread(1), centre, before);
  if (start - t.at <= BACKLOG_MS)
    for (let m = slices.length; m >= 1; m--) {
      const c = costStops(spread(m), centre, before);
      if (m === 1 || c.reduce((n, x) => n + x.ms, 0) <= budget) {
        stops = c;
        break;
      }
    }
  const out: RunSeg[] = [];
  let at = start;
  for (const st of stops) {
    out.push({ kind: "write", start: at, end: at + st.ms, label: t.say, say: t.say, path: nodePath(t.canvas, st.slice.stance), ...(st.cut ? { cut: true as const } : {}), edit: { canvas: t.canvas, ids: st.slice.nodes.map((n) => n.id) } });
    at += st.ms;
  }
  return out;
}

const AGORA_CANVAS = /\bagora\s+canvas\b/;
const merged = new WeakMap<WorkRun, { key: string; run: WorkRun }>();

/** The run with the writes of its session's canvas changes among its own segments; the commands that made them give way where the writes begin. */
export function mergeTouches(run: WorkRun, ts: readonly Touch[]): WorkRun {
  if (!ts.length) return run;
  const key = ts.map((t) => `${t.canvas}|${t.at}|${t.nodes.length}`).join(";");
  const hit = merged.get(run);
  if (hit && hit.key === key) return hit.run;
  const writes: RunSeg[] = [];
  let free = -Infinity;
  let at: { canvas: string; node: TouchNode } | undefined;
  for (const t of [...ts].sort((a, b) => a.at - b.at)) {
    const segs = planTouch(t, free, at?.canvas === t.canvas ? at.node : undefined);
    writes.push(...segs);
    if (segs.length) {
      free = segs[segs.length - 1].end;
      const stance = parseNodePath(segs[segs.length - 1].path!)!.id;
      const node = t.nodes.find((n) => n.id === stance);
      if (node) at = { canvas: t.canvas, node };
    }
  }
  const own: RunSeg[] = [];
  for (const g of run.segs) {
    // the call that made the change ("agora canvas apply") is where the figure's drawing begins: it does not show as a command of its own there
    const w = g.kind === "exec" && g.cmd && AGORA_CANVAS.test(g.cmd) ? writes.find((x) => x.start < g.end && x.end > g.start) : undefined;
    if (!w) own.push(g);
    else if (g.start < w.start) own.push({ ...g, end: w.start });
  }
  const segs = [...own, ...writes].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = { ...run, segs, lastAt: Math.max(run.lastAt, ...writes.map((g) => g.end)) };
  merged.set(run, { key, run: out });
  return out;
}

// ——— the page's account of its own changes ———
const MAX_PER_SESSION = 400;
const held = new Map<string, Touch[]>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The nodes touched, by canvas, for geometry.ts (./touched.ts). */
function sync() {
  const m = new Map<string, Set<string>>();
  for (const ts of held.values()) for (const t of ts) for (const n of t.nodes) (m.get(t.canvas) ?? m.set(t.canvas, new Set()).get(t.canvas)!).add(n.id);
  setTouched(m);
}

export const touches = {
  /** One change the page made; the same one told twice (same session, canvas, moment and nodes) counts once. */
  record(t: Touch) {
    if (!t.nodes.length) return;
    const mine = held.get(t.session) ?? [];
    const ids = t.nodes.map((n) => n.id).join(",");
    if (mine.some((x) => x.canvas === t.canvas && x.at === t.at && x.nodes.map((n) => n.id).join(",") === ids)) return;
    mine.push(t);
    if (mine.length > MAX_PER_SESSION) mine.splice(0, mine.length - MAX_PER_SESSION);
    held.set(t.session, mine);
    sync();
    emit();
  },
  of: (session: string): readonly Touch[] => held.get(session) ?? [],
  /** Keep the changes of these sessions only (a session that left the page lets its go). */
  keep(sessions: Iterable<string>) {
    const live = new Set(sessions);
    let any = false;
    for (const s of [...held.keys()]) if (!live.has(s)) (held.delete(s), (any = true));
    if (any) (sync(), emit());
  },
  clear() {
    held.clear();
    sync();
    emit();
  },
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
};
