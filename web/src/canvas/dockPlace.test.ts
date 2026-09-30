// The dock in a narrow window: in the compact bar's middle, not over the diagram (canvas/dockPlace.ts).
import { describe, expect, it } from "vitest";
import { DOCK_H, dockBottom, dockGroup, groupPlace, isCompact, PILL_GAP, PILL_W } from "./dockPlace.ts";

describe("isCompact", () => {
  it("Excalidraw's own compact class", () => expect(isCompact(true, 1200)).toBe(true));
  it("a narrow pane", () => expect(isCompact(false, 720)).toBe(true));
  it("a wide pane", () => expect(isCompact(false, 1200)).toBe(false));
});

describe("dockBottom", () => {
  it("wide, island not measured yet: Excalidraw's own edge gap above the canvas's bottom edge", () => expect(dockBottom({ paneBottom: 800, windowHeight: 900, compact: false })).toBe(116));
  it("wide: level with Excalidraw's zoom island (36 high, 848–884 in a 900-high window)", () => {
    const b = dockBottom({ paneBottom: 900, windowHeight: 900, compact: false, island: { top: 848, bottom: 884 } });
    expect(b).toBe(16);
    expect(900 - b - DOCK_H).toBe(848);
  });
  it("compact: centred on the bar (bar 850–900 in a 900-high window, dock 36 high)", () => {
    const b = dockBottom({ paneBottom: 900, windowHeight: 900, compact: true, island: { top: 850, bottom: 900 } });
    expect(b).toBe(7);
    // the dock's top edge (window height − bottom − 36) lies inside the bar
    expect(900 - b - DOCK_H).toBeGreaterThanOrEqual(850);
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
  it("a pill that shrinks to fit keeps the group centred too (no less than 96 wide)", () => {
    const g = groupPlace({ ...o, center: 600, limitRight: 780, pill: true });
    expect(g.pillW).toBeGreaterThanOrEqual(96);
    expect(g.pillW).toBeLessThan(PILL_W);
    const s = span(g);
    expect((s.l + s.r) / 2).toBeCloseTo(600, 1);
    expect(s.r).toBeLessThanOrEqual(780 - 8 + 0.01);
  });
  it("the left controls count too", () => {
    const g = groupPlace({ ...o, center: 400, limitLeft: 228, limitRight: null, pill: true });
    expect(span(g).l).toBeGreaterThanOrEqual(228 + 8 - 0.01);
  });
  it("not even the round avatar fits: the group slides clear of the controls instead of sitting on them", () => {
    const g = groupPlace({ center: 280, dockW: 206.6, limitLeft: null, limitRight: 400, pill: true });
    expect(g.pillW).toBe(DOCK_H);
    expect(span(g).r).toBeLessThanOrEqual(400 - 8 + 0.01);
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
