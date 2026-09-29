// Where the comment list floats over the canvas, and what a browser remembers about it. Pure: the panel
// (CommentsDrawer.tsx) measures the canvas and asks here. The place is the distance from the canvas's top-right
// corner, so a window that changes size keeps the panel at the same corner.
export type Place = { right: number; top: number };
export type Panel = { place: Place; folded: boolean };
type Store = Pick<Storage, "getItem" | "setItem">;

export const MARGIN = 12;
/** Below the canvas's own top row (toolbar, library button) and the line under it that says who the camera follows. */
export const TOP_CLEAR = 92;
/** Above its bottom row (zoom, the browse / comment dock, help, the compact layout's bottom bar). */
export const BOTTOM_CLEAR = 80;
export const MAX_W = 340;
export const MIN_H = 160;
export const MAX_H = 640;
export const DEFAULT_PLACE: Place = { right: MARGIN, top: TOP_CLEAR };

type Size = { w: number; h: number };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The panel's rectangle in the canvas pane: as wide as MAX_W, narrower when the pane is; as tall as the pane leaves room for. */
export function panelBox(place: Place, pane: Size): { x: number; y: number; w: number; h: number } {
  const w = Math.min(MAX_W, Math.max(0, pane.w - 2 * MARGIN));
  const h = clamp(pane.h - place.top - BOTTOM_CLEAR, MIN_H, MAX_H);
  return { x: pane.w - place.right - w, y: place.top, w, h };
}

/** A place inside the pane (a drag that went too far, a saved place in a window that has since shrunk). */
export function clampPlace(place: Place, pane: Size): Place {
  const w = panelBox(place, pane).w;
  return { right: clamp(place.right, 0, Math.max(0, pane.w - w)), top: clamp(place.top, 0, Math.max(0, pane.h - MIN_H)) };
}

const KEY = "agora.commentsPanel";
const fresh = (): Panel => ({ place: DEFAULT_PLACE, folded: false });
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Per browser (each viewer's own): the page works without it, so nothing here can fail loudly. */
export function loadPanel(store: Store = localStorage): Panel {
  try {
    const v = JSON.parse(store.getItem(KEY) ?? "null") as { place?: { right?: unknown; top?: unknown }; folded?: unknown } | null;
    const right = num(v?.place?.right);
    const top = num(v?.place?.top);
    return right != null && top != null ? { place: { right, top }, folded: v?.folded === true } : fresh();
  } catch {
    return fresh();
  }
}

export function savePanel(p: Panel, store: Store = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private window: this page only */
  }
}
