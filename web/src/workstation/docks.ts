// Where workers stand (web/docs/workstation.md §小人): the prototype's docks along a node's top
// edge, kept clear of the drawing's text and icons (other edges when the top is taken), and the
// 图外 tray beside the diagram. Pure (type-only imports), so it runs under vitest in node.
import type { Box } from "../canvas/clearance";
import type { Pt } from "./rig";

/** Figure units a standing worker takes, around its feet (x along the facing: desk and screen on +x;
 * y up to the head and its ! / ? mark). Docks keep this box clear of the drawing. */
export const FIG_BOX = { x0: -13, x1: 28, y0: -60, y1: 2 };
/** Figure units between two workers standing side by side. */
export const SLOT = 46;
/** Figure units → world at the reference view (100 %: figures are drawn at 1.2×). */
export const REF_K = 1.2;

const hits = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
export const inside = (a: Box, b: Box, pad = 2) => a.x >= b.x - pad && a.y >= b.y - pad && a.x + a.w <= b.x + b.w + pad && a.y + a.h <= b.y + b.h + pad;

/**
 * Where the 图外 tray goes: beside the lowest thing in the drawing (to its right, else its left),
 * like the prototype's, else under the diagram — the first spot where the tray and the figures
 * standing on it (FIG_BOX tall, plus a bubble) clear everything drawn. Never a screen corner.
 */
export function trayBox(obstacles: readonly Box[], figureH = -FIG_BOX.y0 * REF_K): Box {
  const shapes = obstacles.filter((b) => b.w > 0 && b.h > 0);
  if (!shapes.length) return { x: 0, y: 0, w: 200, h: 56 };
  const x0 = Math.min(...shapes.map((b) => b.x));
  const x1 = Math.max(...shapes.map((b) => b.x + b.w));
  const y1 = Math.max(...shapes.map((b) => b.y + b.h));
  const low = shapes.reduce((a, b) => (b.y + b.h > a.y + a.h ? b : a));
  const W = 200;
  const H = 56;
  // beside it, a little lower (the prototype's 图外 next to 支付服务), else under the diagram
  const y = low.y + Math.min(20, Math.max(0, low.h - 30));
  const cands: Box[] = [
    { x: low.x + low.w + 110, y, w: W, h: H },
    { x: low.x - 110 - W, y, w: W, h: H },
    { x: Math.max(x0, x1 - W), y: y1 + figureH + 24, w: W, h: H },
  ];
  // the tray itself and the column its figures stand in (its left part) must be clear
  const clear = (t: Box) => !shapes.some((b) => hits(b, t, 8) || hits(b, { x: t.x, y: t.y - figureH, w: 130, h: figureH }, 2));
  return cands.find(clear) ?? cands[cands.length - 1];
}

/**
 * The spots where workers stand at a node (feet, world coordinates), best first: along its top
 * edge, then beside it (right, left, standing on its bottom line), then under it — only those
 * where a standing figure (FIG_BOX at `k` world units per figure unit) covers no text, icon or
 * other node. The node's own parts (its label, the strokes of an icon) don't count. When fewer are
 * free than asked for, the rest continue along the top edge. Pure.
 */
export function dockSpots(node: Box, obstacles: readonly Box[], k: number, n: number, tray = false): Pt[] {
  const own = (b: Box) => inside(b, node);
  const others = obstacles.filter((b) => !own(b));
  const fig = (p: Pt): Box => ({ x: p.x + FIG_BOX.x0 * k, y: p.y + FIG_BOX.y0 * k, w: (FIG_BOX.x1 - FIG_BOX.x0) * k, h: (FIG_BOX.y1 - FIG_BOX.y0) * k });
  const free = (p: Pt) => !others.some((b) => hits(b, fig(p), 2));
  // the prototype's dockPoint: 24 world px in from the left (30 on the tray), 46 apart — wider only
  // when figures are drawn larger than their spacing (zoomed out)
  const step = Math.max(SLOT, (FIG_BOX.x1 - FIG_BOX.x0 + 4) * k);
  const top: Pt[] = [];
  const left0 = node.x + (tray ? 30 : Math.min(Math.max(24, 13 * k), node.w / 4));
  // along the top edge, and on past its right end by up to two more (the prototype's docks run on
  // regardless; here only while nothing is drawn there)
  for (let x = left0; top.length < 10 && (x + FIG_BOX.x1 * k <= node.x + node.w + 8 * k + 2 * step || !top.length); x += step) top.push({ x, y: node.y });
  const out: Pt[] = top.filter(free);
  if (out.length < n && !tray) {
    const bottom = node.y + node.h;
    for (let i = 0; i < 3; i++) out.push(...[{ x: node.x + node.w + 16 * k + i * step, y: bottom }].filter(free));
    for (let i = 0; i < 3; i++) out.push(...[{ x: node.x - 30 * k - i * step, y: bottom }].filter(free));
    for (let i = 0; i < 4; i++) out.push(...[{ x: left0 + i * step, y: bottom - FIG_BOX.y0 * k + 8 }].filter(free));
  }
  // not enough room anywhere: keep going along the top edge
  for (let x = (out.length ? top[top.length - 1].x : left0 - step) + step; out.length < n; x += step) out.push({ x, y: node.y });
  return out.slice(0, Math.max(n, 1));
}

