// Where the 浏览 / 评论 dock sits (bottom, px from the window's bottom). Normally a little above the canvas's bottom edge. When the
// canvas is narrow, Excalidraw goes into its compact layout (a bar at the bottom with the menu and undo, a tool column at the side):
// the dock then sits in that bar's empty middle, not over the diagram and not on the bar's buttons. Pure.

/** Narrow enough for Excalidraw's compact layout (its `.excalidraw--mobile`), or the pane is under ~730 px. */
export const isCompact = (hasMobileClass: boolean, paneWidth: number) => hasMobileClass || paneWidth < 730;

export function dockBottom(o: { paneBottom: number; windowHeight: number; compact: boolean; bar?: { top: number; bottom: number } | null; dockHeight?: number }): number {
  const base = Math.round(o.windowHeight - o.paneBottom);
  if (!o.compact) return base + 14;
  const dh = o.dockHeight ?? 44;
  if (o.bar && o.bar.bottom > o.bar.top) {
    const mid = (o.bar.top + o.bar.bottom) / 2;
    return Math.round(o.windowHeight - mid - dh / 2);
  }
  return base + 72; // the bar is not measurable yet: above its usual height
}
