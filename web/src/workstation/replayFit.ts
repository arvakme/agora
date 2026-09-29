// PR 回放's camera view and the summary's place (web/docs/workstation.md「PR 回放」). Pure.

export type Box = { x: number; y: number; w: number; h: number };
/** What covers the pane's edges, px from each side (the toolbar and the replay bar at the top). */
export type Occupied = { top: number; right: number; bottom: number; left: number };
export type Fit = { zoom: number; scrollX: number; scrollY: number };

const MIN_ZOOM = 0.05;

/**
 * The view (Excalidraw's: screen = (scene + scroll) × zoom) that shows `bounds` in the part of the pane
 * the toolbar and the bar leave free: a margin at every side, and `above` px more over the top of the
 * content for the figure standing on the top nodes and its bubble. Never zoomed in past `maxZoom`.
 */
export function fitView(o: { pane: { w: number; h: number }; occupied: Occupied; margin: number; above: number; maxZoom: number; bounds: Box }): Fit {
  const x0 = o.occupied.left + o.margin;
  const x1 = o.pane.w - o.occupied.right - o.margin;
  const y0 = o.occupied.top + o.margin + o.above;
  const y1 = o.pane.h - o.occupied.bottom - o.margin;
  const aw = Math.max(1, x1 - x0);
  const ah = Math.max(1, y1 - y0);
  const zoom = Math.max(MIN_ZOOM, Math.min(aw / Math.max(1, o.bounds.w), ah / Math.max(1, o.bounds.h), o.maxZoom));
  const cx = x0 + aw / 2;
  const cy = y0 + ah / 2;
  return { zoom, scrollX: cx / zoom - (o.bounds.x + o.bounds.w / 2), scrollY: cy / zoom - (o.bounds.y + o.bounds.h / 2) };
}

const hit = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Where a badge of `size` goes above `node`: centred if that is clear, else slid along, else a row higher;
 * clear of `obstacles` (connector labels, other nodes), inside `view`. Null when there is no such place.
 */
export function placeBadge(o: { node: Box; size: { w: number; h: number }; obstacles: readonly Box[]; view: Box }): { x: number; y: number } | null {
  const { node, size, view } = o;
  const gap = 6;
  const step = 60;
  for (let row = 0; row < 3; row++) {
    const y = node.y - size.h - gap - row * (size.h + 4);
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const x = node.x + node.w / 2 - size.w / 2 + k * step;
      const b = { x, y, w: size.w, h: size.h };
      if (x < view.x || y < view.y || x + size.w > view.x + view.w || y + size.h > view.y + view.h) continue;
      if (hit(b, node) || o.obstacles.some((ob) => hit(b, ob, 2))) continue;
      return { x, y };
    }
  }
  return null;
}
