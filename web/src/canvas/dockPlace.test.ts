// The dock in a narrow window: in the compact bar's middle, not over the diagram (canvas/dockPlace.ts).
import { describe, expect, it } from "vitest";
import { DOCK_H, dockBottom, dockGroup, groupPlace, isCompact, PILL_GAP, PILL_W, roomFor } from "./dockPlace.ts";

describe("isCompact", () => {
  it("Excalidraw's own compact class", () => expect(isCompact(true, 1200)).toBe(true));
  it("a narrow pane", () => expect(isCompact(false, 720)).toBe(true));
  it("a wide pane", () => expect(isCompact(false, 1200)).toBe(false));
});

describe("dockBottom", () => {
  it("wide: level with Excalidraw's zoom island (as tall as it: same top, same bottom edge)", () => {
    const b = dockBottom({ paneBottom: 900, windowHeight: 900, compact: false, island: { top: 848, bottom: 848 + DOCK_H } });
    expect(900 - b - DOCK_H).toBeCloseTo(848, 6); // the dock's top edge (window height − bottom − its height)
    expect(900 - b).toBeCloseTo(848 + DOCK_H, 6);
  });
  it("compact: centred on the bar, inside it (bar 850–900 in a 900-high window)", () => {
    const b = dockBottom({ paneBottom: 900, windowHeight: 900, compact: true, island: { top: 850, bottom: 900 } });
    const top = 900 - b - DOCK_H;
    expect(top).toBeGreaterThanOrEqual(850);
    expect(top + DOCK_H / 2).toBeCloseTo(875, 6);
  });
  it("compact but the bar is not there yet: above its usual height", () => expect(dockBottom({ paneBottom: 900, windowHeight: 900, compact: true })).toBe(72));
});

describe("groupPlace", () => {
  const o = { center: 720, dockW: 206.6, limitLeft: 228, limitRight: 1305 };
  const span = (g: { dockCx: number; pillW: number }, dockW = o.dockW) => ({ l: g.dockCx - dockW / 2, r: g.dockCx - dockW / 2 + dockW + PILL_GAP + g.pillW });
  it("no pill: the dock alone is centred", () => expect(groupPlace({ ...o, pill: false })).toEqual({ dockCx: 720, pillW: 0 }));
  it("the pill with its words: dock and pill together are centred", () => {
    const g = groupPlace({ ...o, pill: true });
    expect(g.pillW).toBe(PILL_W);
    const s = span(g);
    expect((s.l + s.r) / 2).toBeCloseTo(720, 1);
  });
  it("short of room for the words, the pill is the round avatar and the group stays centred", () => {
    const g = groupPlace({ ...o, center: 280, limitLeft: null, limitRight: 415, pill: true });
    expect(g.pillW).toBe(DOCK_H);
    const s = span(g);
    expect((s.l + s.r) / 2).toBeCloseTo(280, 1);
  });
  it("a pill that shrinks to fit keeps the group centred too (it keeps its words while it can)", () => {
    const g = groupPlace({ ...o, center: 600, limitRight: 780, pill: true });
    expect(g.pillW).toBeGreaterThan(DOCK_H); // still its words, not the round avatar
    expect(g.pillW).toBeLessThan(PILL_W);
    const s = span(g);
    expect((s.l + s.r) / 2).toBeCloseTo(600, 1);
    expect(s.r).toBeLessThan(780); // clear of the controls on its right
  });
  it("the left controls count too", () => {
    const g = groupPlace({ ...o, center: 400, limitLeft: 228, limitRight: null, pill: true });
    expect(span(g).l).toBeGreaterThan(228); // clear of the controls on its left
  });
  it("not even the round avatar fits: the group slides clear of the controls instead of sitting on them", () => {
    const g = groupPlace({ center: 280, dockW: 206.6, limitLeft: null, limitRight: 400, pill: true });
    expect(g.pillW).toBe(DOCK_H);
    expect(span(g).r).toBeLessThan(400);
  });
});

describe("roomFor", () => {
  // a 383 px pane in the compact layout: the bar's menu button ends at 54, its undo starts at 297 and 「整张图」 sits just left of that
  const pane = { center: 191.5, limitLeft: 54, limitRight: 261 };
  it("the dock with its words (207) does not fit between them, without its words (112) it does", () => {
    expect(roomFor({ ...pane, width: 206.6 })).toBe(false);
    expect(roomFor({ ...pane, width: 112 })).toBe(true);
  });
  it("centred means room on both sides: a neighbour close on one side is enough to say no", () => expect(roomFor({ center: 300, limitLeft: 0, limitRight: 340, width: 70 })).toBe(false));
  it("nothing either side: always", () => expect(roomFor({ center: 10, limitLeft: null, limitRight: null, width: 1000 })).toBe(true));
});

describe("groupPlace, no pill, in a narrow pane", () => {
  it("fits: centred", () => expect(groupPlace({ center: 191.5, dockW: 112, pill: false, limitLeft: 54, limitRight: 261 }).dockCx).toBe(191.5));
  it("no room to be centred but room to fit: slides clear of the controls rather than sit on them", () => {
    const g = groupPlace({ center: 191.5, dockW: 150, pill: false, limitLeft: 54, limitRight: 261 });
    expect(g.dockCx + 75).toBeLessThanOrEqual(261 - 8);
    expect(g.dockCx - 75).toBeGreaterThanOrEqual(54 + 8);
  });
});

describe("dockGroup", () => {
  it("tells its listeners only when something changed", () => {
    let n = 0;
    const off = dockGroup.subscribe(() => n++);
    dockGroup.set({ center: 10, pillW: 0 });
    dockGroup.set({ center: 10, pillW: 0 });
    dockGroup.set({ center: 10, pillW: 36 });
    off();
    expect(n).toBe(2);
    expect(dockGroup.get()).toEqual({ center: 10, pillW: 36 });
  });
});
