// Keeping the canvas's own overlays (comment pins, the progress pointer's ring and label) off
// the drawing's text and icons. Pure (type-only imports) so it runs under vitest in node.
//
// - footprint: what a node looks like on screen — its box plus its label, library label and
//   group — so a highlight drawn around it never cuts through its caption.
// - freeSpot: the nearest spot for a pin (a square growing up and to the right of its tip)
//   that covers nothing, searched in rings around where it wants to be.
// - placeBeside: where a label goes around a box: the first side with room, in order.
import type { El } from "./scene";

export type Box = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };

const liveEl = (e: El | undefined): e is El => !!e && !e.isDeleted;
const boxOf = (e: El): Box => {
  if (e.type === "arrow" || e.type === "line") {
    const pts = (e as unknown as { points: [number, number][] }).points;
    const xs = pts.map((p) => p[0] + e.x), ys = pts.map((p) => p[1] + e.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: e.x, y: e.y, w: e.width, h: e.height };
};
export const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
export const overlaps = (a: Box, b: Box, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
export const inflate = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });

/** The element plus everything that reads as part of it: bound label, library label, its group. */
export function footprint(el: El, map: Map<string, El>, all: readonly El[] = []): Box {
  let b = boxOf(el);
  const text = el.boundElements?.find((x) => x.type === "text");
  const t = text && map.get(text.id);
  if (liveEl(t)) b = union(b, boxOf(t));
  const lib = (el.customData as { agora?: { library?: string; label?: string } } | undefined)?.agora;
  const label = lib?.library && lib.label ? map.get(lib.label) : undefined;
  if (liveEl(label)) b = union(b, boxOf(label));
  const group = el.groupIds?.at(-1);
  if (group) for (const o of all) if (o !== el && liveEl(o) && o.groupIds?.at(-1) === group && o.type !== "arrow") b = union(b, boxOf(o));
  // A free caption right under or over it (an icon with its name below) reads as part of it too.
  const core = b;
  for (const o of all) {
    if (!liveEl(o) || o.type !== "text" || o.containerId || o === el) continue;
    const t = boxOf(o);
    const cx = t.x + t.w / 2;
    const gapBelow = t.y - (core.y + core.h), gapAbove = core.y - (t.y + t.h);
    if (cx > core.x && cx < core.x + core.w && ((gapBelow >= -2 && gapBelow <= 16) || (gapAbove >= -2 && gapAbove <= 16))) b = union(b, t);
  }
  return b;
}

/** Things an overlay must not cover: nodes, icons (library components and their strokes), images,
 * free text and arrow labels. Arrows, loose lines and frames (big containers) don't count; labels
 * bound inside a shape are covered by the shape. */
export function obstacles(all: readonly El[], map: Map<string, El>, skip: ReadonlySet<string> = new Set()): Box[] {
  const out: Box[] = [];
  for (const e of all) {
    if (!liveEl(e) || skip.has(e.id) || e.type === "arrow" || e.type === "frame" || e.type === "magicframe") continue;
    // A loose line is a connector; lines in a group are strokes of a drawing (a library icon).
    if (e.type === "line" && !e.groupIds?.length) continue;
    if (e.type === "text" && e.containerId) {
      const c = map.get(e.containerId);
      if (liveEl(c) && c.type !== "arrow") continue;
    }
    out.push(boxOf(e));
  }
  return out;
}

/** The pin's square for a tip at `p` (it grows up and to the right). */
export const pinBox = (p: Pt, size: number): Box => ({ x: p.x, y: p.y - size, w: size, h: size });

/**
 * The spot nearest to `want` where a pin of `size` covers no obstacle (with `gap` to spare).
 * Searches rings of 12 directions, one pin size apart, up to `maxRings`; `want` itself when free
 * or when nothing nearby is.
 */
export function freeSpot(want: Pt, size: number, blocks: readonly Box[], { gap = 4, maxRings = 6 }: { gap?: number; maxRings?: number } = {}): Pt {
  const free = (p: Pt) => !blocks.some((b) => overlaps(pinBox(p, size), b, gap));
  if (free(want)) return want;
  for (let r = 1; r <= maxRings; r++) {
    const radius = r * size * 0.75;
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 - Math.PI / 4; // start up-right, where the pin normally sits
      const p = { x: want.x + Math.cos(a) * radius, y: want.y + Math.sin(a) * radius };
      if (!free(p)) continue;
      const d = Math.hypot(p.x - want.x, p.y - want.y) + k * 1e-3; // ties: first direction wins
      if (d < bestD) (best = p), (bestD = d);
    }
    if (best) return best;
  }
  return want;
}

export type Side = "above" | "below" | "right" | "left";

/**
 * Top-left corner for a `w`×`h` label beside `box`: for each side in `order`, the spot nearest
 * to the side's usual alignment (above/below: left-aligned, sliding sideways; right/left:
 * centred, sliding up and down) that stays inside `view` and covers no obstacle. When every side
 * is crowded, the in-view spot that covers the least.
 */
export function placeBeside(box: Box, w: number, h: number, blocks: readonly Box[], view: Box, { gap = 8, order = ["above", "below", "right", "left"] as Side[] } = {}): Pt & { side: Side } {
  const inView = (p: Pt) => p.y >= view.y && p.y + h <= view.y + view.h && p.x >= view.x && p.x + w <= view.x + view.w;
  const covered = (p: Pt) => {
    let area = 0;
    for (const b of blocks) {
      const dx = Math.min(p.x + w, b.x + b.w + 2) - Math.max(p.x, b.x - 2);
      const dy = Math.min(p.y + h, b.y + b.h + 2) - Math.max(p.y, b.y - 2);
      if (dx > 0 && dy > 0) area += dx * dy;
    }
    return area;
  };
  const STEP = 12;
  let best: (Pt & { side: Side; area: number }) | null = null;
  for (const side of order) {
    const base: Pt =
      side === "above" ? { x: box.x, y: box.y - gap - h }
      : side === "below" ? { x: box.x, y: box.y + box.h + gap }
      : side === "right" ? { x: box.x + box.w + gap, y: box.y + box.h / 2 - h / 2 }
      : { x: box.x - gap - w, y: box.y + box.h / 2 - h / 2 };
    // Slide along the side, but keep at least 24px of the label next to the box (it must read as its label).
    const horizontal = side === "above" || side === "below";
    const [lo, hi] = horizontal ? [-(w - 24), box.w - 24] : [-(box.h / 2 + h / 2 - 12), box.h / 2 + h / 2 - 12];
    for (let i = 0; i <= Math.ceil((2 * Math.max(-lo, hi)) / STEP) + 1; i++) {
      const d = (i % 2 ? -1 : 1) * Math.ceil(i / 2) * STEP; // 0, -12, +12, -24, …
      if (d < lo || d > hi) continue;
      const p = horizontal ? { x: base.x + d, y: base.y } : { x: base.x, y: base.y + d };
      if (!inView(p)) continue;
      const area = covered(p);
      if (area === 0) return { ...p, side };
      if (!best || area < best.area) best = { ...p, side, area };
    }
  }
  if (best) return { x: best.x, y: best.y, side: best.side };
  return { x: Math.max(view.x, Math.min(box.x, view.x + view.w - w)), y: box.y - gap - h, side: order[0] };
}
