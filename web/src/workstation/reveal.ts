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
// When the figure gets to a station, what it draws there is drawn in the order a hand would. A station is a row of units, in scene order: an element on
// its own, or a group (a library component, an icon of many lines: the outermost group) drawn as one. A unit's strokes are traced (a box from its
// top-left, clockwise: the way Excalidraw's path goes; a line from its start point to its end; a component's elements one after another, overlapping,
// in their order), then its fill fades in, then its text is written (wiped on, left to right, line by line). What has no stroke to follow (an image, a
// shape filled but not outlined) is wiped on in its stroke's time. The units one after another, a little apart; the lines that are units of their own
// (an arrow between boxes) only once every other unit of the station has its strokes, so an arrow never reaches a box that is not there yet (the boxes
// of earlier stations are). The whole station fits in the time the figure stays at its stop: squeezed when that is short, never stretched.

/** What a unit is drawn as: a box (an element's outline, then fill and text), a group (a component's strokes, then fills and text), a line (its stroke,
 * head, label), a text (written), or a fade (nothing it holds could be drawn). */
export type InkKind = "box" | "group" | "line" | "text" | "fade";
/** One unit's plan (ms after the station's moment): its strokes from `start` for `dur`; its fill (a box, a group) or head (a line) from `fill`; its text written from `text` for `textDur`. */
export type InkStep = { kind: InkKind; start: number; dur: number; fill: number; text: number; textDur: number };

/** A box's outline, start to end; then its fill, then its text. */
export const BOX_MS = 400;
/** A component's strokes, all of them, however many it has (its elements overlap: each is drawn over part of this). */
export const GROUP_MS = 600;
export const FILL_FADE_MS = 150;
/** A label or a box's text, written. */
export const TEXT_MS = 200;
/** A text on its own, written (it is a unit: there is nothing to wait for). */
export const TEXT_WRITE_MS = 300;
/** The text starts a moment after the fill does. */
const TEXT_AFTER_FILL_MS = 60;
/** A line's stroke, start to end; its head over the last bit of it. */
export const LINE_MS = 350;
export const HEAD_FADE_MS = 80;
/** Between one unit (or line) of a station starting and the next; with many the gaps shrink so all have started within the total. */
export const BOX_GAP_MS = 120;
export const BOX_GAP_TOTAL_MS = 300;
export const LINE_GAP_MS = 100;
export const LINE_GAP_TOTAL_MS = 250;
/** A station is never squeezed below this share of its natural length: the strokes would flick. */
export const MIN_SQUEEZE = 0.45;

/** What inkUnits reads of an element. */
export type InkEl = Pick<RevealEl, "id" | "type" | "containerId" | "groupIds">;
/** One unit of a station: its elements (in scene order; text bound to one of them goes with it, not here). */
export type InkUnit = { kind: InkKind; ids: string[] };

const BOXY = new Set(["rectangle", "ellipse", "diamond", "frame", "magicframe", "image", "freedraw", "embeddable", "iframe"]);

/** A station's elements (scene order) as the units it is drawn in: each outermost group one unit, every other element one of its own; a text bound to an element of the station goes with that element. */
export function inkUnits(els: readonly InkEl[]): InkUnit[] {
  const here = new Set(els.map((e) => e.id));
  const by = new Map<string, InkUnit>();
  for (const e of els) {
    if (e.type === "text" && e.containerId && here.has(e.containerId)) continue;
    const key = e.groupIds?.length ? `g:${e.groupIds[e.groupIds.length - 1]}` : e.id;
    const u = by.get(key) ?? by.set(key, { kind: "fade", ids: [] }).get(key)!;
    u.ids.push(e.id);
  }
  const type = new Map(els.map((e) => [e.id, e.type]));
  for (const u of by.values()) {
    const t = type.get(u.ids[0])!;
    u.kind = u.ids.length > 1 ? "group" : t === "line" || t === "arrow" ? "line" : t === "text" ? "text" : BOXY.has(t) ? "box" : "fade";
  }
  return [...by.values()];
}

/**
 * Where each element of a unit is drawn within the unit's strokes (0 → 1 of them), from how much each has to draw (`lengths`, in order): one after
 * another by length, overlapping — each over a share of the whole (all of it for one; less the more there are, never under a quarter), so a component of
 * a hundred lines is drawn in the same time as one of three, every stroke still seen moving.
 */
export function unitWindows(lengths: readonly number[]): [number, number][] {
  const n = lengths.length;
  if (n <= 1) return n ? [[0, 1]] : [];
  const w = Math.max(0.25, 1 / Math.sqrt(n));
  const ls = lengths.map((l) => Math.max(1, l));
  const total = ls.reduce((a, b) => a + b, 0);
  let at = 0;
  return ls.map((l) => {
    const from = (at / total) * (1 - w);
    at += l;
    return [from, from + w];
  });
}

const gapOf = (n: number, gap: number, total: number) => (n > 1 ? Math.min(gap, total / (n - 1)) : 0);
const STROKE_MS: Record<InkKind, number> = { box: BOX_MS, group: GROUP_MS, line: LINE_MS, text: TEXT_WRITE_MS, fade: BOX_MS };

/** The plan of a station's units in their order (scene order), fitted into `budget` ms (the rest of the figure's stop) when that is shorter. */
export function inkPlan(kinds: readonly InkKind[], budget = Infinity): { steps: InkStep[]; length: number } {
  const units = kinds.filter((k) => k !== "line").length;
  const lines = kinds.length - units;
  const gb = gapOf(units, BOX_GAP_MS, BOX_GAP_TOTAL_MS);
  const gl = gapOf(lines, LINE_GAP_MS, LINE_GAP_TOTAL_MS);
  let b = 0;
  const first = kinds.map((kind): InkStep | null => {
    if (kind === "line") return null;
    const start = b++ * gb;
    const dur = STROKE_MS[kind];
    if (kind === "text") return { kind, start, dur, fill: start + dur, text: start, textDur: dur };
    return { kind, start, dur, fill: start + dur, text: start + dur + TEXT_AFTER_FILL_MS, textDur: TEXT_MS };
  });
  const linesFrom = Math.max(0, ...first.map((s) => (s ? s.start + s.dur : 0)));
  let l = 0;
  const steps = kinds.map((kind, i): InkStep => {
    if (first[i]) return first[i]!;
    const start = linesFrom + l++ * gl;
    return { kind, start, dur: LINE_MS, fill: start + LINE_MS - HEAD_FADE_MS, text: start + LINE_MS, textDur: TEXT_MS };
  });
  const length = Math.max(0, ...steps.map((s) => Math.max(s.text + s.textDur, s.fill + FILL_FADE_MS)));
  const k = length > budget ? Math.max(MIN_SQUEEZE, budget / length) : 1;
  if (k === 1) return { steps, length };
  return { steps: steps.map((s) => ({ ...s, start: s.start * k, dur: s.dur * k, fill: s.fill * k, text: s.text * k, textDur: s.textDur * k })), length: length * k };
}

/** The longest a station takes (a full one, not squeezed): until then it is still being drawn, not part of the still picture. */
export const REVEAL_SETTLE_MS = Math.max(REVEAL_FADE_MS, BOX_GAP_TOTAL_MS + GROUP_MS + LINE_GAP_TOTAL_MS + LINE_MS + TEXT_MS);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** One unit `ms` after its station's moment: how much of its strokes are drawn (0 → 1, eased out; a fade's opacity, linear), how visible its fill (or head) is, how much of its text is written. */
export function inkAt(s: InkStep, ms: number): { stroke: number; fill: number; text: number } {
  const p = clamp01((ms - s.start) / s.dur);
  const k = s.dur / STROKE_MS[s.kind];
  return {
    stroke: s.kind === "fade" ? p : 1 - (1 - p) * (1 - p),
    fill: clamp01((ms - s.fill) / ((s.kind === "line" ? HEAD_FADE_MS : FILL_FADE_MS) * k)),
    text: clamp01((ms - s.text) / s.textDur),
  };
}

/** How visible an element appearing at `t` is at `now`: 0 before, fading in over REVEAL_FADE_MS, 1 after. */
export const shownAt = (t: number, now: number): number => (now < t ? 0 : Math.min(1, (now - t) / REVEAL_FADE_MS));
