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
