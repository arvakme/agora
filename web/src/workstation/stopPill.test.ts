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

// ── FX8: the note must not cover the head looking out of the node's hole, nor its「在子图 · 空闲」word ──
import { PEEK_NOTE, peekBox } from "./hatch";
import { entryCapsuleBox } from "./stopPill";
import { RIG } from "./rig";

describe("FX8 · a node with someone in its sub-diagram: the note keeps clear of the head, its word, the entrance capsule", () => {
  const n = { x: 400, y: 300, w: 240, h: 90 };
  const dock = { x: n.x + 24, y: n.y }; // where the first worker stands: 24 in from the left, on the top edge (docks.ts)
  const k = 1.2;
  it("peekBox: over the top edge at the dock — the head, and the word beside it when the agent is idle", () => {
    const head = peekBox(dock, k, false);
    const word = peekBox(dock, k, true);
    expect(head.y).toBeLessThan(dock.y - RIG.head * k);
    expect(head.x).toBeLessThan(dock.x);
    expect(word.w).toBeGreaterThan(head.w + PEEK_NOTE.w * k * 0.9);
    expect(word.x).toBe(head.x);
  });
  it("the screenshot's case: the top side is where the head is — the note does not go there, it goes beside the right edge", () => {
    const peek = peekBox(dock, k, true);
    const s = pillSpot({ node: n, text, zoom: 1, obstacles: [n, peek], taken: [], view })!;
    expect(s).not.toBeNull();
    expect(overlap(s.box, peek)).toBe(false);
    expect(overlap(s.box, n)).toBe(false);
  });
  it("the head's box with its word, padded 4px: never touched, at every zoom", () => {
    for (const z of [0.5, 0.8, 1, 1.4]) {
      const peek = peekBox(dock, Math.max(1, Math.min(1.6, z * 1.2)) / z, true);
      const s = pillSpot({ node: n, text, zoom: z, obstacles: [n, peek], taken: [], view });
      if (s) expect(overlap(s.box, { x: peek.x - 4 / z, y: peek.y - 4 / z, w: peek.w + 8 / z, h: peek.h + 8 / z }), `zoom ${z}`).toBe(false);
    }
  });
  it("all five floaters at one node — note, head+word, entrance capsule, talk box, bubble — never on one another; the note gives way (null) before it covers any", () => {
    const peek = peekBox(dock, k, true);
    const capsule = entryCapsuleBox(n, 1);
    const talk = { x: n.x + n.w + 10, y: n.y - 20, w: 200, h: 70 };
    const bubble = { x: n.x + 30, y: n.y - 150, w: 240, h: 34 };
    const all = [peek, capsule, talk, bubble];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i], all[j]), `${i} x ${j}`).toBe(false);
    const s = pillSpot({ node: n, text, zoom: 1, obstacles: [n, ...all], taken: [], view });
    if (s) for (const o of all) expect(overlap(s.box, o)).toBe(false);
    // boxed in on the right and below as well: no note, and the others are where they were
    const boxed = pillSpot({ node: n, text, zoom: 1, obstacles: [n, ...all, { x: n.x + n.w, y: n.y + n.h - 10, w: 300, h: 60 }, { x: n.x, y: n.y + n.h + 10, w: 300, h: 60 }], taken: [], view });
    expect(boxed).toBeNull();
  });
  it("entryCapsuleBox: at the node's bottom-left, straddling its bottom edge, in world units for the zoom", () => {
    const c = entryCapsuleBox(n, 0.5);
    expect(c.x).toBeGreaterThanOrEqual(n.x);
    expect(c.y).toBeLessThan(n.y + n.h);
    expect(c.y + c.h).toBeGreaterThan(n.y + n.h);
    expect(c.w).toBeCloseTo(entryCapsuleBox(n, 1).w * 2);
  });
});
