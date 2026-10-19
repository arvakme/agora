// 分站揭示 (web/docs/workstation.md §2 智能体改图): an agent's batch is on the canvas and saved the moment it is applied, but on the page its new
// elements appear station by station, as the figure gets to each stop of the change (./runs/touch.ts `planTouch`: `edit.reveal`, `edit.land`).
// Here, pure: when each element of a held batch appears, whether a batch is held at all, and how far into its fade-in an element is.
// The page side (a picture of the canvas without what is still to come, laid over Excalidraw's own) is ./RevealLayer.tsx.
import { LAND_LEAD_MS } from "../buildreplay/plan";
import { APPEAR_MS } from "./place";
import type { RunSeg, WorkRun } from "./runs/types";

/** A batch with fewer new elements than this appears at once, as it always did. */
export const REVEAL_MIN = 3;
/** However the figure fares, nothing of a batch stays hidden longer than this after it was applied (the budget, a backlog behind it, and slack). */
export const REVEAL_CAP_MS = 12_000;
/** An element fades in over this (the figure's own fade-in, ./place.ts APPEAR_MS). */
export const REVEAL_FADE_MS = APPEAR_MS;
/** A batch whose stops the runs have not shown yet (they are recomputed a moment after the change is told) waits this long for them, then appears. */
export const SCHEDULE_WAIT_MS = 1500;

/** What reveal.ts reads of an element (an Excalidraw element has it). */
export type RevealEl = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  containerId?: string | null;
  groupIds?: readonly string[];
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
};

/** A batch held back on the page: the elements it added (only those: a changed element stays as it is drawn now), when it was applied, on which canvas. */
export type Held = { canvas: string; at: number; ids: readonly string[] };

/** One stop of a change on this canvas, from a run: the nodes it reveals, when (planned), and when its work is over (the latest it may be). */
export type RevealStop = { key: string; run: string; seg: RunSeg; nodes: readonly string[]; land: number; end: number };

const segKey = (run: string, g: RunSeg) => `${run}|${g.start}|${g.path ?? ""}`;

/** The stops revealing nodes of `canvas` that start at or after `since`, in the order they start, from every run (a session's own, or a child run it was given). */
export function stopsOf(runs: Iterable<WorkRun>, canvas: string, since: number): RevealStop[] {
  const out: RevealStop[] = [];
  const walk = (r: WorkRun) => {
    for (const g of r.segs) if (g.edit?.canvas === canvas && g.edit.reveal && g.start >= since) out.push({ key: segKey(r.id, g), run: r.id, seg: g, nodes: g.edit.reveal, land: g.edit.land ?? g.start, end: g.end });
    r.children.forEach(walk);
  };
  for (const r of runs) walk(r);
  return out.sort((a, b) => a.seg.start - b.seg.start);
}

/**
 * When a stop's nodes appear: LAND_LEAD_MS after the figure is seen arriving there (the build replay's rhythm: the figure gets there, then it lands);
 * `"walking"`: the figure is on its way — no sooner than it gets there, so the stop's end for now; not watched (undefined): the planned landing.
 * Never after the stop's work is over.
 */
export function stopTime(s: Pick<RevealStop, "land" | "end">, seen: number | "walking" | undefined): number {
  const t = seen === "walking" ? s.end : seen == null ? s.land : seen + LAND_LEAD_MS;
  return Math.min(t, s.end);
}

const NOT_NODE = new Set(["arrow", "text", "line", "freedraw"]);
const centre = (e: RevealEl) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });

/**
 * When each element of a held batch appears (wall clock), given when each node does (`nodeAt`, from the stops): a node at its own stop; text with the
 * node or arrow that holds it; an arrow once both its ends are there (an end that is not new is there already); something of a group with the group's
 * node; anything else (a free note, a line, an unbound arrow) with the nearest new node. A node the stops do not name (a stop replaced by a later change)
 * appears at once. Never before the batch, never later than REVEAL_CAP_MS after it.
 */
export function elementTimes(held: Held, els: ReadonlyMap<string, RevealEl>, nodeAt: ReadonlyMap<string, number>): Map<string, number> {
  const mine = new Set(held.ids);
  const cap = held.at + REVEAL_CAP_MS;
  const memo = new Map<string, number>();
  const nodes = held.ids.map((id) => els.get(id)).filter((e): e is RevealEl => !!e && !e.isDeleted && !NOT_NODE.has(e.type));
  const timed = nodes.filter((n) => nodeAt.has(n.id));
  const nearest = (e: RevealEl): number => {
    const c = centre(e);
    let best = held.at;
    let d = Infinity;
    for (const n of timed) {
      const m = centre(n);
      const dd = Math.hypot(m.x - c.x, m.y - c.y);
      if (dd < d) [d, best] = [dd, nodeAt.get(n.id)!];
    }
    return best;
  };
  const of = (id: string | undefined, depth = 0): number => {
    if (!id || !mine.has(id) || depth > 4) return held.at;
    const hit = memo.get(id);
    if (hit != null) return hit;
    const e = els.get(id);
    let t = held.at;
    if (e && !e.isDeleted) {
      if (!NOT_NODE.has(e.type)) t = nodeAt.get(id) ?? held.at;
      else if (e.containerId) t = of(e.containerId, depth + 1);
      else if (e.startBinding?.elementId || e.endBinding?.elementId) t = Math.max(of(e.startBinding?.elementId, depth + 1), of(e.endBinding?.elementId, depth + 1));
      else {
        const group = e.groupIds?.length ? timed.filter((n) => n.groupIds?.some((g) => e.groupIds!.includes(g))) : [];
        t = group.length ? Math.max(...group.map((n) => nodeAt.get(n.id)!)) : nearest(e);
      }
    }
    t = Math.min(cap, Math.max(held.at, t));
    memo.set(id, t);
    return t;
  };
  return new Map(held.ids.map((id) => [id, of(id)]));
}

/** When each node appears: at the first stop that reveals it. */
export function nodeTimes(stops: readonly RevealStop[], timeOf: (s: RevealStop) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of stops) {
    const t = timeOf(s);
    for (const id of s.nodes) if (!out.has(id)) out.set(id, t);
  }
  return out;
}

/** Is a batch held back at all: not with reduced motion or with the figures off (nobody walks to it), not a small batch, not one that is a single station. */
export function holds(o: { count: number; stations: number; reduced: boolean; figures: boolean }): boolean {
  return !o.reduced && o.figures && o.count >= REVEAL_MIN && o.stations >= 2;
}

/** The distinct moments a batch's elements appear at after it was applied (its stations, as the page shows them). */
export const stationsOf = (times: ReadonlyMap<string, number>, at: number): number[] => [...new Set([...times.values()].filter((t) => t > at))].sort((a, b) => a - b);

// ——— a station is drawn, not faded ———
// When the figure gets to a station, what it draws there is drawn in the order a hand would: each box's outline is traced (from its top-left, clockwise:
// the way Excalidraw's path goes), then its fill fades in, then its text; the boxes one after another, a little apart. Then the lines: each arrow from its
// start point along its path to its end, its head as the stroke gets there, its label after — only once every box of the station has its outline, so an
// arrow never reaches a box that is not there yet (the boxes of earlier stations are). What cannot be traced (an image, a frame, a dashed outline, free
// text) fades in where a box would be traced. The whole station fits in the time the figure stays at its stop: squeezed when that is short, never stretched.

/** What a station item is drawn as: a box's outline then fill and text, a line's stroke then head and label, or a fade. */
export type InkKind = "box" | "line" | "fade";
/** One item's plan (ms after the station's moment): its stroke (or fade) from `start` for `dur`; its fill (a box) or head (a line) from `fill`; its text from `text`. */
export type InkStep = { kind: InkKind; start: number; dur: number; fill: number; text: number };

/** A box's outline, start to end; then its fill, then its text. */
export const BOX_MS = 400;
export const FILL_FADE_MS = 150;
export const TEXT_FADE_MS = 150;
/** The text starts a moment after the fill does. */
const TEXT_AFTER_FILL_MS = 60;
/** A line's stroke, start to end; its head over the last bit of it. */
export const LINE_MS = 350;
export const HEAD_FADE_MS = 80;
/** Between one box (or line) of a station starting and the next; with many the gaps shrink so all have started within the total. */
export const BOX_GAP_MS = 120;
export const BOX_GAP_TOTAL_MS = 300;
export const LINE_GAP_MS = 100;
export const LINE_GAP_TOTAL_MS = 250;
/** A station is never squeezed below this share of its natural length: the strokes would flick. The shortest stop (900 ms of work, the drawing starts 250 ms in) holds a full station (1.45 s) at about this. */
export const MIN_SQUEEZE = 0.45;

const gapOf = (n: number, gap: number, total: number) => (n > 1 ? Math.min(gap, total / (n - 1)) : 0);

/** The plan of a station's items in their order (scene order), fitted into `budget` ms (the rest of the figure's stop) when that is shorter. */
export function inkPlan(kinds: readonly InkKind[], budget = Infinity): { steps: InkStep[]; length: number } {
  const boxes = kinds.filter((k) => k !== "line").length;
  const lines = kinds.length - boxes;
  const gb = gapOf(boxes, BOX_GAP_MS, BOX_GAP_TOTAL_MS);
  const gl = gapOf(lines, LINE_GAP_MS, LINE_GAP_TOTAL_MS);
  const linesFrom = boxes ? (boxes - 1) * gb + BOX_MS : 0;
  let b = 0;
  let l = 0;
  const steps = kinds.map((kind): InkStep => {
    if (kind === "line") {
      const start = linesFrom + l++ * gl;
      return { kind, start, dur: LINE_MS, fill: start + LINE_MS - HEAD_FADE_MS, text: start + LINE_MS };
    }
    const start = b++ * gb;
    return { kind, start, dur: BOX_MS, fill: start + BOX_MS, text: start + BOX_MS + TEXT_AFTER_FILL_MS };
  });
  const length = Math.max(0, ...steps.map((s) => s.text + TEXT_FADE_MS));
  const k = length > budget ? Math.max(MIN_SQUEEZE, budget / length) : 1;
  if (k === 1) return { steps, length };
  return { steps: steps.map((s) => ({ ...s, start: s.start * k, dur: s.dur * k, fill: s.fill * k, text: s.text * k })), length: length * k };
}

/** The longest a station takes (a full one, not squeezed): until then it is still being drawn, not part of the still picture. */
export const REVEAL_SETTLE_MS = Math.max(REVEAL_FADE_MS, BOX_GAP_TOTAL_MS + BOX_MS + LINE_GAP_TOTAL_MS + LINE_MS + TEXT_FADE_MS);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** One item `ms` after its station's moment: how much of its stroke is drawn (0 → 1, eased out; a fade's opacity, linear), how visible its fill (or head) and its text are. */
export function inkAt(s: InkStep, ms: number): { stroke: number; fill: number; text: number } {
  const p = clamp01((ms - s.start) / s.dur);
  const k = s.dur / (s.kind === "line" ? LINE_MS : BOX_MS);
  return {
    stroke: s.kind === "fade" ? p : 1 - (1 - p) * (1 - p),
    fill: clamp01((ms - s.fill) / ((s.kind === "line" ? HEAD_FADE_MS : FILL_FADE_MS) * k)),
    text: clamp01((ms - s.text) / (TEXT_FADE_MS * k)),
  };
}

/** How visible an element appearing at `t` is at `now`: 0 before, fading in over REVEAL_FADE_MS, 1 after. */
export const shownAt = (t: number, now: number): number => (now < t ? 0 : Math.min(1, (now - t) / REVEAL_FADE_MS));
