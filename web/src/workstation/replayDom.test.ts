// FX5 · #8: what covers the top of the pane is measured with the follow status capsule too (it hangs under the toolbar), and the fit keeps clear of it. Pure part: `occupiedFrom`.
import { describe, expect, it } from "vitest";
import { BOTTOM, occupiedFrom, TOP } from "./replayDom";
import { followView } from "./replayFollow";

const rect = (top: number, bottom: number, w = 300) => ({ top, bottom, width: w, height: bottom - top });

describe("occupiedFrom", () => {
  const pane = { top: 54, bottom: 900 };
  it("the top is what the lowest of the covering things reaches: the toolbar, then the capsule under it", () => {
    expect(occupiedFrom(pane, [rect(100, 150)], []).top).toBe(96);
    expect(occupiedFrom(pane, [rect(100, 150), rect(156, 182)], []).top).toBe(128);
  });
  it("things that are not there (zero size) do not count; the bottom is measured from the pane's bottom", () => {
    expect(occupiedFrom(pane, [rect(100, 150, 0)], [rect(850, 900)]).top).toBe(0);
    expect(occupiedFrom(pane, [], [rect(850, 900)]).bottom).toBe(50);
  });
  it("the selectors name the capsule (it was not counted before), the toolbar and the crumbs", () => {
    expect(TOP).toContain(".ws-follow-status");
    expect(TOP).toContain(".App-menu_top");
    expect(TOP).toContain(".nest-crumbs");
    expect(BOTTOM).toContain(".layer-ui__wrapper__footer");
  });
  it("the follow view with the capsule counted keeps the figure's room under it (the figure is not put where the capsule is)", () => {
    const base = { pane: { w: 900, h: 700 }, margin: 28, figure: { x: 400, y: 100 }, node: null, room: { up: 120, side: 170, down: 20 }, zoom: { preferred: 1, min: 0.7, max: 1 }, current: null, dead: 0.18 };
    const without = followView({ ...base, occupied: { top: 96, right: 0, bottom: 0, left: 0 } });
    const withCapsule = followView({ ...base, occupied: { top: 128, right: 0, bottom: 0, left: 0 } });
    const headY = (v: { zoom: number; scrollY: number }) => (100 + v.scrollY) * v.zoom - 120; // the top of the head's room, screen px
    expect(headY(without.view)).toBeGreaterThanOrEqual(96);
    expect(headY(withCapsule.view)).toBeGreaterThanOrEqual(128);
  });
});
