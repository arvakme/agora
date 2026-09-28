import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { placeBubbles, type BubbleIn } from "./bubbles";

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const boxes = (list: BubbleIn[], at: Map<string, { x: number; y: number }>) =>
  list.flatMap((b) => {
    const p = at.get(b.id);
    return p ? [{ id: b.id, x: p.x, y: p.y, w: b.w, h: b.h }] : [];
  });
const noOverlap = (bs: (Box & { id: string })[]) => {
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(overlap(bs[i], bs[j]), `${bs[i].id} × ${bs[j].id}`).toBe(false);
};

describe("placeBubbles", () => {
  it("three figures docked on one node near the top: no two bubbles overlap", () => {
    // the 03-c-subagents scene: main (Claude Code), Pi and a Codex sub on the API node's top edge
    const node = { x: 300, y: 90, w: 220, h: 70 };
    const list: BubbleIn[] = [
      { id: "main", x: 354, y: 70, w: 230, h: 30, foldable: false, below: 160 },
      { id: "pi", x: 410, y: 72, w: 250, h: 26, foldable: true, below: 160 },
      { id: "codex", x: 466, y: 72, w: 250, h: 26, foldable: true, below: 160 },
    ];
    const { at, folded } = placeBubbles(list, { width: 1200, height: 800, nodes: [node] });
    noOverlap(boxes(list, at));
    expect(at.has("main")).toBe(true);
    for (const b of boxes(list, at)) expect(overlap(b, node), b.id).toBe(false);
    expect(at.size + folded.length).toBe(3);
  });

  it("no room: low-priority sub bubbles fold, main and needs-you stay", () => {
    // a 360×120 view: room for about two bubbles
    const list: BubbleIn[] = [
      { id: "need", x: 60, y: 100, w: 200, h: 28, foldable: false },
      { id: "main", x: 120, y: 100, w: 200, h: 28, foldable: false },
      { id: "s1", x: 170, y: 100, w: 200, h: 28, foldable: true },
      { id: "s2", x: 220, y: 100, w: 200, h: 28, foldable: true },
    ];
    const { at, folded } = placeBubbles(list, { width: 360, height: 120, nodes: [] });
    expect(at.has("need")).toBe(true);
    expect(at.has("main")).toBe(true);
    expect(folded.length).toBeGreaterThan(0);
    expect(folded.every((id) => id.startsWith("s"))).toBe(true);
    noOverlap(boxes(list, at));
  });

  it("never overlaps, whatever the crowd (seeded random scenes)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 300; n++) {
      const width = 400 + rnd() * 1200;
      const height = 200 + rnd() * 700;
      const nodes = Array.from({ length: Math.floor(rnd() * 12) }, () => ({ x: rnd() * width, y: rnd() * height, w: 60 + rnd() * 200, h: 40 + rnd() * 100 }));
      const list: BubbleIn[] = Array.from({ length: 1 + Math.floor(rnd() * 7) }, (_, i) => ({
        id: `b${i}`,
        x: rnd() * width,
        y: rnd() * height,
        w: 120 + rnd() * 160,
        h: 24 + rnd() * 10,
        foldable: i > 1,
        below: rnd() < 0.5 ? rnd() * height : undefined,
      }));
      const { at, folded } = placeBubbles(list, { width, height, nodes });
      noOverlap(boxes(list, at));
      // only foldable bubbles fold; the rest are always placed
      expect(list.filter((b) => !b.foldable).every((b) => at.has(b.id))).toBe(true);
      expect(folded.every((id) => list.find((b) => b.id === id)!.foldable)).toBe(true);
    }
  });

  it("an uncrowded bubble sits above its head with the tail down", () => {
    const { at } = placeBubbles([{ id: "a", x: 300, y: 300, w: 180, h: 28, foldable: false }], { width: 1000, height: 800, nodes: [] });
    expect(at.get("a")).toEqual({ x: 280, y: 300 - 28 - 14, tail: "d" });
  });
});
