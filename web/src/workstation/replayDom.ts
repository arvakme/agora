// What covers the canvas pane while a turn plays, measured from the DOM: the bars along its top and bottom (the toolbar, the breadcrumb, the
// replay bar, Excalidraw's footer) and any rectangle floating over it (the session panel, the comment list, their capsules: `FLOATS`). The camera
// fits a sub-diagram to what is left (./replayFit.ts, ./occupied.ts: the largest free rectangle) and the summary badge stays out from under them.
import { occupiedWith } from "./occupied";
import type { Occupied } from "./replayFit";

/** The visible pane's Excalidraw container (its size is the view's size). */
export const excalidrawEl = () => document.querySelector<HTMLElement>('[data-pane]:not([data-hidden="true"]) .excalidraw') ?? document.querySelector<HTMLElement>(".excalidraw");

/** What covers the top of the pane: Excalidraw's toolbar, the replay bar, the breadcrumb, and the follow status capsule that hangs under the toolbar. */
export const TOP = ".App-menu_top, .ws-play-bar, .nest-crumbs, .ws-follow-status";
export const BOTTOM = ".layer-ui__wrapper__footer";
/** What floats over the pane (app/floatShell.ts): a floating shell's panel or its capsule, in any of the panes. */
export const FLOATS = "[data-float-shell]";

type R = { top: number; bottom: number; width: number; height: number };
type FR = R & { left: number };
/**
 * The covered px at each edge of a pane (`pane`: its edges, screen px) from the rects of what covers it: the bars at its top and bottom, and the rectangles
 * floating over it (`floats`, which need the pane's `left` / `right`). The bars count as they always did; floats are cut to the pane and the camera gets
 * the largest free rectangle that is left (./occupied.ts). Pure.
 */
export function occupiedFrom(pane: { top: number; bottom: number; left?: number; right?: number }, topRects: readonly R[], bottomRects: readonly R[], floats: readonly FR[] = []): Occupied {
  let top = 0;
  for (const b of topRects) if (b.width > 0 && b.height > 0) top = Math.max(top, b.bottom - pane.top);
  let bottom = 0;
  for (const b of bottomRects) if (b.width > 0 && b.height > 0) bottom = Math.max(bottom, pane.bottom - b.top);
  const bars = { top: Math.max(0, top), bottom: Math.max(0, bottom) };
  if (!floats.length || pane.left === undefined || pane.right === undefined) return { ...bars, right: 0, left: 0 };
  const p = { x: pane.left, y: pane.top, w: pane.right - pane.left, h: pane.bottom - pane.top };
  return occupiedWith(p, bars, floats.map((b) => ({ x: b.left, y: b.top, w: b.width, h: b.height })));
}

/** px covered at each edge of the pane, measured against the Excalidraw container `ex`. */
export function occupiedOf(ex: HTMLElement): Occupied {
  const r = ex.getBoundingClientRect();
  const pane = ex.closest<HTMLElement>("[data-pane]") ?? document;
  const rects = (sel: string, root: ParentNode = pane) => [...root.querySelectorAll<HTMLElement>(sel)].map((el) => el.getBoundingClientRect());
  // a floating shell is not inside the canvas's pane: look in the whole page (a shell that floats in this pane is found too)
  return occupiedFrom({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }, rects(TOP), rects(BOTTOM), rects(FLOATS, document));
}
