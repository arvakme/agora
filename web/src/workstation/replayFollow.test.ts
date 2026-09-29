// The follow camera of a played turn (web/docs/workstation.md §11 按轮追踪): the view that shows the figure, the node
// it is going to and its bubble, near 100 % and never below 70 % — with a dead zone, so the camera
// does not move while the figure stays near the middle. Pure: `followView`.
import { describe, expect, it } from "vitest";
import { trayShotBox, followView, type FollowIn } from "./replayFollow.ts";

const base: FollowIn = {
  pane: { w: 1200, h: 800 },
  occupied: { top: 110, right: 0, bottom: 60, left: 0 },
  margin: 24,
  figure: { x: 500, y: 400 },
  node: { x: 450, y: 420, w: 200, h: 90 },
  room: { up: 120, side: 170, down: 20 },
  zoom: { preferred: 1, min: 0.7, max: 1.25 },
  current: null,
  dead: 0.18,
};
/** Where a world point lands on screen under a view. */
const at = (v: { zoom: number; scrollX: number; scrollY: number }, x: number, y: number) => ({ x: (x + v.scrollX) * v.zoom, y: (y + v.scrollY) * v.zoom });
const free = { x0: 24, x1: 1200 - 24, y0: 110 + 24, y1: 800 - 60 - 24 };

describe("followView: the figure, its target and its bubble, big and readable", () => {
  it("is at 100 % when they are close, and centres them in the free part of the pane", () => {
    const { view } = followView(base);
    expect(view.zoom).toBe(1);
    const f = at(view, 500, 400);
    expect(f.x).toBeGreaterThan(free.x0 + 170 - 1e-6);
    expect(f.x).toBeLessThan(free.x1 - 170 + 1e-6);
    // the bubble's room above the figure is under the toolbar and the bar
    expect(f.y - 120).toBeGreaterThanOrEqual(free.y0 - 1e-6);
    // the target node is on screen too
    const n = at(view, 450, 420);
    const n2 = at(view, 650, 510);
    expect(n.x).toBeGreaterThanOrEqual(free.x0 - 1e-6);
    expect(n2.x).toBeLessThanOrEqual(free.x1 + 1e-6);
    expect(n2.y).toBeLessThanOrEqual(free.y1 + 1e-6);
  });
  it("zooms out to fit a far target, but not below 70 %", () => {
    const far = { ...base, node: { x: 1500, y: 420, w: 200, h: 90 } };
    const { view } = followView(far);
    expect(view.zoom).toBeLessThan(1);
    expect(view.zoom).toBeGreaterThanOrEqual(0.7 - 1e-9);
    const n2 = at(view, 1700, 510);
    expect(n2.x).toBeLessThanOrEqual(free.x1 + 1e-6);
    expect(at(view, 500, 400).x - 170).toBeGreaterThanOrEqual(free.x0 - 1e-6);
  });
  it("at the floor the figure still stays in view when the target cannot", () => {
    const veryFar = { ...base, node: { x: 4000, y: 420, w: 200, h: 90 } };
    const { view } = followView(veryFar);
    expect(view.zoom).toBeCloseTo(0.7, 9);
    const f = at(view, 500, 400);
    expect(f.x).toBeGreaterThanOrEqual(free.x0);
    expect(f.x).toBeLessThanOrEqual(free.x1);
    expect(f.y).toBeGreaterThanOrEqual(free.y0);
    expect(f.y).toBeLessThanOrEqual(free.y1);
  });
  it("without a target node it is the figure alone; a preferred zoom over the maximum is held to it", () => {
    const { view } = followView({ ...base, node: null, zoom: { preferred: 3, min: 0.7, max: 1.25 } });
    expect(view.zoom).toBe(1.25);
  });
  it("a bubble higher than the free part allows makes it zoom out (down to the floor), not run under the toolbar", () => {
    const tall = { ...base, pane: { w: 1200, h: 420 }, room: { up: 200, side: 170, down: 20 } };
    const { view } = followView(tall);
    expect(view.zoom).toBeLessThanOrEqual(1);
    expect(view.zoom).toBeGreaterThanOrEqual(0.7 - 1e-9);
  });
  it("is finite even in a pane with nothing free", () => {
    const { view } = followView({ ...base, pane: { w: 100, h: 100 }, occupied: { top: 90, right: 0, bottom: 90, left: 0 } });
    for (const n of [view.zoom, view.scrollX, view.scrollY]) expect(Number.isFinite(n)).toBe(true);
  });
});

describe("dead zone: the camera stays put while the figure stays near the middle", () => {
  const ideal = followView(base).view;
  it("no move when the figure and its target are well inside the dead zone", () => {
    const r = followView({ ...base, current: ideal, figure: { x: 520, y: 405 }, node: { x: 470, y: 425, w: 200, h: 90 } });
    expect(r.move).toBe(false);
  });
  it("moves once the figure gets near an edge", () => {
    const r = followView({ ...base, current: ideal, figure: { x: 500 + 420, y: 400 } });
    expect(r.move).toBe(true);
  });
  it("moves when the zoom is not where it should be (a far target is gone: back to 100 %)", () => {
    const r = followView({ ...base, current: { ...ideal, zoom: 0.75 } });
    expect(r.move).toBe(true);
  });
  it("moves when there is no current view yet", () => {
    expect(followView({ ...base, current: null }).move).toBe(true);
  });
});

describe("FX2a · #7/#10: a figure at the tray outside the drawing is framed with the piece of the drawing nearest to it", () => {
  const bounds = { x: 0, y: 0, w: 2400, h: 1600 };
  it("the tray above the drawing: the strip of the drawing under it, not one node or bare canvas; none when it stands inside, or there is no drawing", () => {
    const b = trayShotBox({ x: 800, y: -120 }, bounds)!;
    expect(b).toEqual({ x: 440, y: 0, w: 720, h: 360 });
    expect(trayShotBox({ x: 800, y: 300 }, bounds)).toBeNull();
    expect(trayShotBox({ x: 800, y: -120 }, null)).toBeNull();
    expect(trayShotBox({ x: 800, y: -120 }, { x: 0, y: 0, w: 0, h: 0 })).toBeNull();
  });
  it("the corner: the tray off the top-left corner is framed with the corner", () => {
    expect(trayShotBox({ x: -200, y: -200 }, bounds)).toEqual({ x: 0, y: 0, w: 360, h: 360 });
  });
  it("the shot with it shows the top of the drawing next to the figure (and holds the figure in when it does not all fit at 0.7)", () => {
    const fig = { x: 800, y: -120 };
    const node = trayShotBox(fig, bounds)!;
    const out = followView({ ...base, figure: fig, node, current: null });
    const z = out.view.zoom;
    const screenY = (y: number) => (y + out.view.scrollY) * z;
    const screenX = (x: number) => (x + out.view.scrollX) * z;
    expect(z).toBeGreaterThanOrEqual(0.7);
    expect(screenY(0)).toBeGreaterThan(base.occupied.top); // the drawing's top edge is in view under the toolbar
    expect(screenY(fig.y)).toBeGreaterThan(base.occupied.top); // and so is the figure
    expect(screenX(fig.x)).toBeGreaterThan(0);
    expect(screenX(fig.x)).toBeLessThan(base.pane.w);
  });
});
