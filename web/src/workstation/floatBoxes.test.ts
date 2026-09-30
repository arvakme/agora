// FL3: where the floating shells are over one canvas pane, in the frame of the layer that draws the figures (bubbles and the talk box keep off them). Pure part: `floatBoxesIn`.
import { describe, expect, it } from "vitest";
import { floatBoxesIn } from "./floatBoxes";

const layer = { left: 0, top: 54, width: 1440, height: 800 };
const r = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe("floatBoxesIn", () => {
  it("a panel down the right: its box in the layer's frame (the layer's corner is 0, 0)", () => {
    expect(floatBoxesIn(layer, [r(1008, 146, 420, 700)])).toEqual([{ x: 1008, y: 92, w: 420, h: 700 }]);
  });
  it("cut to the layer: the part over another pane, or below the window's edge, is not this pane's", () => {
    expect(floatBoxesIn(layer, [r(1300, 700, 400, 400)])).toEqual([{ x: 1300, y: 646, w: 140, h: 154 }]);
    expect(floatBoxesIn({ left: 0, top: 54, width: 600, height: 800 }, [r(1008, 146, 420, 700)])).toEqual([]);
  });
  it("a sliver or nothing counts for nothing", () => {
    expect(floatBoxesIn(layer, [r(100, 100, 1, 500), r(100, 100, 0, 0)])).toEqual([]);
  });
  it("several shells: each its own box", () => {
    expect(floatBoxesIn(layer, [r(1008, 146, 420, 300), r(1200, 500, 228, 36)]).length).toBe(2);
  });
});
