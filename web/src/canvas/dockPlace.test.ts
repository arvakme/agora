// The dock in a narrow window: in the compact bar's middle, not over the diagram (canvas/dockPlace.ts).
import { describe, expect, it } from "vitest";
import { dockBottom, isCompact } from "./dockPlace.ts";

describe("isCompact", () => {
  it("Excalidraw's own compact class", () => expect(isCompact(true, 1200)).toBe(true));
  it("a narrow pane", () => expect(isCompact(false, 720)).toBe(true));
  it("a wide pane", () => expect(isCompact(false, 1200)).toBe(false));
});

describe("dockBottom", () => {
  it("wide: a little above the canvas's bottom edge", () => expect(dockBottom({ paneBottom: 800, windowHeight: 900, compact: false })).toBe(114));
  it("compact: centred on the bar (bar 850–900 in a 900-high window, dock 44 high)", () => {
    const b = dockBottom({ paneBottom: 900, windowHeight: 900, compact: true, bar: { top: 850, bottom: 900 } });
    expect(b).toBe(3);
    // the dock's top edge (window height − bottom − 44) lies inside the bar
    expect(900 - b - 44).toBeGreaterThanOrEqual(850);
  });
  it("compact but the bar is not there yet: above its usual height", () => expect(dockBottom({ paneBottom: 900, windowHeight: 900, compact: true })).toBe(72));
});
