// 工位视图 (web/docs/workstation.md): each agent session as a little worker on the diagram, and a
// timeline with one lane per session. Everything here is derived from the sessions' transcripts
// (the CLI's own logs, server/canvas/transcript.py), so the same log always gives the same lanes,
// and the worker's place and pose at any moment is a pure function of time — replay is exact,
// and a background tab that skipped frames draws the right state as soon as it is visible again.
import type { Item } from "../session/agents";
import { activityOf, buildTurns, type TrajTurn } from "../session/trajectoryModel";

/** What a worker is doing: reading, writing, running a command, thinking, waiting for the person, or nothing. */
export type SegKind = "read" | "write" | "exec" | "think" | "wait";
export type Pose = SegKind | "walk" | "idle";
export type Seg = {
  sessionId: string;
  kind: SegKind;
  start: number;
  end: number;
  /** Turn number (as in the trajectory, 1-based). */
  turn: number;
  /** The transcript item behind it (tool calls); thinking has none. */
  itemId?: string;
  /** Project-relative file it read or wrote, when known. */
  path?: string;
  label: string;
};
export type Lane = { sessionId: string; segs: Seg[]; turns: { n: number; start: number; end: number }[] };

export const SEG_NAMES: Record<SegKind | "idle", string> = { read: "读", write: "写", exec: "执行命令", think: "思考", wait: "等待用户", idle: "空闲" };

const MIN_TOOL_MS = 600;
const MIN_THINK_MS = 400;

const KIND: Record<string, SegKind> = {
  read: "read",
  search: "read",
  webFetch: "read",
  webSearch: "read",
  write: "write",
  edit: "write",
  commands: "exec",
  tools: "exec",
  subagents: "exec",
  plan: "think",
  questions: "wait",
};

/** A read tool's file from its one-line input (Claude `file_path`, Pi `path`), relative to the project. */
export function readPath(input: string | undefined, root: string | undefined): string | undefined {
  const s = (input ?? "").trim();
  if (!s || /\s/.test(s) || !/[/.]/.test(s) || s.startsWith("{")) return undefined;
  const r = root?.replace(/\/+$/, "");
  if (r && s.startsWith(`${r}/`)) return s.slice(r.length + 1);
  return s.startsWith("/") ? s : s.replace(/^\.\//, "");
}

const base = (p: string) => p.split("/").pop() || p;

/** One session's lane: tool calls as read / write / exec / wait, the time between them in a turn as thinking. */
export function buildLane(sessionId: string, items: readonly Item[], opts: { live?: boolean; now?: number; root?: string } = {}): Lane {
  const now = opts.now ?? Date.now();
  const turns: TrajTurn[] = buildTurns(items, {}, !!opts.live);
  const segs: Seg[] = [];
  const spans: Lane["turns"] = [];
  for (const t of turns) {
    const recs = t.steps.flatMap((s) => s.records);
    const lastEnd = Math.max(t.startedAt, ...recs.map((r) => r.at + (r.durationMs ?? 0)));
    const end = t.endedAt ?? (t.running ? now : lastEnd);
    spans.push({ n: t.n, start: t.startedAt, end: Math.max(end, t.startedAt) });
    const tools = recs
      .filter((r) => r.kind === "tool")
      .map((r) => {
        const it = r.item;
        const kind = KIND[activityOf(it.tool?.name)] ?? "exec";
        const dur = r.durationMs ?? (r.running ? now - r.at : MIN_TOOL_MS);
        const file = it.tool?.files?.[0]?.path;
        const path = kind === "write" ? file : kind === "read" ? readPath(it.tool?.input, opts.root) : file;
        const verb = SEG_NAMES[kind];
        return { sessionId, kind, start: r.at, end: r.at + Math.max(dur, MIN_TOOL_MS), turn: t.n, itemId: it.id, ...(path ? { path } : {}), label: path ? `${verb} ${base(path)}` : `${verb} · ${it.tool?.name ?? "工具"} ${it.tool?.input ?? ""}`.trim() } as Seg;
      })
      .sort((a, b) => a.start - b.start);
    // Parallel calls in one step are shown one after another: a worker does one thing at a time.
    let cursor = t.startedAt;
    for (const s of tools) {
      if (s.start < cursor) {
        const d = s.end - s.start;
        s.start = cursor;
        s.end = cursor + d;
      }
      if (s.start - cursor >= MIN_THINK_MS) segs.push({ sessionId, kind: "think", start: cursor, end: s.start, turn: t.n, label: SEG_NAMES.think });
      segs.push(s);
      cursor = s.end;
    }
    const turnEnd = Math.max(end, cursor);
    if (turnEnd - cursor >= MIN_THINK_MS) segs.push({ sessionId, kind: "think", start: cursor, end: turnEnd, turn: t.n, label: SEG_NAMES.think });
    spans[spans.length - 1].end = turnEnd;
  }
  return { sessionId, segs, turns: spans };
}

export type Axis = {
  start: number;
  end: number;
  /** Axis length in ms after long idle gaps were squeezed. */
  span: number;
  toX: (t: number) => number;
  fromX: (x: number) => number;
  /** Where a long idle gap was squeezed (axis ms), for a break mark. */
  breaks: { x: number; from: number; to: number }[];
};

/**
 * One time axis for all lanes: real time, except that stretches where nobody did anything for
 * longer than `gap` are squeezed to `gapW` (an hour's lunch break does not flatten everything).
 */
export function buildAxis(lanes: Lane[], { gap = 20_000, gapW = 3_000, now }: { gap?: number; gapW?: number; now?: number } = {}): Axis | null {
  const iv = lanes.flatMap((l) => l.turns.map((t) => [t.start, t.end] as const)).sort((a, b) => a[0] - b[0]);
  if (!iv.length) return null;
  const knots: [number, number][] = [[iv[0][0], 0]];
  const breaks: Axis["breaks"] = [];
  let covered = iv[0][1];
  let shift = 0;
  for (const [s, e] of iv.slice(1)) {
    if (s > covered + gap) {
      const x = covered - iv[0][0] - shift;
      knots.push([covered, x]);
      shift += s - covered - gapW;
      knots.push([s, s - iv[0][0] - shift]);
      breaks.push({ x: x + gapW / 2, from: covered, to: s });
    }
    covered = Math.max(covered, e);
  }
  const end = Math.max(covered, now ?? covered);
  knots.push([end, end - iv[0][0] - shift]);
  const toX = (t: number) => {
    if (t <= knots[0][0]) return 0;
    for (let i = 1; i < knots.length; i++) {
      const [r1, a1] = knots[i];
      const [r0, a0] = knots[i - 1];
      if (t <= r1) return r1 === r0 ? a1 : a0 + ((t - r0) / (r1 - r0)) * (a1 - a0);
    }
    return knots.at(-1)![1];
  };
  const fromX = (x: number) => {
    if (x <= 0) return knots[0][0];
    for (let i = 1; i < knots.length; i++) {
      const [r1, a1] = knots[i];
      const [r0, a0] = knots[i - 1];
      if (x <= a1) return a1 === a0 ? r1 : r0 + ((x - a0) / (a1 - a0)) * (r1 - r0);
    }
    return knots.at(-1)![0];
  };
  return { start: iv[0][0], end, span: Math.max(1, knots.at(-1)![1]), toX, fromX, breaks };
}

/** A worker's spot: a node's id, the "outside the diagram" desk, or home (before any work). */
export const OUTSIDE = "\u0000outside";
export const HOME = "\u0000home";
export const WALK_MS = 900;

export type FigureState = {
  pose: Pose;
  /** Where it is (or is walking to). */
  at: string;
  /** Where it came from while walking. */
  from: string;
  /** 0 → 1 along the walk; 1 once it has arrived. */
  walk: number;
  /** The segment it is in at this moment (null when idle between turns). */
  seg: Seg | null;
};

/**
 * Where a worker is and what it does at time `t`. It walks to the node of each file it reads or
 * writes (`locate`: path → node id, or null when the file is outside the diagram), taking
 * WALK_MS from the start of that call; otherwise it stays where it last worked.
 */
export function figureAt(lane: Lane, t: number, locate: (path: string) => string | null, walkMs = WALK_MS): FigureState {
  let at = HOME;
  let from = HOME;
  let movedAt = -Infinity;
  for (const s of lane.segs) {
    if (s.start > t) break;
    if (!s.path) continue;
    const to = locate(s.path) ?? OUTSIDE;
    if (to !== at) {
      from = at;
      at = to;
      movedAt = s.start;
    }
  }
  const walk = walkMs <= 0 ? 1 : Math.min(1, Math.max(0, (t - movedAt) / walkMs));
  const seg = lane.segs.find((s) => s.start <= t && t < s.end) ?? null;
  const pose: Pose = walk < 1 ? "walk" : seg ? seg.kind : "idle";
  return { pose, at, from, walk, seg };
}

/** The segment under an axis position in one lane (for clicks), nearest within `slop` axis ms. */
export function segAt(lane: Lane, axis: Axis, x: number, slop = 0): Seg | null {
  let best: Seg | null = null;
  let d = Infinity;
  for (const s of lane.segs) {
    const a = axis.toX(s.start);
    const b = axis.toX(s.end);
    const dist = x < a ? a - x : x > b ? x - b : 0;
    if (dist <= slop && dist < d) (best = s), (d = dist);
  }
  return best;
}
