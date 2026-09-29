// Where an agent is below the canvas the person looks at (web/docs/workstation.md §10 子视图跟随).
//
// A node can open a child canvas (web/docs/nested-canvas.md). A file its node claims only through
// that child lies in the child's picture, one level down — and so on, any depth: 总架构 › API 服务 ›
// 用户模块. geometry.ts `locate` stops one level down (the worker stands on the parent node and its
// bubble names the node below); here the chain goes all the way, from whichever canvas is the main
// one, and a loop of child links is cut where it would repeat a canvas.
//
// `presenceAt` says where a run stands at t in those terms — ./place.ts `stateAt` with the deepest
// nodes as its places, so a short read of another node is a glance exactly as it is on the canvas —
// and since when it has been working below the main canvas. The follow pane (./FollowPane.tsx)
// opens for newcomers (`arrivals`) and follows the latest. Pure; memoised per scenes and context.
import { effectiveLinks, type NestedLink, type Scenes } from "../nested/graph";
import { elementFor } from "../pointer/codeLinks";
import { bursts, DOOR_MS, OUTSIDE, stateAt, type Ctx } from "./place";
import type { RunSeg, WorkRun } from "./runs/types";

export type Titles = Readonly<Record<string, string>>;
/** One level: a canvas, and the node on it that has the file (on every level but the last, the node that opens the next canvas). */
export type Level = { canvasId: string; title: string; node: string; label: string };

const linkCache = new WeakMap<Scenes, Map<string, NestedLink[]>>();
function linksOf(canvasId: string, scenes: Scenes): NestedLink[] {
  let m = linkCache.get(scenes);
  if (!m) linkCache.set(scenes, (m = new Map()));
  let l = m.get(canvasId);
  if (!l) m.set(canvasId, (l = effectiveLinks(canvasId, scenes)));
  return l;
}

/**
 * The levels a file lies at, from `main` down: `main` first, one entry per canvas; a single level
 * means the file is on `main` itself. Null when nothing on `main` claims it (图外).
 */
export function levelsOf(path: string, main: string, scenes: Scenes, titles: Titles = {}): Level[] | null {
  const out: Level[] = [];
  const seen = new Set<string>();
  for (let c: string | undefined = main; c && !seen.has(c); ) {
    seen.add(c);
    const hit = elementFor(path, linksOf(c, scenes));
    if (!hit) break;
    const link = hit.link as NestedLink;
    out.push({ canvasId: c, title: titles[c] ?? "", node: link.id, label: link.label });
    // claimed through its child canvas (not by the node's own paths): one level down
    c = link.child && !link.own.includes(hit.glob) && scenes.has(link.child) ? link.child : undefined;
  }
  return out.length ? out : null;
}

export type SubviewCtx = {
  main: string;
  /** A file's place: its deepest node below `main` (a key), or OUTSIDE. */
  place: (path: string) => string;
  /** A place's levels (null for OUTSIDE). */
  levels: (place: string) => Level[] | null;
  /** ./place.ts context whose places are those deepest nodes. */
  state: Ctx;
  /** Where each run stood as each of its segments started (by index): the glance test, memoised. */
  starts: WeakMap<WorkRun, Map<number, string>>;
  /** The main canvas's own context (walking, doors), when its overlay has published one: the run is below the main canvas
   * from the moment it is through the door there, and back on it from the moment it comes out (not from when its work started). */
  outer?: () => Ctx | undefined;
};

/** The context for one main canvas, one set of scenes and one set of runs (keep it while they stay the same: it memoises). */
export function subviewCtx(main: string, scenes: Scenes, titles: Titles, run: (id: string) => WorkRun | undefined, outer?: () => Ctx | undefined): SubviewCtx {
  const byPath = new Map<string, string>();
  const byPlace = new Map<string, Level[]>();
  const place = (path: string) => {
    let k = byPath.get(path);
    if (k === undefined) {
      const ls = levelsOf(path, main, scenes, titles);
      k = ls ? ls.map((l) => `${l.canvasId}\u0000${l.node}`).join("\u0001") : OUTSIDE;
      if (ls) byPlace.set(k, ls);
      byPath.set(path, k);
    }
    return k;
  };
  const state: Ctx = {
    locate: (p) => {
      const k = place(p);
      return k === OUTSIDE ? null : { place: k };
    },
    // Where a figure stands on some canvas is that canvas's overlay's business; here only places matter.
    dock: () => ({ x: 0, y: 0 }),
    reduced: true,
    run,
  };
  return { main, place, levels: (k) => byPlace.get(k) ?? null, state, starts: new WeakMap(), outer };
}

export type Presence = {
  /** Where it stands, from the main canvas down (the last level: the deepest canvas that has its file, and its node there); null: the 图外 tray. */
  levels: Level[] | null;
  /**
   * When it came below the main canvas to work: the start of its first file there since it last
   * went to a file on the main canvas (or 图外), or since its stretch of work began. Null while it
   * is not working below — it may still stand there: before its first file, sent there, done.
   */
  entered: number | null;
  /** Done for now: idle, or a sub-agent that has reported back. */
  ended: boolean;
};

/** Where `run` is at t relative to the context's main canvas; null when it is not on the canvas. */
export function presenceAt(run: WorkRun, t: number, c: SubviewCtx): Presence | null {
  const st = stateAt(run, t, c.state);
  if (!st.present) return null;
  let levels = st.at === OUTSIDE ? null : c.levels(st.at);
  const ended = st.pose === "idle" || st.handoff || (!!run.parentId && run.doneAt != null && t >= run.doneAt);
  const mc = c.outer?.();
  if (mc?.door && !ended) {
    // The main canvas has the say: below it from the moment the worker is through the door there, until it is out again
    const ms = stateAt(run, t, mc);
    const inside = ms.portalPhase === "behind";
    if (inside && (levels?.length ?? 0) < 2) levels = lastBelow(run, t, c) ?? levels;
    else if (!inside && levels && levels.length > 1) levels = levels.slice(0, 1);
    if (inside && levels && levels.length > 1) {
      const e = entry(run, t, c);
      const d = e == null ? undefined : ms.doorsIn.find((x) => x >= e - 1);
      return { levels, entered: d == null ? e : Math.min(t, d + DOOR_MS), ended };
    }
    return { levels, entered: null, ended };
  }
  return { levels, entered: ended || !levels || levels.length < 2 ? null : entry(run, t, c), ended };
}

const stretches = new WeakMap<WorkRun, RunSeg[][]>();
/** When the stretch of work t is in began (a sub-agent's: when it was sent). */
function stretchStart(run: WorkRun, t: number): number {
  if (run.parentId) return run.spawnAt ?? -Infinity;
  let bs = stretches.get(run);
  if (!bs) stretches.set(run, (bs = bursts(run.segs)));
  let from = -Infinity;
  for (const b of bs) if (b[0].start <= t) from = b[0].start;
  return from;
}

/** The levels of the last file below the main canvas the run went to by t (it may already be on its way out). */
function lastBelow(run: WorkRun, t: number, c: SubviewCtx): Level[] | null {
  for (let i = run.segs.length - 1; i >= 0; i--) {
    const g = run.segs[i];
    if (g.start > t || !g.path) continue;
    const ls = c.levels(c.place(g.path));
    if (ls && ls.length > 1) return ls;
  }
  return null;
}

/** Where the run stood as segment i started (after the move it may start). */
function standAt(run: WorkRun, i: number, c: SubviewCtx): string {
  let m = c.starts.get(run);
  if (!m) c.starts.set(run, (m = new Map()));
  let k = m.get(i);
  if (k === undefined) m.set(i, (k = stateAt(run, run.segs[i].start, c.state).at));
  return k;
}

/** Back from t over the files it went to (glances skipped): the first of the files below, up to the last one that was not. */
function entry(run: WorkRun, t: number, c: SubviewCtx): number | null {
  const from = stretchStart(run, t);
  let e: number | null = null;
  for (let i = run.segs.length - 1; i >= 0; i--) {
    const g = run.segs[i];
    if (g.start > t || !g.path) continue;
    if (g.start < from) break;
    const k = c.place(g.path);
    if (standAt(run, i, c) !== k) continue; // a glance: it looked over from where it stood
    if (k === OUTSIDE || (c.levels(k)?.length ?? 0) < 2) break;
    e = g.start;
  }
  return e;
}

/** Runs working below the main canvas whose entry is not the one in `announced` (the pane reacted to it already), the most recent first. */
export function arrivals(ps: ReadonlyMap<string, Presence | null>, announced: ReadonlyMap<string, number>): string[] {
  const out: [string, number][] = [];
  for (const [id, p] of ps) if (p?.entered != null && announced.get(id) !== p.entered) out.push([id, p.entered]);
  return out.sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
