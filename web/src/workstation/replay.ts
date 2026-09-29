// PR 回放 (web/docs/workstation.md「PR 回放」): a merged PR's git commits played as one synthetic run,
// so walking, bridges and ladders, doors, the follow pane and the bubbles all come from the run model
// as they are. One PR is one figure: per commit a thinking beat (the commit's title), then a write for
// each node the commit's files land on — the nodes taken nearest first, so it does not run back and
// forth — and at the end a beat that says how much it changed. It is made from git, not from what an
// agent did: the page says so. Pure; the data comes from `GET /api/project/replays`.
import { OUTSIDE } from "./place";
import type { Pt } from "./rig";
import type { RunSeg, WorkRun } from "./runs/types";

export type ReplayOp = "add" | "edit" | "delete" | "rename";
export type ReplayFile = { path: string; op: ReplayOp; additions?: number; deletions?: number };
export type ReplayCommit = { sha: string; title: string; at: string; files: ReplayFile[] };
export type ReplaySpec = {
  id: string;
  kind: "pr";
  number: number;
  title: string;
  author: string;
  /** Who made it: claude, codex, pi, grok, cursor, devin or unknown (a neutral figure). */
  agent?: { kind: string };
  url?: string;
  mergedAt: string;
  source: "github" | "squash";
  commits: ReplayCommit[];
};
/** A row of the list (`GET /api/project/replays`): the counts, or the arrays themselves. */
export type ReplayItem = { id: string; kind: string; number: number; title: string; author: string; mergedAt: string; source: string; commits: number | unknown[]; files: number | unknown[] };
export const countOf = (x: number | unknown[]) => (Array.isArray(x) ? x.length : x);

/** What a diagram tells the replay: which node a file lands on (its deepest one, or OUTSIDE), and where that node is on the main canvas (null: not on it). */
export type ReplayCtx = {
  place: (path: string) => string;
  dock: (path: string) => Pt | null;
  /** How long the walk from one file's node to another's takes (ms; `from` null: it appears there). The walk is part of the segment and is never squeezed by the fit, so slower walking (./rig.ts) gets its time. */
  walkMs?: (from: string | null, to: string) => number;
};

/** A write's `files`: every file of the commit that lands on the segment's node. */
export type ReplaySegFile = { path: string; op: ReplayOp; additions?: number; deletions?: number };

const THINK_MS = 800;
const TAIL_MS = 2000;
const WRITE_MIN_MS = 1200;
const WRITE_MAX_MS = 3000;
/** Floors for a fitted PR: a walk to the next node needs about 0.7 s; a thought needs a beat to read. */
const WRITE_FLOOR_MS = 700;
const THINK_FLOOR_MS = 350;
/** A whole PR takes 20–40 s at 1× (the summary's 2 s included), by stretching or squeezing its beats. */
const BODY_MIN_MS = 18_000;
const BODY_MAX_MS = 38_000;
const STRETCH_MAX = 2;

const base = (p: string) => p.split("/").pop() || p;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const writeMs = (n: number) => clamp(900 + 250 * n, WRITE_MIN_MS, WRITE_MAX_MS);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

type Group = { key: string; files: ReplayFile[]; at: Pt | null };
type Beat = { kind: "think" | "write"; ms: number; walk: number; commit: number; note?: string; group?: Group };

/** A commit's files by node, the nodes in the order to visit: nearest to where the last one left off, the tray last. */
function groupsOf(files: readonly ReplayFile[], ctx: ReplayCtx, from: Pt | null): Group[] {
  const by = new Map<string, Group>();
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const key = ctx.place(f.path);
    let g = by.get(key);
    if (!g) by.set(key, (g = { key, files: [], at: key === OUTSIDE ? null : ctx.dock(f.path) }));
    g.files.push(f);
  }
  const left = [...by.values()];
  const out: Group[] = [];
  let cur = from;
  while (left.length) {
    // nodes first (the tray, and nodes with no position, last); nearest first; ties by key
    const rank = (g: Group) => (g.at ? (cur ? dist(cur, g.at) : 0) : Infinity);
    left.sort((a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const next = left.shift()!;
    out.push(next);
    if (next.at) cur = next.at;
  }
  return out;
}

export type ReplayOpts = {
  /** Fit the whole run into 20–40 s (default). Off: the beats at their natural length (tests). */
  fit?: boolean;
};

/** The PR as one run starting at `at` (ms). */
export function replayRun(spec: ReplaySpec, ctx: ReplayCtx, at = 0, o: ReplayOpts = {}): WorkRun {
  // where the first commit starts: the node nearest the diagram's top left (where one starts reading it)
  const docks: Pt[] = [];
  for (const c of spec.commits) for (const f of c.files) if (ctx.place(f.path) !== OUTSIDE) {
    const d = ctx.dock(f.path);
    if (d) docks.push(d);
  }
  let cur: Pt | null = docks.length ? { x: Math.min(...docks.map((d) => d.x)), y: Math.min(...docks.map((d) => d.y)) } : null;
  const beats: Beat[] = [];
  let prev: string | null = null;
  const nodes = new Set<string>();
  const files = new Set<string>();
  spec.commits.forEach((c, ci) => {
    beats.push({ kind: "think", ms: THINK_MS, walk: 0, commit: ci, note: c.title });
    for (const g of groupsOf(c.files, ctx, cur)) {
      const to = g.files[0].path;
      beats.push({ kind: "write", ms: writeMs(g.files.length), walk: ctx.walkMs ? Math.round(ctx.walkMs(prev, to)) : 0, commit: ci, group: g });
      prev = to;
      if (g.at) cur = g.at;
      if (g.key !== OUTSIDE) nodes.add(g.key);
      for (const f of g.files) files.add(f.path);
    }
  });
  // the walks are not part of what is fitted
  const natural = beats.reduce((n, b) => n + b.ms, 0);
  const scale = o.fit === false || !natural ? 1 : clamp(clamp(natural, BODY_MIN_MS, BODY_MAX_MS) / natural, 1 / STRETCH_MAX, STRETCH_MAX);
  const segs: RunSeg[] = [];
  let t = at;
  const push = (s: Omit<RunSeg, "start" | "end">, ms: number) => {
    segs.push({ ...s, start: t, end: t + ms });
    t += ms;
  };
  for (const b of beats) {
    const floor = o.fit === false ? 0 : b.kind === "write" ? WRITE_FLOOR_MS : THINK_FLOOR_MS;
    const ms = Math.round(Math.max(floor, b.ms * scale)) + b.walk;
    if (b.kind === "think") push({ kind: "think", turn: b.commit + 1, note: b.note, label: b.note ?? "思考" }, ms);
    else {
      const gf = b.group!.files;
      push({ kind: "write", turn: b.commit + 1, path: gf[0].path, files: gf.map((f) => ({ ...f })), label: gf.length > 1 ? `写 ${base(gf[0].path)} 等 ${gf.length} 个文件` : `写 ${base(gf[0].path)}` }, ms);
    }
  }
  const note = `这个 PR 改了 ${nodes.size} 个节点、${files.size} 个文件`;
  push({ kind: "think", turn: spec.commits.length || 1, note, label: note }, TAIL_MS);
  return {
    id: `pr:${spec.id}`,
    agent: !spec.agent || spec.agent.kind === "unknown" ? "worker" : spec.agent.kind,
    name: `PR #${spec.number}`,
    task: spec.title,
    segs,
    receipts: [],
    running: false,
    lastAt: t,
    children: [],
  };
}

/**
 * How many files each place shows at `t` (the badge's +N): the files of the run's writes, a write's
 * files coming one by one over its length (at least one once it has started); a file counts once
 * however many commits touch it. `place` is the canvas's own: it names a file's node on that canvas
 * (a parent node takes its sub-diagram's files) or null (the tray: no badge).
 */
export function fileCounts(run: WorkRun, t: number, place: (path: string) => string | null): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const s of run.segs) {
    if (s.kind !== "write" || !s.files || s.start > t) continue;
    const u = s.end > s.start ? clamp((t - s.start) / (s.end - s.start), 0, 1) : 1;
    const n = t >= s.end ? s.files.length : Math.max(1, Math.ceil(u * s.files.length));
    for (const f of s.files.slice(0, n)) {
      const p = place(f.path);
      if (!p) continue;
      let set = seen.get(p);
      if (!set) seen.set(p, (set = new Set()));
      set.add(f.path);
    }
  }
  return new Map([...seen].map(([p, set]) => [p, set.size]));
}
