// Overlays stay under the canvas UI: a pointer target behind the style panel or off-screen is
// "occluded" and gets an edge indicator on a free stretch of the edge; the layer is clipped around
// every panel.
import { describe, expect, it } from "vitest";
import { clipPath, edgeSpot, merge, occluded, visibleShare } from "./chrome.ts";

const view = { x: 0, y: 0, w: 1000, h: 700 };
const stylePanel = { x: 16, y: 166, w: 200, h: 460 };
const toolbar = { x: 400, y: 10, w: 560, h: 44 };

describe("occluded", () => {
  it("a node under the style panel is hidden; one beside it is not", () => {
    expect(occluded({ x: 30, y: 380, w: 180, h: 70 }, view, [stylePanel])).toBe(true);
    expect(occluded({ x: 350, y: 380, w: 180, h: 70 }, view, [stylePanel])).toBe(false);
  });
  it("off-screen or mostly covered counts as hidden; a corner under a panel does not", () => {
    expect(occluded({ x: -400, y: 300, w: 180, h: 70 }, view, [])).toBe(true);
    expect(occluded({ x: 180, y: 380, w: 180, h: 70 }, view, [stylePanel])).toBe(false); // centre is free
    expect(visibleShare({ x: 180, y: 380, w: 180, h: 70 }, view, [stylePanel])).toBeGreaterThan(0.6);
  });
});

describe("edgeSpot", () => {
  it("goes to the edge towards the target and points at it", () => {
    const s = edgeSpot({ x: -400, y: 330, w: 180, h: 70 }, view, [], 60, 28);
    expect(s.x).toBe(10); // left edge, inset
    expect(Math.abs(s.angle)).toBeGreaterThan(170); // pointing left
  });
  it("slides along the edge off a panel that covers that stretch", () => {
    const s = edgeSpot({ x: 30, y: 380, w: 180, h: 70 }, view, [stylePanel], 60, 28);
    const hitsPanel = s.x < stylePanel.x + stylePanel.w && s.x + s.w > stylePanel.x && s.y < stylePanel.y + stylePanel.h && s.y + s.h > stylePanel.y;
    expect(hitsPanel).toBe(false);
    expect(s.x).toBeGreaterThanOrEqual(10);
    expect(s.y + s.h).toBeLessThanOrEqual(view.h - 10);
  });
  it("stays inside the view and off the toolbar for a target above it", () => {
    const s = edgeSpot({ x: 600, y: -300, w: 100, h: 60 }, view, [toolbar], 60, 28);
    expect(s.y).toBeGreaterThanOrEqual(10);
    const hitsBar = s.x < toolbar.x + toolbar.w && s.x + s.w > toolbar.x && s.y < toolbar.y + toolbar.h && s.y + s.h > toolbar.y;
    expect(hitsBar).toBe(false);
  });
});

describe("clipPath", () => {
  it("keeps the view and cuts every panel out, merging overlaps so they stay cut", () => {
    const p = clipPath(view, [stylePanel, toolbar, { x: 900, y: 0, w: 400, h: 50 }]);
    expect(p.startsWith('path(evenodd, "M0 0h1000v700h-1000Z')).toBe(true);
    expect(p).toContain("M16 166h200v460h-200Z");
    // toolbar and the box overlapping it become one hole (clipped to the view)
    expect(p).toContain("M400 0h600v54h-600Z");
    expect(merge([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }, { x: 50, y: 50, w: 1, h: 1 }])).toEqual([
      { x: 0, y: 0, w: 15, h: 15 },
      { x: 50, y: 50, w: 1, h: 1 },
    ]);
  });
});
