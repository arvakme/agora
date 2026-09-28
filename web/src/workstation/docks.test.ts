import { describe, expect, it } from "vitest";
import { dockSpots, FIG_BOX, trayBox } from "./docks";

const fig = (p: { x: number; y: number }, k: number) => ({ x: p.x + FIG_BOX.x0 * k, y: p.y + FIG_BOX.y0 * k, w: (FIG_BOX.x1 - FIG_BOX.x0) * k, h: (FIG_BOX.y1 - FIG_BOX.y0) * k });
const hit = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("dockSpots", () => {
  const node = { x: 330, y: 230, w: 200, h: 72 };
  it("the prototype's dock: 24 px in on the top edge, 46 apart", () => {
    const s = dockSpots(node, [node], 1, 3);
    expect(s).toEqual([
      { x: 354, y: 230 },
      { x: 400, y: 230 },
      { x: 446, y: 230 },
    ]);
  });
  it("keeps figures off text and icons above the node, and takes another edge when the top is full", () => {
    const label = { x: 340, y: 190, w: 140, h: 20 }; // an arrow label just above the left part of the top edge
    const k = 1.2;
    const s = dockSpots(node, [node, label], k, 3);
    for (const p of s) expect(hit(fig(p, k), label)).toBe(false);
    expect(s.length).toBe(3);
  });
  it("the node's own parts (its label, an icon's strokes) don't block it", () => {
    const own = { x: 400, y: 280, w: 60, h: 16 };
    expect(dockSpots(node, [node, own], 1, 1)[0]).toEqual({ x: 354, y: 230 });
  });
});

describe("trayBox", () => {
  it("beside the lowest node, like the prototype's 图外 next to 支付服务", () => {
    const nodes = [
      { x: 40, y: 230, w: 170, h: 72 },
      { x: 680, y: 330, w: 160, h: 64 },
      { x: 350, y: 450, w: 160, h: 64 },
    ];
    const t = trayBox(nodes);
    expect(t.x).toBe(620);
    expect(t.y).toBe(470);
    // nothing drawn over the tray or the figures standing on it
    for (const n of nodes) expect(hit(n, { x: t.x, y: t.y - 72, w: 130, h: t.h + 72 })).toBe(false);
  });
});
