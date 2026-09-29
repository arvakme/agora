// The follow camera of a played turn (web/docs/workstation.md §11 按轮追踪): the view that shows the figure, the node
// it is going to and the room its head and bubble take, near 100 % and not below 70 % — and whether
// the camera has to move at all (a dead zone: while the figure stays near the middle it does not).
// Pure; ./replayView.ts moves the canvas toward the view it returns, smoothly.
import type { Box, Fit, Occupied } from "./replayFit";

export type FollowIn = {
  pane: { w: number; h: number };
  /** What covers the pane's edges (the toolbar and the bar at the top). */
  occupied: Occupied;
  margin: number;
  /** Where the figure stands (its feet, scene coordinates). */
  figure: { x: number; y: number };
  /** The node it is going to (scene), if any. */
  node: Box | null;
  /** Screen px the figure needs around its feet: above (head and bubble), to each side (the bubble), below. */
  room: { up: number; side: number; down: number };
  zoom: { preferred: number; min: number; max: number };
  /** The view now; null: none yet (the camera moves). */
  current: Fit | null;
  /** The dead zone: the figure may wander within the middle (1 − 2 × this) of the free area before the camera follows. */
  dead: number;
};

/** The view to move to, and whether to move (false: what is on screen is fine as it is). */
export function followView(o: FollowIn): { view: Fit; move: boolean } {
  const F = { x0: o.occupied.left + o.margin, x1: o.pane.w - o.occupied.right - o.margin, y0: o.occupied.top + o.margin, y1: o.pane.h - o.occupied.bottom - o.margin };
  const fw = Math.max(1, F.x1 - F.x0);
  const fh = Math.max(1, F.y1 - F.y0);
  const { figure: p, node: n, room } = o;
  /** The screen extents round the figure that must show, at zoom z. */
  const ext = (z: number) => {
    const nl = n ? (n.x - p.x) * z : 0;
    const nr = n ? (n.x + n.w - p.x) * z : 0;
    const nt = n ? (n.y - p.y) * z : 0;
    const nb = n ? (n.y + n.h - p.y) * z : 0;
    return { L: n ? Math.min(-room.side, nl) : -room.side, R: n ? Math.max(room.side, nr) : room.side, T: n ? Math.min(-room.up, nt) : -room.up, B: n ? Math.max(room.down, nb) : room.down };
  };
  const fits = (z: number) => {
    const e = ext(z);
    return e.R - e.L <= fw && e.B - e.T <= fh;
  };
  const zmax = Math.max(o.zoom.min, o.zoom.max);
  let z = Math.max(o.zoom.min, Math.min(o.zoom.preferred, zmax));
  while (z > o.zoom.min && !fits(z)) z = Math.max(o.zoom.min, z - 0.01);
  const e = ext(z);
  // the union centred in the free area; when it is too big for it (the floor), the figure and its room stay inside
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
  const sxc = clamp((F.x0 + F.x1) / 2 - (e.L + e.R) / 2, F.x0 + room.side, F.x1 - room.side);
  const syc = clamp((F.y0 + F.y1) / 2 - (e.T + e.B) / 2, F.y0 + room.up, F.y1 - room.down);
  const view: Fit = { zoom: z, scrollX: sxc / z - p.x, scrollY: syc / z - p.y };
  if (!o.current) return { view, move: true };
  const c = o.current;
  const s = { x: (p.x + c.scrollX) * c.zoom, y: (p.y + c.scrollY) * c.zoom };
  const ce = ext(c.zoom);
  const inside = s.x + ce.L >= F.x0 - 1e-6 && s.x + ce.R <= F.x1 + 1e-6 && s.y + ce.T >= F.y0 - 1e-6 && s.y + ce.B <= F.y1 + 1e-6;
  const ix0 = F.x0 + o.dead * fw;
  const ix1 = F.x1 - o.dead * fw;
  const iy0 = F.y0 + o.dead * fh;
  const iy1 = F.y1 - o.dead * fh;
  const calm = s.x >= ix0 && s.x <= ix1 && s.y >= iy0 && s.y <= iy1;
  return { view, move: !(inside && calm && Math.abs(c.zoom - z) < 0.08) };
}

/**
 * What of the diagram to frame with a figure that stands outside it (at the tray, off the edge of the drawing): the piece of it nearest to the figure, so the
 * shot shows where the work will land and not one lonely node or bare canvas — `reach` world units either way from the nearest point of the drawing's bounds.
 * null when the figure is inside the drawing or there is no drawing. Pure.
 */
export function trayShotBox(figure: { x: number; y: number }, bounds: Box | null, reach = 360): Box | null {
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;
  const inside = figure.x >= bounds.x && figure.x <= bounds.x + bounds.w && figure.y >= bounds.y && figure.y <= bounds.y + bounds.h;
  if (inside) return null;
  const qx = Math.max(bounds.x, Math.min(bounds.x + bounds.w, figure.x));
  const qy = Math.max(bounds.y, Math.min(bounds.y + bounds.h, figure.y));
  const x0 = Math.max(bounds.x, qx - reach);
  const x1 = Math.min(bounds.x + bounds.w, qx + reach);
  const y0 = Math.max(bounds.y, qy - reach);
  const y1 = Math.min(bounds.y + bounds.h, qy + reach);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
