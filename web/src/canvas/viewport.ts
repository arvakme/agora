// The live view of each canvas (scroll, zoom, size), written straight from Excalidraw's onChange and
// onScrollChange — before React hears about it — so the 工位视图's frame loop can move its one
// world transform in the same frame the diagram moves. Reading it never renders anything.
export type Viewport = { scrollX: number; scrollY: number; zoom: number; width: number; height: number };

const views = new Map<string, Viewport>();
export const viewport = {
  get: (canvasId: string) => views.get(canvasId),
  set(canvasId: string, v: Viewport) {
    const o = views.get(canvasId);
    if (o && o.scrollX === v.scrollX && o.scrollY === v.scrollY && o.zoom === v.zoom && o.width === v.width && o.height === v.height) return;
    views.set(canvasId, v);
  },
  drop: (canvasId: string) => void views.delete(canvasId),
};
/** Scene → screen (the canvas pane's own coordinates). */
export const toScreen = (v: Viewport, x: number, y: number) => ({ x: (x + v.scrollX) * v.zoom, y: (y + v.scrollY) * v.zoom });

/**
 * A view for a canvas's first mount, in place of the one it fits itself to (CanvasView): the PR replay's
 * camera (workstation/replayView.ts) puts it there before switching to a sub-diagram, so the picture that
 * fades in is already the right one and the canvas's own fit cannot come after it. Taken once.
 */
const first = new Map<string, (api: import("@excalidraw/excalidraw/types").ExcalidrawImperativeAPI) => void>();
export const firstView = {
  set: (canvasId: string, f: (api: import("@excalidraw/excalidraw/types").ExcalidrawImperativeAPI) => void) => void first.set(canvasId, f),
  take(canvasId: string) {
    const f = first.get(canvasId);
    first.delete(canvasId);
    return f;
  },
  drop: (canvasId: string) => void first.delete(canvasId),
};
