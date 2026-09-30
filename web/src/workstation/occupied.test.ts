// What covers the canvas pane, as any set of rectangles (web/docs/workstation.md §10, §15): the bars at the top and bottom, a floating session panel or
// comment list, a folded capsule. The camera frames the figure in the largest free rectangle that is left. Pure.
import { describe, expect, it } from "vitest";
import { freeRect, occupiedWith, rectsOverlap } from "./occupied";

const pane = { x: 0, y: 0, w: 1000, h: 800 };
const bars = { top: 96, bottom: 50 };

describe("freeRect: the largest empty rectangle", () => {
  it("nothing covers the pane: the whole pane", () => {
    expect(freeRect(pane, [])).toEqual(pane);
  });
  it("a panel down the right side: what is left of it, full height", () => {
    expect(freeRect(pane, [{ x: 640, y: 0, w: 360, h: 800 }])).toEqual({ x: 0, y: 0, w: 640, h: 800 });
  });
  it("a panel at the top right that is short: the strip under it is bigger than the part left of it when it is wide", () => {
    const f = freeRect(pane, [{ x: 400, y: 0, w: 600, h: 200 }]);
    expect(f).toEqual({ x: 0, y: 200, w: 1000, h: 600 });
  });
  it("a small capsule in a corner takes the side that costs the least", () => {
    const f = freeRect(pane, [{ x: 900, y: 0, w: 100, h: 40 }]);
    expect(f.w * f.h).toBeGreaterThanOrEqual(1000 * 760);
  });
  it("two things: the rectangle avoids both", () => {
    const covers = [{ x: 700, y: 0, w: 300, h: 800 }, { x: 0, y: 700, w: 700, h: 100 }];
    const f = freeRect(pane, covers);
    for (const c of covers) expect(rectsOverlap(f, c)).toBe(false);
    expect(f.w * f.h).toBeGreaterThan(400 * 700);
  });
  it("rectangles outside the pane, or with no size, do not count; ones sticking out are cut to the pane", () => {
    expect(freeRect(pane, [{ x: 2000, y: 0, w: 100, h: 100 }, { x: 10, y: 10, w: 0, h: 50 }])).toEqual(pane);
    expect(freeRect(pane, [{ x: 800, y: -50, w: 400, h: 900 }])).toEqual({ x: 0, y: 0, w: 800, h: 800 });
  });
  it("everything covered: an empty rectangle (the caller keeps what it had)", () => {
    const f = freeRect(pane, [pane]);
    expect(f.w * f.h).toBe(0);
  });
});

describe("occupiedWith: the covered px at each edge, the bars and the rectangles together", () => {
  it("only the bars: as before (top, bottom, nothing at the sides)", () => {
    expect(occupiedWith(pane, bars, [])).toEqual({ top: 96, right: 0, bottom: 50, left: 0 });
  });
  it("a floating panel at the right: the right edge is covered by it, the bars still are at the top and bottom", () => {
    const o = occupiedWith(pane, bars, [{ x: 640, y: 96, w: 348, h: 680 }]);
    expect(o.right).toBe(360);
    expect(o.top).toBe(96);
    expect(o.bottom).toBe(50);
    expect(o.left).toBe(0);
  });
  it("a panel that sits under the bars' strips only adds what is beyond them", () => {
    const o = occupiedWith(pane, bars, [{ x: 700, y: 0, w: 300, h: 300 }]);
    expect(o.top + o.right + o.bottom + o.left).toBeGreaterThanOrEqual(96 + 50);
    expect(o.top).toBeGreaterThanOrEqual(96);
  });
  it("the free area is never smaller than 0: covered from all sides gives a pane-sized occupied, not a negative one", () => {
    const o = occupiedWith(pane, bars, [pane]);
    expect(o.left + o.right).toBeLessThanOrEqual(pane.w);
    expect(o.top + o.bottom).toBeLessThanOrEqual(pane.h);
  });
});
