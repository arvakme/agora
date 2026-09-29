import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { BUBBLE_MAX_W, boxesIn, placeBubbles, protoSpot, TAIL_H, TIP_GAP, type BubbleIn } from "./bubbles";

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const boxes = (list: BubbleIn[], at: Map<string, { x: number; y: number; chip: boolean }>) =>
  list.flatMap((b) => {
    const p = at.get(b.id);
    return p ? [{ id: b.id, x: p.x, y: p.y, w: p.chip ? (b.chip?.w ?? 40) : b.w, h: p.chip ? (b.chip?.h ?? 22) : b.h }] : [];
  });
const noOverlap = (bs: (Box & { id: string })[]) => {
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(overlap(bs[i], bs[j]), `${bs[i].id} × ${bs[j].id}`).toBe(false);
};
const fig = (id: string, x: number, y: number, o: Partial<BubbleIn> = {}): BubbleIn => ({ id, x, y, r: 10, w: 220, h: 28, chip: { w: 40, h: 22 }, foldable: false, ...o });

describe("placeBubbles", () => {
  it("alone: right above its own head, tail pointing at the head", () => {
    const { at } = placeBubbles([fig("a", 300, 300)], { width: 1000, height: 800, nodes: [] });
    const p = at.get("a")!;
    expect(p.chip).toBe(false);
    expect(p.tail).toBe("d");
    expect(p.x + p.tailX).toBe(300);
    expect(p.y + 28 + TAIL_H).toBe(300 - 10 - TIP_GAP);
  });

  it("takes the prototype's spot when it is clear", () => {
    const proto = protoSpot({ x: 300, y: 350 }, 1.2, {});
    const { at } = placeBubbles([fig("a", 301, 305, { proto })], { width: 1000, height: 800, nodes: [] });
    expect(at.get("a")).toMatchObject({ x: 280, y: 350 - 72 - 34, tail: "d", tailX: 20 });
  });

  it("two heads side by side: each keeps its tail on its own head", () => {
    const { at } = placeBubbles([fig("l", 300, 300), fig("r", 355, 300)], { width: 1200, height: 800, nodes: [] });
    const l = at.get("l")!;
    const r = at.get("r")!;
    expect(l.chip || r.chip).toBe(false);
    expect(l.x + l.tailX).toBe(300);
    expect(r.x + r.tailX).toBe(355);
    noOverlap(boxes([fig("l", 300, 300), fig("r", 355, 300)], at));
  });

  it("never covers a node label: slides a little, else collapses to a chip at the figure", () => {
    // drawing all around the head (above it and on both sides): no full bubble fits near the figure
    const nodes = [
      { x: 0, y: 150, w: 1000, h: 140 },
      { x: 0, y: 290, w: 470, h: 60 },
      { x: 530, y: 290, w: 470, h: 60 },
    ];
    const { at } = placeBubbles([fig("a", 500, 320)], { width: 1000, height: 800, nodes });
    const p = at.get("a")!;
    expect(p.chip).toBe(true);
    // right at the figure (beside its head), not far away
    expect(Math.abs(p.x + 20 - 500)).toBeLessThan(80);
    expect(Math.abs(p.y + 11 - 320)).toBeLessThan(40);
  });

  it("no room at all: low-priority sub bubbles fold, main and needs-you stay", () => {
    const list: BubbleIn[] = [fig("need", 60, 100, { w: 200 }), fig("main", 120, 100, { w: 200 }), fig("s1", 170, 100, { w: 200, foldable: true }), fig("s2", 220, 100, { w: 200, foldable: true })];
    const { at, folded } = placeBubbles(list, { width: 300, height: 130, nodes: [] });
    expect(at.has("need")).toBe(true);
    expect(at.has("main")).toBe(true);
    expect(folded.every((id) => id.startsWith("s"))).toBe(true);
    noOverlap(boxes(list, at));
  });

  it("never overlaps and never drifts far from its figure (seeded random scenes)", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; n < 300; n++) {
      const width = 400 + rnd() * 1200;
      const height = 200 + rnd() * 700;
      const nodes = Array.from({ length: Math.floor(rnd() * 12) }, () => ({ x: rnd() * width, y: rnd() * height, w: 60 + rnd() * 200, h: 40 + rnd() * 100 }));
      const list: BubbleIn[] = Array.from({ length: 1 + Math.floor(rnd() * 7) }, (_, i) => fig(`b${i}`, 40 + rnd() * (width - 80), 60 + rnd() * (height - 80), { w: 120 + rnd() * 160, h: 24 + rnd() * 10, foldable: i > 1 }));
      const { at, folded } = placeBubbles(list, { width, height, nodes });
      noOverlap(boxes(list, at));
      expect(list.filter((b) => !b.foldable).every((b) => at.has(b.id))).toBe(true);
      expect(folded.every((id) => list.find((b) => b.id === id)!.foldable)).toBe(true);
      for (const b of list) {
        const p = at.get(b.id);
        if (!p || p.tail === null) continue;
        // a bubble with a tail points at its own head: the tail's tip is within a bubble row of it
        const tipX = p.tail === "d" ? p.x + p.tailX : p.tail === "l" ? p.x : p.x + (p.chip ? b.chip!.w : b.w);
        expect(Math.abs(tipX - b.x)).toBeLessThan(b.r + 12);
      }
    }
  });
});

// A figure's body from head to feet (screen px), 2 px per figure unit: 48 wide, the head at its top.
const bodyOf = (hx: number, hy: number, r = 10): Box => ({ x: hx - 24, y: hy - r, w: 48, h: 62 });
const withSelf = (id: string, hx: number, hy: number, o: Partial<BubbleIn> = {}): BubbleIn => ({ ...fig(id, hx, hy, o), self: bodyOf(hx, hy) });
const boxOf = (b: BubbleIn, p: { x: number; y: number; chip: boolean }): Box => ({ x: p.x, y: p.y, w: p.chip ? (b.chip?.w ?? 40) : b.w, h: p.chip ? (b.chip?.h ?? 22) : b.h });

describe("a bubble never covers its own figure", () => {
  it("a figure against the bottom edge: the bubble stays above it", () => {
    const b = withSelf("a", 300, 740);
    const { at } = placeBubbles([b], { width: 1000, height: 800, nodes: [] });
    expect(overlap(boxOf(b, at.get("a")!), b.self!)).toBe(false);
  });
  it("a figure against the top edge: no room above, so it goes to the side, tail still on the head", () => {
    const b = withSelf("a", 300, 24);
    const { at } = placeBubbles([b], { width: 1000, height: 800, nodes: [] });
    const p = at.get("a")!;
    expect(overlap(boxOf(b, p), b.self!)).toBe(false);
    expect(p.tail === "l" || p.tail === "r").toBe(true);
  });
  it("a figure in the corner: still clear of it", () => {
    for (const [x, y] of [[30, 24], [970, 24], [30, 776], [970, 776]]) {
      const b = withSelf("a", x, y);
      const { at } = placeBubbles([b], { width: 1000, height: 800, nodes: [] });
      expect(overlap(boxOf(b, at.get("a")!), b.self!), `${x},${y}`).toBe(false);
    }
  });
  it("where it was last time is not kept once that spot covers the figure (it has walked under its own bubble)", () => {
    const b = withSelf("a", 300, 400, { prev: { x: 200, y: 380, tail: "d", tailX: 100, stem: 0 } });
    const { at } = placeBubbles([b], { width: 1000, height: 800, nodes: [] });
    expect(overlap(boxOf(b, at.get("a")!), b.self!)).toBe(false);
  });
  it("the selected bubble too, standing in a tray that is an obstacle around it", () => {
    const tray = { x: 100, y: 700, w: 500, h: 100 };
    const b = withSelf("a", 300, 730, { keep: true, prev: { x: 250, y: 720, tail: "d", tailX: 50, stem: 0 } });
    const { at } = placeBubbles([b], { width: 1000, height: 800, nodes: [tray] });
    expect(overlap(boxOf(b, at.get("a")!), b.self!)).toBe(false);
  });
  it("a chip is clear of its figure as well, and so is the last resort", () => {
    const nodes = [{ x: 0, y: 0, w: 1000, h: 800 }];
    const b = withSelf("a", 500, 400);
    const { at } = placeBubbles([b], { width: 1000, height: 800, nodes });
    const p = at.get("a")!;
    expect(p.chip).toBe(true);
    expect(overlap(boxOf(b, p), b.self!)).toBe(false);
  });
  it("other figures' bodies are still avoided too", () => {
    const a = withSelf("a", 300, 300);
    const o: BubbleIn = { ...withSelf("o", 300, 200), w: 100 }; // another figure standing right where a's bubble would go
    const { at } = placeBubbles([a, o], { width: 1000, height: 800, nodes: [] });
    for (const f of [a, o]) for (const g of [a, o]) if (f !== g && at.has(f.id)) expect(overlap(boxOf(f, at.get(f.id)!), g.self!), `${f.id} over ${g.id}`).toBe(false);
  });
});


// FX2b (ACC1 #5, #8): a bubble is at most BUBBLE_MAX_W wide (the words end in …, the full text shows on hover),
// stays whole inside the pane near its edges, and the talk box keeps off every shown bubble.
describe("bubble width", () => {
  it("the CSS cap is the exported cap (one number, two places)", () => {
    const css = readFileSync(new URL("./workstation.css", import.meta.url), "utf8");
    expect(css).toContain(`--bub-max: ${BUBBLE_MAX_W}px`);
  });

  it("the words part ends in an ellipsis instead of growing", () => {
    const css = readFileSync(new URL("./workstation.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.ws-bub-in \{[^}]*max-width: calc\(var\(--bub-max\)/);
    expect(css).toMatch(/\.ws-bub-in > [^{]*\{[^}]*text-overflow: ellipsis/);
  });

  it("at either edge of the pane a full-width bubble slides in, whole, tail still on its head", () => {
    for (const x of [26, 40, 60, 940, 970, 992]) {
      const b = fig(`e${x}`, x, 300, { w: BUBBLE_MAX_W });
      const { at } = placeBubbles([b], { width: 1000, height: 800, nodes: [] });
      const p = at.get(b.id)!;
      expect(p.x, `${x}`).toBeGreaterThanOrEqual(8);
      expect(p.x + (p.chip ? 40 : b.w), `${x}`).toBeLessThanOrEqual(1000 - 8);
      if (!p.chip && p.tail === "d") expect(p.x + p.tailX).toBe(x);
    }
  });

  it("several full-width bubbles at once: none overlaps another, all inside the pane", () => {
    const list = [fig("a", 120, 300, { w: BUBBLE_MAX_W }), fig("b", 260, 300, { w: BUBBLE_MAX_W, foldable: true }), fig("c", 400, 320, { w: BUBBLE_MAX_W, foldable: true }), fig("d", 880, 300, { w: BUBBLE_MAX_W })];
    const { at } = placeBubbles(list, { width: 1000, height: 800, nodes: [] });
    const bs = boxes(list, at);
    noOverlap(bs);
    for (const r of bs) expect(r.x >= 8 && r.x + r.w <= 992 && r.y >= 8 && r.y + r.h <= 792, r.id).toBe(true);
  });
});

describe("boxesIn (the talk box's obstacles)", () => {
  it("shown bubbles as boxes in the box's own frame; empty or hidden ones are dropped", () => {
    const rects = [
      { left: 130, top: 90, width: 200, height: 28 },
      { left: 10, top: 10, width: 0, height: 0 },
      { left: 400, top: 200, width: 80, height: 22 },
    ];
    expect(boxesIn({ left: 100, top: 50 }, rects)).toEqual([
      { x: 30, y: 40, w: 200, h: 28 },
      { x: 300, y: 150, w: 80, h: 22 },
    ]);
  });
});
