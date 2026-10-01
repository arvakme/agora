// A two-finger pinch zooms the canvas under the fingers and no other. Excalidraw listens to Safari's gesture events on
// `document` in every mounted instance and keeps the pinch's starting zoom in one module-level variable: with two
// canvases open, a pinch on either zoomed both, to the same value. So while more than one canvas is mounted the
// gestures are taken here (window capture, before those listeners) and applied to the canvas of the pane they are on.
// With one canvas nothing is taken: Excalidraw does it as it always did.
import { canvases } from "../session/ui";

export type PinchState = { zoom: { value: number }; scrollX: number; scrollY: number; offsetLeft: number; offsetTop: number };
export type PinchApi = {
  getAppState: () => PinchState;
  updateScene: (o: { appState: { zoom: { value: number }; scrollX: number; scrollY: number } }) => void;
};
type GestureLike = { type: string; scale?: number; clientX?: number; clientY?: number; target: EventTarget | null; preventDefault: () => void; stopImmediatePropagation: () => void };

/** Excalidraw's zoom range (its `getNormalizedZoom`). */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 30;

/** The view that has `zoom` with the scene point under `at` (screen px) staying under it (Excalidraw's `getStateForZoom`). */
export function zoomAt(s: PinchState, at: { x: number; y: number }, zoom: number) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  const ax = at.x - s.offsetLeft;
  const ay = at.y - s.offsetTop;
  return { zoom: { value: next }, scrollX: s.scrollX + ax / next - ax / s.zoom.value, scrollY: s.scrollY + ay / next - ay / s.zoom.value };
}

/** `pane`: the canvas of the pane an event target is in (none: not over a canvas). `crowded`: more than one canvas is mounted. Returns the handler for gesturestart / gesturechange / gestureend. */
export function createPinchRouter(pane: (target: EventTarget | null) => PinchApi | null, crowded: () => boolean) {
  let on: { api: PinchApi; zoom: number } | null = null;
  let at = { x: 0, y: 0 };
  return (e: GestureLike) => {
    if (!crowded()) return;
    // Excalidraw stops the browser's page zoom for every gesture; that stays
    e.preventDefault();
    e.stopImmediatePropagation();
    if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) at = { x: e.clientX!, y: e.clientY! };
    if (e.type === "gesturestart") {
      const api = pane(e.target);
      on = api && { api, zoom: api.getAppState().zoom.value };
    } else if (e.type === "gesturechange" && on && e.scale) {
      on.api.updateScene({ appState: zoomAt(on.api.getAppState(), at, on.zoom * e.scale) });
    } else if (e.type === "gestureend") on = null;
  };
}

const paneCanvas = (target: EventTarget | null): PinchApi | null => {
  const id = target instanceof Element ? target.closest<HTMLElement>("[data-pane]")?.dataset.pane : undefined;
  // Excalidraw's `updateScene` types the zoom as a branded number: the zoom made here is held to its range by `zoomAt`
  return ((id && canvases.get(id)?.api) as unknown as PinchApi | undefined) ?? null;
};

/** Install once for the page; returns the way out. */
export function installPinchRouting(): () => void {
  const route = createPinchRouter(paneCanvas, () => document.querySelectorAll(".excalidraw").length > 1);
  const types = ["gesturestart", "gesturechange", "gestureend"];
  const on = route as unknown as EventListener;
  for (const t of types) window.addEventListener(t, on, { capture: true, passive: false });
  return () => types.forEach((t) => window.removeEventListener(t, on, { capture: true }));
}
