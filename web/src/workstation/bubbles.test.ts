import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { placeBubbles, protoSpot, TAIL_H, TIP_GAP, type BubbleIn } from "./bubbles";

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
