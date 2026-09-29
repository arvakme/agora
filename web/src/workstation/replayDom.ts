// What covers the top and bottom of the canvas pane while a turn plays, measured from the DOM (the
// toolbar, the breadcrumb, the replay bar, Excalidraw's footer): the camera fits a sub-diagram to what is
// left (./replayFit.ts) and the summary badge stays out from under them.
import type { Occupied } from "./replayFit";

/** The visible pane's Excalidraw container (its size is the view's size). */
export const excalidrawEl = () => document.querySelector<HTMLElement>('[data-pane]:not([data-hidden="true"]) .excalidraw') ?? document.querySelector<HTMLElement>(".excalidraw");

/** What covers the top of the pane: Excalidraw's toolbar, the replay bar, the breadcrumb, and the follow status capsule that hangs under the toolbar. */
export const TOP = ".App-menu_top, .ws-play-bar, .nest-crumbs, .ws-follow-status";
export const BOTTOM = ".layer-ui__wrapper__footer";

type R = { top: number; bottom: number; width: number; height: number };
/** The covered px at the top and bottom of a pane (`pane`: its top and bottom edge, screen px) from the rects of what covers it. Pure. */
export function occupiedFrom(pane: { top: number; bottom: number }, topRects: readonly R[], bottomRects: readonly R[]): Occupied {
  let top = 0;
  for (const b of topRects) if (b.width > 0 && b.height > 0) top = Math.max(top, b.bottom - pane.top);
  let bottom = 0;
  for (const b of bottomRects) if (b.width > 0 && b.height > 0) bottom = Math.max(bottom, pane.bottom - b.top);
  return { top: Math.max(0, top), right: 0, bottom: Math.max(0, bottom), left: 0 };
}

/** px covered at the pane's top and bottom, measured against the Excalidraw container `ex`. */
export function occupiedOf(ex: HTMLElement): Occupied {
  const r = ex.getBoundingClientRect();
  const pane = ex.closest<HTMLElement>("[data-pane]") ?? document;
  const rects = (sel: string) => [...pane.querySelectorAll<HTMLElement>(sel)].map((el) => el.getBoundingClientRect());
  return occupiedFrom({ top: r.top, bottom: r.bottom }, rects(TOP), rects(BOTTOM));
}
