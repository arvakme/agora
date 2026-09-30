// What covers the canvas pane, as any set of rectangles (web/docs/workstation.md §10, §15): the bars along the top and bottom, a floating session panel or
// comment list, a folded capsule. The camera frames the figure in the largest free rectangle that is left; `Occupied` (what fitView / followView take) is
// how far that rectangle is from each edge of the pane. Pure.
export type Rect = { x: number; y: number; w: number; h: number };
export type Occupied = { top: number; right: number; bottom: number; left: number };

export const rectsOverlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The part of `r` inside `pane`, or null when nothing of it is. */
function cut(r: Rect, pane: Rect): Rect | null {
  const x = Math.max(r.x, pane.x);
  const y = Math.max(r.y, pane.y);
  const w = Math.min(r.x + r.w, pane.x + pane.w) - x;
  const h = Math.min(r.y + r.h, pane.y + pane.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * The largest rectangle of `pane` that none of `covers` touches (the first, top-left one when two are as large): every candidate has its edges on the
 * pane's or a cover's edges, so the search runs over those coordinates. A cover outside the pane or with no size does not count; one sticking out is cut to it.
 * Everything covered gives a rectangle with no area.
 */
export function freeRect(pane: Rect, covers: Rect[]): Rect {
  const cs = covers.map((c) => cut(c, pane)).filter((c): c is Rect => c !== null);
  if (!cs.length) return pane;
  const xs = [...new Set([pane.x, pane.x + pane.w, ...cs.flatMap((c) => [c.x, c.x + c.w])])].sort((a, b) => a - b);
  const ys = [...new Set([pane.y, pane.y + pane.h, ...cs.flatMap((c) => [c.y, c.y + c.h])])].sort((a, b) => a - b);
  let best: Rect = { x: pane.x, y: pane.y, w: 0, h: 0 };
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++)
      for (let k = 0; k < ys.length; k++)
        for (let l = k + 1; l < ys.length; l++) {
          const r = { x: xs[i], y: ys[k], w: xs[j] - xs[i], h: ys[l] - ys[k] };
          if (r.w * r.h > best.w * best.h && !cs.some((c) => rectsOverlap(r, c))) best = r;
        }
  return best;
}

/** The px covered at each edge of the pane: the bars (`top`, `bottom`) together with `rects`, by the largest free rectangle they leave. */
export function occupiedWith(pane: Rect, bars: { top: number; bottom: number }, rects: Rect[]): Occupied {
  const barTop = { x: pane.x, y: pane.y, w: pane.w, h: bars.top };
  const barBottom = { x: pane.x, y: pane.y + pane.h - bars.bottom, w: pane.w, h: bars.bottom };
  const f = freeRect(pane, [barTop, barBottom, ...rects]);
  if (f.w * f.h === 0) return { top: Math.min(bars.top, pane.h), right: 0, bottom: Math.max(0, Math.min(bars.bottom, pane.h - bars.top)), left: 0 };
  return { top: f.y - pane.y, left: f.x - pane.x, right: pane.x + pane.w - (f.x + f.w), bottom: pane.y + pane.h - (f.y + f.h) };
}
