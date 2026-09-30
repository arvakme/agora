// Where a comment card opens (ACC1 #12): beside its pin as before, but never over the element the comment is about —
// the reply is read next to what it changed. Other side first, then above / below the element.
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { CARD_W, DOCK_CLEAR, placeCard, type CardPos } from "./cardPlace";

const pane = { w: 863, h: 720 };
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The card's worst-case rectangle (its height is the content's, at most maxH). */
const rect = (p: CardPos): Box => ({ x: p.left, y: p.up ? pane.h - p.bottom! - p.maxH : p.top!, w: CARD_W, h: p.maxH });

describe("placeCard", () => {
  it("nothing to keep off: opens to the right of the pin, in the upper half downwards", () => {
    const p = placeCard({ pin: { x: 200, y: 150 }, pane, avoid: [] });
    expect(p).toMatchObject({ left: 228, top: 116, flip: false, up: false });
  });

  it("no room on the right: flips to the left of the pin", () => {
    const p = placeCard({ pin: { x: 700, y: 150 }, pane, avoid: [] });
    expect(p).toMatchObject({ left: 700 - CARD_W - 12, flip: true });
  });

  it("the element sits to the left of its pin (a pin is on the top-right corner): the card takes the right side when it fits", () => {
    const node = { x: 300, y: 180, w: 200, h: 90 };
    const p = placeCard({ pin: { x: 490, y: 150 }, pane: { w: 1200, h: 720 }, avoid: [node] });
    expect(hit(rect(p), node)).toBe(false);
    expect(p.flip).toBe(false);
  });

  it("the pin's element is on the side the card would flip to: it goes to the other side instead", () => {
    // pane 863 wide: the right side does not fit, the left one lies over the node
    const node = { x: 420, y: 180, w: 240, h: 90 };
    const p = placeCard({ pin: { x: 655, y: 150 }, pane, avoid: [node] });
    expect(hit(rect(p), node)).toBe(false);
  });

  it("neither side is free (a narrow pane): the card goes below the element, or above it when there is no room below", () => {
    const node = { x: 450, y: 300, w: 200, h: 90 };
    const below = placeCard({ pin: { x: 645, y: 270 }, pane: { w: 863, h: 900 }, avoid: [node] });
    expect(hit(rect(below), node)).toBe(false);
    expect(below.top).toBeGreaterThanOrEqual(node.y + node.h);
    const low = { x: 450, y: 560, w: 200, h: 90 };
    const above = placeCard({ pin: { x: 645, y: 530 }, pane: { w: 863, h: 720 }, avoid: [low] });
    expect(hit(rect(above), low)).toBe(false);
    expect(above.up).toBe(true);
  });

  it("always inside the pane and above the dock", () => {
    for (const pin of [{ x: 20, y: 30 }, { x: 800, y: 40 }, { x: 430, y: 400 }, { x: 830, y: 690 }, { x: 10, y: 700 }]) {
      const p = placeCard({ pin, pane, avoid: [{ x: pin.x - 200, y: pin.y + 20, w: 200, h: 80 }] });
      const r = rect(p);
      expect(r.x, JSON.stringify(pin)).toBeGreaterThanOrEqual(8);
      expect(r.x + r.w, JSON.stringify(pin)).toBeLessThanOrEqual(pane.w - 8);
      expect(r.y + r.h, JSON.stringify(pin)).toBeLessThanOrEqual(pane.h - (p.up ? 0 : DOCK_CLEAR) + 1);
    }
  });
});
