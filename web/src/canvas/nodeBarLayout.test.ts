// The node action bar: one popover at a time, and the bar and its popover never land on each
// other, on the canvas's panels or on the pointer labels — the 「重叠了」 report (a plain box near
// the bottom-right: the code-paths editor and the 子图 menu stacked on the same spot).
import { describe, expect, it } from "vitest";
import { overlaps, type Box } from "./clearance.ts";
import { placeBar, placePop, toggleOpen } from "./nodeBarLayout.ts";

const view: Box = { x: 0, y: 0, w: 832, h: 659 };
const toolbar: Box = { x: 140, y: 16, w: 552, h: 46 }; // Excalidraw's top island
const bottomBar: Box = { x: 326, y: 605, w: 184, h: 40 }; // its bottom tool strip
const zoom: Box = { x: 16, y: 605, w: 212, h: 40 };
const chrome = [toolbar, bottomBar, zoom];
const inside = (b: Box, v: Box) => b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h;

describe("one popover at a time", () => {
  it("opening one closes the other; the same pill again closes it", () => {
    expect(toggleOpen(null, "code")).toBe("code");
    expect(toggleOpen("code", "child")).toBe("child");
    expect(toggleOpen("child", "code")).toBe("code");
    expect(toggleOpen("child", "child")).toBeNull();
  });
});

describe("placement", () => {
  it("the reported case: a plain box low in the pane — bar, editor and panels all apart", () => {
    const node: Box = { x: 257, y: 467, w: 146, h: 76 };
    const bar = placeBar(node, 190, 28, chrome, [], view);
    expect(inside(bar, view)).toBe(true);
    expect(overlaps(bar, node)).toBe(false);
    for (const c of chrome) expect(overlaps(bar, c)).toBe(false);
    for (const [w, h] of [[336, 236], [236, 110]] as const) {
      const pop = placePop(bar, node, w, h, chrome, [], view);
      expect(inside(pop, view)).toBe(true);
      expect(overlaps(pop, bar)).toBe(false);
      expect(overlaps(pop, node)).toBe(false);
      for (const c of chrome) expect(overlaps(pop, c)).toBe(false);
    }
  });
  it("flips to the left at the pane's right edge and keeps off a pointer label there", () => {
    const node: Box = { x: 700, y: 300, w: 100, h: 60 };
    const label: Box = { x: 700, y: 262, w: 120, h: 28 }; // the pointer's label above the node
    const bar = placeBar(node, 190, 28, [...chrome, label], [], view);
    expect(bar.side).toBe("left");
    expect(overlaps(bar, label)).toBe(false);
    const pop = placePop(bar, node, 336, 236, [...chrome, label], [], view);
    expect(inside(pop, view)).toBe(true);
    for (const b of [bar, node, label, ...chrome]) expect(overlaps(pop, b)).toBe(false);
  });
  it("prefers free canvas over covering other nodes, but never trades a panel for them", () => {
    const node: Box = { x: 300, y: 250, w: 100, h: 60 };
    const neighbour: Box = { x: 410, y: 240, w: 120, h: 80 }; // right next to it
    const bar = placeBar(node, 190, 28, chrome, [neighbour], view);
    expect(overlaps(bar, neighbour)).toBe(false);
    const pop = placePop(bar, node, 336, 236, chrome, [neighbour], view);
    for (const c of chrome) expect(overlaps(pop, c)).toBe(false);
  });
});
