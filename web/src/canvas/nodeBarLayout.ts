// The node action bar (NodeBar.tsx) layout: every action on the selected node — 代码路径, 子图 — sits in
// one row of pills beside the node, and at most one of their popovers is open. Where the bar and
// its popover go: beside the node, inside the free part of the pane, off the canvas's panels,
// the pointer labels and pins (hard: never cover them when there is any other spot) and, if they
// can, off the drawing (soft). Pure (type-only imports), so it runs under vitest in node.
import { overlaps, placeBeside, type Box } from "./clearance";

export type NodePop = "code" | "child";
/** Which popover of the bar is open. Opening one closes the other; the same pill again closes it. */
export const toggleOpen = (open: NodePop | null, which: NodePop): NodePop | null => (open === which ? null : which);

const area = (p: { x: number; y: number }, w: number, h: number, blocks: readonly Box[]) => {
  let n = 0;
  for (const b of blocks) {
    const dx = Math.min(p.x + w, b.x + b.w + 2) - Math.max(p.x, b.x - 2);
    const dy = Math.min(p.y + h, b.y + b.h + 2) - Math.max(p.y, b.y - 2);
    if (dx > 0 && dy > 0) n += dx * dy;
  }
  return n;
};

const GAP = 8;

/** The bar beside the node (screen box): right first (where it always was), then left, below, above. */
export function placeBar(node: Box, w: number, h: number, hard: readonly Box[], soft: readonly Box[], view: Box): Box & { side: string } {
  const order = ["right", "left", "below", "above"] as const;
  const opts = { gap: GAP, order: [...order] };
  // Clear of everything if possible; else clear of the hard blocks, covering as little drawing as it can.
  const all = placeBeside(node, w, h, [...hard, ...soft], view, opts);
  if (area(all, w, h, hard) === 0) return { ...all, w, h };
  const firm = placeBeside(node, w, h, hard, view, opts);
  return { ...firm, w, h };
}

/**
 * The open popover (`w`×`h`) next to its bar: columns aligned with the bar (left or right edge)
 * or beside the node, at every height in the view (the bar's own under/over lines included).
 * Lowest score wins: covering a hard block (panels, pointer labels, pins, the node, the bar)
 * outweighs everything, then covering the drawing, then the distance from the bar.
 */
export function placePop(bar: Box, node: Box, w: number, h: number, hard: readonly Box[], soft: readonly Box[], view: Box): Box {
  const clampX = (x: number) => Math.max(view.x + 4, Math.min(view.x + view.w - 4 - w, x));
  const clampY = (y: number) => Math.max(view.y + 4, Math.min(view.y + view.h - 4 - h, y));
  const g = 6;
  const xs = [...new Set([bar.x, bar.x + bar.w - w, node.x + node.w + g, node.x - g - w, bar.x + bar.w + g, bar.x - g - w].map(clampX))];
  const ys = new Set([bar.y + bar.h + g, bar.y - g - h, bar.y].map(clampY));
  for (let y = view.y + 4; y <= view.y + view.h - 4 - h; y += 12) ys.add(y);
  const firm = [...hard, node, bar];
  const want = { x: bar.x, y: bar.y + bar.h + g };
  let best: { x: number; y: number; score: number } | null = null;
  for (const x of xs)
    for (const y of ys) {
      const p = { x, y };
      const score = area(p, w, h, firm) * 1e6 + area(p, w, h, soft) + Math.hypot(x - want.x, y - want.y) * 20;
      if (!best || score < best.score) best = { ...p, score };
    }
  return { x: best!.x, y: best!.y, w, h };
}

/** Two placed boxes collide (for tests and sanity checks). */
export const collide = (a: Box, b: Box) => overlaps(a, b);
