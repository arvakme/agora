// POL1: a two-finger pinch on one canvas must zoom that canvas only. Excalidraw listens to Safari's gesture events on
// `document`, in every mounted instance, and keeps the pinch's starting zoom in one module-level variable — so with two
// canvases open a pinch on either zoomed both, to the same value.
import { describe, expect, it, vi } from "vitest";
import { createPinchRouter, zoomAt, type PinchApi, type PinchState } from "./pinchRoute";

const fakeCanvas = (init: Partial<PinchState> = {}) => {
  let s: PinchState = { zoom: { value: 1 }, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, ...init };
  const api: PinchApi = {
    getAppState: () => s,
    updateScene: ({ appState }) => void (s = { ...s, ...appState }),
  };
  return { api, get: () => s };
};
const gesture = (type: string, scale: number, at = { x: 300, y: 200 }) => ({ type, scale, clientX: at.x, clientY: at.y, target: null as EventTarget | null, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() });

describe("zoomAt: zoom round a point of the pane", () => {
  it("keeps the scene point under the anchor where it is", () => {
    const s: PinchState = { zoom: { value: 1 }, scrollX: 40, scrollY: -25, offsetLeft: 10, offsetTop: 90 };
    const at = { x: 310, y: 290 };
    const sceneOf = (z: PinchState) => ({ x: (at.x - z.offsetLeft) / z.zoom.value - z.scrollX, y: (at.y - z.offsetTop) / z.zoom.value - z.scrollY });
    const before = sceneOf(s);
    const next = { ...s, ...zoomAt(s, at, 2.5) };
    expect(next.zoom.value).toBe(2.5);
    expect(sceneOf(next).x).toBeCloseTo(before.x, 9);
    expect(sceneOf(next).y).toBeCloseTo(before.y, 9);
  });
  it("holds the zoom to Excalidraw's range", () => {
    const s: PinchState = { zoom: { value: 1 }, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0 };
    expect(zoomAt(s, { x: 0, y: 0 }, 0.001).zoom.value).toBe(0.1);
    expect(zoomAt(s, { x: 0, y: 0 }, 900).zoom.value).toBe(30);
  });
});

describe("pinch routing between canvases", () => {
  const setup = (crowded = true) => {
    const left = fakeCanvas({ scrollX: 295, scrollY: 221 });
    const right = fakeCanvas({ zoom: { value: 0.6 }, scrollX: 375, scrollY: 405 });
    const panes = new Map<unknown, PinchApi>();
    const L = {}, R = {}, OUTSIDE = {};
    panes.set(L, left.api);
    panes.set(R, right.api);
    const route = createPinchRouter((t) => panes.get(t) ?? null, () => crowded);
    const pinch = (on: unknown, scales: number[]) => {
      const evs = [gesture("gesturestart", 1), ...scales.map((s) => gesture("gesturechange", s)), gesture("gestureend", scales.at(-1) ?? 1)];
      for (const e of evs) ((e.target = on as EventTarget), route(e));
      return evs;
    };
    return { left, right, L, R, OUTSIDE, route, pinch };
  };

  it("a pinch on the left canvas zooms the left one and leaves the right one as it was", () => {
    const { left, right, L, pinch } = setup();
    const rightBefore = right.get();
    pinch(L, [1.2, 1.5, 1.8]);
    expect(left.get().zoom.value).toBeCloseTo(1.8, 9);
    expect(right.get()).toEqual(rightBefore);
  });

  it("each pinch starts from the zoom of the canvas it is on, not from the last canvas that was pinched", () => {
    const { left, right, L, R, pinch } = setup();
    pinch(L, [2]);
    pinch(R, [1.5]);
    expect(left.get().zoom.value).toBeCloseTo(2, 9);
    expect(right.get().zoom.value).toBeCloseTo(0.9, 9);
  });

  it("the pinch is taken from Excalidraw's own document listeners (stopped, and the browser's page zoom is prevented)", () => {
    const { L, pinch } = setup();
    for (const e of pinch(L, [1.3])) {
      expect(e.stopImmediatePropagation).toHaveBeenCalled();
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  it("a pinch over something that is not a canvas zooms none of them", () => {
    const { left, right, OUTSIDE, pinch } = setup();
    const before = [left.get(), right.get()];
    const evs = pinch(OUTSIDE, [1.5, 2]);
    expect([left.get(), right.get()]).toEqual(before);
    expect(evs.every((e) => e.stopImmediatePropagation.mock.calls.length === 1)).toBe(true);
  });

  it("with one canvas on the page Excalidraw is left to do it as it always did", () => {
    const { left, L, pinch } = setup(false);
    const evs = pinch(L, [1.5]);
    expect(left.get().zoom.value).toBe(1);
    for (const e of evs) {
      expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });
});
