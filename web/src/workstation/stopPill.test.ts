// FX7: the note beside a route stop is never on top of a node's words, nor another node's, nor another note; and when nothing is free it is not drawn.
import { describe, expect, it } from "vitest";
import { pillSize, pillSpot } from "./stopPill";
import { stopEntryText } from "./traceText";

const node = { x: 400, y: 300, w: 200, h: 80 };
const view = { x: 0, y: 0, w: 1400, h: 900 };
const text = stopEntryText(2, ["coachchat 交付/直播 live-run", "webapp"]);
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("pillSpot", () => {
  it("free all round: over the node's top edge, outside the node (the screenshot's case put it inside, over the node's words)", () => {
    const s = pillSpot({ node, text, zoom: 1, obstacles: [node], taken: [], view })!;
    expect(s).not.toBeNull();
    expect(overlap(s.box, node)).toBe(false);
    expect(s.box.y + s.box.h).toBeLessThanOrEqual(node.y);
    expect(s.dy).toBeLessThan(0);
  });
  it("something above (another node): beside the right edge; a figure standing on the top edge: the top is skipped too", () => {
    const above = { x: 380, y: 240, w: 300, h: 40 };
    const s = pillSpot({ node, text, zoom: 1, obstacles: [node, above], taken: [], view })!;
    expect(overlap(s.box, above)).toBe(false);
    expect(overlap(s.box, node)).toBe(false);
    const f = pillSpot({ node, text, zoom: 1, obstacles: [node], taken: [], view, figureAtTop: true })!;
    expect(f.box.y).toBeGreaterThanOrEqual(node.y);
    expect(f.box.x).toBeGreaterThanOrEqual(node.x + node.w);
  });
  it("no side is free: null (only the number is drawn)", () => {
    const wall = [{ x: 0, y: 0, w: 1400, h: 295 }, { x: 606, y: 295, w: 700, h: 100 }, { x: 0, y: 385, w: 1400, h: 500 }];
    expect(pillSpot({ node, text, zoom: 1, obstacles: [node, ...wall], taken: [], view })).toBeNull();
  });
  it("two notes never overlap: the second goes to another side", () => {
    const a = pillSpot({ node, text, zoom: 1, obstacles: [node], taken: [], view })!;
    const b = pillSpot({ node, text, zoom: 1, obstacles: [node], taken: [a.box], view })!;
    expect(overlap(a.box, b.box)).toBe(false);
  });
  it("a label right at the edge of the top side (a hair away) is not touched: the note goes elsewhere", () => {
    const label = { x: 430, y: node.y - 30, w: 60, h: 14 }; // ends 16px above the node's top: the top note (16 high, 4 gap) would touch it
    const s = pillSpot({ node, text, zoom: 1, obstacles: [node, label], taken: [], view })!;
    expect(overlap(s.box, { x: label.x - 3, y: label.y - 3, w: label.w + 6, h: label.h + 6 })).toBe(false);
  });
  it("zoomed out the note keeps its screen size: it is bigger in world units, and still clear of the node", () => {
    const s = pillSpot({ node, text, zoom: 0.5, obstacles: [node], taken: [], view })!;
    expect(s.box.w).toBeCloseTo(pillSize(text).w / 0.5);
    expect(overlap(s.box, node)).toBe(false);
  });
  it("outside the view: not that side (a note cut off by the pane's edge is worse than none)", () => {
    const top = { x: 400, y: 5, w: 200, h: 80 };
    const s = pillSpot({ node: top, text, zoom: 1, obstacles: [top], taken: [], view })!;
    expect(s.box.y).toBeGreaterThanOrEqual(0);
  });
});
