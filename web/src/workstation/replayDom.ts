// What covers the top and bottom of the canvas pane while a turn plays, measured from the DOM (the
// toolbar, the breadcrumb, the replay bar, Excalidraw's footer): the camera fits a sub-diagram to what is
// left (./replayFit.ts) and the summary badge stays out from under them.
import type { Occupied } from "./replayFit";

/** The visible pane's Excalidraw container (its size is the view's size). */
export const excalidrawEl = () => document.querySelector<HTMLElement>('[data-pane]:not([data-hidden="true"]) .excalidraw') ?? document.querySelector<HTMLElement>(".excalidraw");

const TOP = ".App-menu_top, .ws-play-bar, .nest-crumbs";
const BOTTOM = ".layer-ui__wrapper__footer";

/** px covered at the pane's top and bottom, measured against the Excalidraw container `ex`. */
export function occupiedOf(ex: HTMLElement): Occupied {
  const r = ex.getBoundingClientRect();
  const pane = ex.closest<HTMLElement>("[data-pane]") ?? document;
  let top = 0;
  pane.querySelectorAll<HTMLElement>(TOP).forEach((el) => {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) top = Math.max(top, b.bottom - r.top);
  });
  let bottom = 0;
  pane.querySelectorAll<HTMLElement>(BOTTOM).forEach((el) => {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) bottom = Math.max(bottom, r.bottom - b.top);
  });
  return { top: Math.max(0, top), right: 0, bottom: Math.max(0, bottom), left: 0 };
}
