// The camera of a played turn fits a sub-diagram to the pane leaving out what the toolbar and the replay bar cover at
// the top, with room above the top nodes for the figure that stands there and its bubble, and a margin
// at the sides and bottom (`fitView`); and the summary badge finds a spot for itself that does not lie on a
// connector's label (`placeBadge`). Pure.
import { describe, expect, it } from "vitest";
import { fitView, placeBadge } from "./replayFit.ts";

const pane = { w: 1000, h: 700 };
const occ = { top: 110, right: 0, bottom: 60, left: 0 };
/** Where the content's box lands on screen under the view fitView returned. */
const onScreen = (v: { zoom: number; scrollX: number; scrollY: number }, b: { x: number; y: number; w: number; h: number }) => ({
  x0: (b.x + v.scrollX) * v.zoom,
  y0: (b.y + v.scrollY) * v.zoom,
  x1: (b.x + b.w + v.scrollX) * v.zoom,
  y1: (b.y + b.h + v.scrollY) * v.zoom,
});
const opts = { pane, occupied: occ, margin: 24, above: 90, maxZoom: 1 };

describe("fitView", () => {
  it("everything lands inside the free part of the pane: below the toolbar and the bar, with the figure's room above the top nodes", () => {
    const b = { x: 100, y: 200, w: 1600, h: 900 };
    const v = fitView({ ...opts, bounds: b });
    const r = onScreen(v, b);
    expect(r.x0).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(r.x1).toBeLessThanOrEqual(1000 - 24 + 1e-6);
    expect(r.y0).toBeGreaterThanOrEqual(110 + 24 + 90 - 1e-6);
    expect(r.y1).toBeLessThanOrEqual(700 - 60 - 24 + 1e-6);
  });
  it("a small diagram is not blown up (zoom 1 at most) and sits in the middle of the free part", () => {
    const b = { x: 0, y: 0, w: 300, h: 200 };
    const v = fitView({ ...opts, bounds: b });
    expect(v.zoom).toBe(1);
    const r = onScreen(v, b);
    expect((r.x0 + r.x1) / 2).toBeCloseTo(500, 5);
    const free = { top: 110 + 24 + 90, bottom: 700 - 60 - 24 };
    expect((r.y0 + r.y1) / 2).toBeCloseTo((free.top + free.bottom) / 2, 5);
  });
  it("a tall diagram is limited by the free height, a wide one by the width", () => {
    const tall = fitView({ ...opts, bounds: { x: 0, y: 0, w: 200, h: 2000 } });
    expect(tall.zoom).toBeCloseTo((700 - 110 - 60 - 24 * 2 - 90) / 2000, 6);
    const wide = fitView({ ...opts, bounds: { x: 0, y: 0, w: 4000, h: 100 } });
    expect(wide.zoom).toBeCloseTo((1000 - 48) / 4000, 6);
  });
  it("a bar taller than the pane leaves something still: a finite, positive zoom", () => {
    const v = fitView({ ...opts, occupied: { top: 900, right: 0, bottom: 0, left: 0 }, bounds: { x: 0, y: 0, w: 500, h: 500 } });
    expect(v.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(v.scrollY)).toBe(true);
  });
  it("what covers a side (a panel) is left out too", () => {
    const b = { x: 0, y: 0, w: 2000, h: 300 };
    const v = fitView({ ...opts, occupied: { ...occ, left: 200 }, bounds: b });
    expect(onScreen(v, b).x0).toBeGreaterThanOrEqual(200 + 24 - 1e-6);
  });
});

describe("placeBadge: above the node, in the clear", () => {
  const node = { x: 400, y: 300, w: 200, h: 100 };
  const size = { w: 240, h: 26 };
  const view = { x: 0, y: 0, w: 1000, h: 700 };
  it("centred above the node when nothing is there", () => {
    const p = placeBadge({ node, size, obstacles: [], view })!;
    expect(p.x + size.w / 2).toBeCloseTo(500, 5);
    expect(p.y + size.h).toBeLessThanOrEqual(300);
  });
  it("moves off a connector's label lying above the node", () => {
    const label = { x: 430, y: 260, w: 140, h: 24 };
    const p = placeBadge({ node, size, obstacles: [label], view })!;
    const hit = p.x < label.x + label.w && label.x < p.x + size.w && p.y < label.y + label.h && label.y < p.y + size.h;
    expect(hit).toBe(false);
    expect(p.y + size.h).toBeLessThanOrEqual(node.y + 1e-6);
  });
  it("stays on screen", () => {
    const p = placeBadge({ node: { x: 0, y: 40, w: 100, h: 60 }, size, obstacles: [], view })!;
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });
  it("says so when there is no clear place (the bar says it then)", () => {
    const wall = { x: 0, y: 0, w: 1000, h: 300 };
    expect(placeBadge({ node, size, obstacles: [wall], view })).toBeNull();
  });
});
