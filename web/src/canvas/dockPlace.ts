// Where the 浏览 / 评论 dock sits (bottom, px from the window's bottom): level with Excalidraw's own bottom controls (the zoom island in the
// wide layout, the bottom bar's island in the compact one), so the whole row shares one centre line; the dock is as tall as those islands
// (DOCK_H). When the canvas is narrow, Excalidraw goes into its compact layout (a bar at the bottom with the menu and undo, a tool column at the
// side): the dock then sits in that bar's empty middle, not over the diagram and not on the bar's buttons. Pure.

/** The height of the bottom row: Excalidraw's island height, which the dock, 「整张图」 and the help button all take. */
export const DOCK_H = 36;
/** Excalidraw's own gap between its bottom controls and the canvas's edge. */
export const EDGE_GAP = 16;

/** Narrow enough for Excalidraw's compact layout (its `.excalidraw--mobile`), or the pane is under ~730 px. */
export const isCompact = (hasMobileClass: boolean, paneWidth: number) => hasMobileClass || paneWidth < 730;

/** Hundredths of a pixel: Excalidraw's islands sit on fractional positions, and the dock is to match them, not a rounded neighbour. */
const round2 = (n: number) => Math.round(n * 100) / 100;

export function dockBottom(o: { paneBottom: number; windowHeight: number; compact: boolean; island?: { top: number; bottom: number } | null; dockHeight?: number }): number {
  const base = Math.round(o.windowHeight - o.paneBottom);
  const dh = o.dockHeight ?? DOCK_H;
  if (o.island && o.island.bottom > o.island.top) {
    const mid = (o.island.top + o.island.bottom) / 2;
    return round2(o.windowHeight - mid - dh / 2);
  }
  return o.compact ? base + 72 : base + EDGE_GAP; // not measurable yet: where Excalidraw puts them / above the compact bar's usual height
}

/** Between the dock and the session pill beside it. */
export const PILL_GAP = 8;
/** The folded session bar's pill, with its words (status line) / without (the round avatar). */
export const PILL_W = 176;
const PILL_W_MIN = 96;
/** How far the group keeps from the controls either side of it (Excalidraw's zoom / undo, 「整张图」, help). */
const GROUP_MARGIN = 8;

/**
 * The dock and, when the session bar is folded, its pill beside it, as one group centred on the canvas body's middle (`center`, window px): where the dock's middle goes and how wide
 * the pill is. The pill keeps its words while the group fits between the controls either side (`limitLeft`: the right edge of the left ones, `limitRight`: the left edge of the right
 * ones; null = none), otherwise it is the round avatar (DOCK_H wide) — and if even that does not fit, the group slides clear of the controls rather than sit on them. No pill: the dock alone
 * is centred, as ever. Pure.
 */
export function groupPlace(o: { center: number; dockW: number; pill: boolean; limitLeft: number | null; limitRight: number | null }): { dockCx: number; pillW: number } {
  if (!o.pill) return { dockCx: o.center, pillW: 0 };
  const lo = o.limitLeft === null ? -Infinity : o.limitLeft + GROUP_MARGIN;
  const hi = o.limitRight === null ? Infinity : o.limitRight - GROUP_MARGIN;
  const half = Math.min(o.center - lo, hi - o.center); // room either side of the centre
  const words = 2 * half - o.dockW - PILL_GAP; // the widest pill that keeps the group centred
  const pillW = words >= PILL_W_MIN ? Math.min(PILL_W, words) : DOCK_H;
  const w = o.dockW + PILL_GAP + pillW;
  let left = o.center - w / 2;
  if (hi - lo >= w) left = Math.min(Math.max(left, lo), hi - w);
  return { dockCx: round2(left + o.dockW / 2), pillW };
}

/** What App measured for the dock's group (`groupPlace`) and the workspace draws from: the canvas body's middle in window px (null: no canvas on screen), and the pill's width (0: no pill). */
export type DockGroup = { center: number | null; pillW: number };
let group: DockGroup = { center: null, pillW: 0 };
const listeners = new Set<() => void>();
export const dockGroup = {
  get: () => group,
  set(next: DockGroup) {
    if (next.center === group.center && next.pillW === group.pillW) return;
    group = next;
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
};
