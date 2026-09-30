// Where a stop's note (「第 2 站 · 在子图「…」里」) goes on the canvas. It used to sit just inside its node, over the node's own words; it goes outside the node, on the
// nearest side that is empty, or is not drawn (the number stays, the words are in its hover text). Pure; ./Overlay.tsx asks it when the marks are made.
import type { Box } from "../canvas/clearance";

/** Gap (screen px) between the pill and the node's edge, and between two pills. */
const GAP = 4;

/** The pill's size in screen px for `text`: about 11 px a character (the note is CJK), 6 px padding each side, one line, at most 240 wide. */
export const pillSize = (text: string): { w: number; h: number } => ({ w: Math.min(240, 12 + Math.ceil(text.length * 10.5)), h: 16 });

const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The pill's offset from the stop's number (which sits at the node's top-left corner, world coordinates), in screen px — or null when no side is free.
 * `node`, `obstacles` (other nodes and labels), `taken` (pills already placed) are world boxes; `zoom` converts. Sides, in order: over the node's top edge (not when a
 * figure stands there: `figureAtTop`), beside its right edge, under its bottom edge. A candidate must be clear of every obstacle and pill and inside `view`.
 */
export function pillSpot(o: { node: Box; text: string; zoom: number; obstacles: readonly Box[]; taken: readonly Box[]; view: Box; figureAtTop?: boolean }): { dx: number; dy: number; box: Box } | null {
  const { node, zoom: z } = o;
  const { w, h } = pillSize(o.text);
  const ww = w / z;
  const hh = h / z;
  const g = GAP / z;
  const cands: { x: number; y: number }[] = [];
  if (!o.figureAtTop) cands.push({ x: node.x + 18 / z, y: node.y - hh - g });
  cands.push({ x: node.x + node.w + g, y: node.y });
  cands.push({ x: node.x + 18 / z, y: node.y + node.h + g });
  for (const c of cands) {
    const box = { x: c.x, y: c.y, w: ww, h: hh };
    const pad = GAP / z; // keeps clear of a label by a hair, not just short of touching it
    const clear = (b: Box) => !hit(box, { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad });
    if (box.x < o.view.x || box.y < o.view.y || box.x + box.w > o.view.x + o.view.w || box.y + box.h > o.view.y + o.view.h) continue;
    // the node itself is not an obstacle to a candidate that is outside it; every other box is
    if (o.obstacles.every((b) => (b.x === node.x && b.y === node.y && b.w === node.w && b.h === node.h) || clear(b)) && o.taken.every(clear)) return { dx: (c.x - node.x) * z, dy: (c.y - node.y) * z, box };
  }
  return null;
}
