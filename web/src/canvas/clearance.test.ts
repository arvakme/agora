// Overlays stay off the drawing: the pointer's ring takes in a node's caption, its label and
// orphaned comment pins move to a clear spot.
import { describe, expect, it } from "vitest";
import { footprint, freeSpot, obstacles, overlaps, pinBox, placeBeside } from "./clearance.ts";
import type { El } from "./scene.ts";

const el = (id: string, type: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) =>
  ({ id, type, x, y, width, height, isDeleted: false, groupIds: [], ...extra }) as unknown as El;
const mapOf = (els: El[]) => new Map(els.map((e) => [e.id, e]));

describe("footprint", () => {
  it("takes in a library component's label and group, and a free caption right under an icon", () => {
    const root = el("api", "rectangle", 100, 100, 80, 80, { groupIds: ["g"], strokeColor: "transparent", backgroundColor: "transparent", customData: { agora: { library: "x", name: "Server", group: "g", label: "api-label" } } });
    const img = el("img", "image", 104, 104, 72, 72, { groupIds: ["inner", "g"] });
    const label = el("api-label", "text", 110, 186, 60, 20, { groupIds: ["g"] });
    const all = [root, img, label];
    expect(footprint(root, mapOf(all), all)).toEqual({ x: 100, y: 100, w: 80, h: 106 });

    const icon = el("db", "image", 400, 100, 80, 80);
    const caption = el("cap", "text", 410, 188, 60, 20);
    const far = el("far", "text", 410, 260, 60, 20);
    const els = [icon, caption, far];
    expect(footprint(icon, mapOf(els), els)).toEqual({ x: 400, y: 100, w: 80, h: 108 });
  });

  it("obstacles skip arrows, loose lines, frames and labels inside shapes; icon strokes count", () => {
    const box = el("b", "rectangle", 0, 0, 100, 40, { boundElements: [{ type: "text", id: "t" }] });
    const t = el("t", "text", 10, 10, 80, 20, { containerId: "b" });
    const arrow = el("a", "arrow", 100, 20, 100, 0, { points: [[0, 0], [100, 0]] });
    const arrowLabel = el("al", "text", 130, 10, 40, 20, { containerId: "a" });
    const frame = el("f", "frame", -50, -50, 500, 500);
    const loose = el("l", "line", 0, 100, 100, 0, { points: [[0, 0], [100, 0]] });
    const stroke = el("s", "line", 300, 0, 50, 50, { groupIds: ["icon"], points: [[0, 0], [50, 50]] });
    const all = [box, t, arrow, arrowLabel, frame, loose, stroke];
    expect(obstacles(all, mapOf(all))).toEqual([{ x: 0, y: 0, w: 100, h: 40 }, { x: 130, y: 10, w: 40, h: 20 }, { x: 300, y: 0, w: 50, h: 50 }]);
  });
});

describe("freeSpot", () => {
  it("keeps a pin where it wants to be when that covers nothing", () => {
    expect(freeSpot({ x: 10, y: 100 }, 28, [{ x: 200, y: 0, w: 50, h: 50 }])).toEqual({ x: 10, y: 100 });
  });

  it("moves a pin that would sit on an icon to the nearest clear spot", () => {
    const icon = { x: 0, y: 0, w: 120, h: 120 };
    const p = freeSpot({ x: 60, y: 60 }, 28, [icon]);
    expect(overlaps(pinBox(p, 28), icon, 4)).toBe(false);
    expect(Math.hypot(p.x - 60, p.y - 60)).toBeLessThan(120);
  });

  it("gives up (stays put) when everything nearby is covered", () => {
    const wall = { x: -1000, y: -1000, w: 2000, h: 2000 };
    expect(freeSpot({ x: 0, y: 0 }, 28, [wall], { maxRings: 2 })).toEqual({ x: 0, y: 0 });
  });
});

describe("placeBeside", () => {
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  it("puts the label above the node when that is clear", () => {
    expect(placeBeside({ x: 300, y: 300, w: 100, h: 100 }, 180, 28, [], view, { gap: 6 })).toEqual({ x: 300, y: 266, side: "above", });
  });
  it("avoids another node above, and the top edge of the view", () => {
    const above = { x: 280, y: 240, w: 140, h: 40 };
    expect(placeBeside({ x: 300, y: 300, w: 100, h: 100 }, 180, 28, [above], view, { gap: 6 }).side).toBe("below");
    expect(placeBeside({ x: 300, y: 10, w: 100, h: 100 }, 180, 28, [], view, { gap: 6 }).side).toBe("below");
  });
  it("slides along a side past a comment pin on the node's corner, staying next to the node", () => {
    const pin = { x: 398, y: 272, w: 28, h: 28 };
    const p = placeBeside({ x: 300, y: 300, w: 100, h: 100 }, 130, 28, [pin], view, { gap: 6 });
    expect(p.side).toBe("above");
    expect(p.x + 130).toBeLessThanOrEqual(398);
    expect(p.x + 130).toBeGreaterThan(300 + 24 - 1);
  });
});
