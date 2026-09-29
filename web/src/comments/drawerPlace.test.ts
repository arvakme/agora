// The comment list floats over the canvas (docs/workstation.md 评论): it takes no room from the canvas, sits at the top
// right, can be dragged, folds to a small button, and remembers where it was and whether it was folded, per browser.
import { describe, expect, it } from "vitest";
import { BOTTOM_CLEAR, DEFAULT_PLACE, MAX_W, TOP_CLEAR, clampPlace, loadPanel, panelBox, savePanel } from "./drawerPlace.ts";

const panes = [{ w: 600, h: 700 }, { w: 1000, h: 800 }, { w: 1440, h: 900 }, { w: 320, h: 500 }];

describe("panelBox", () => {
  it("starts at the top right, below the canvas's own top row and above its bottom controls", () => {
    for (const pane of panes) {
      const b = panelBox(DEFAULT_PLACE, pane);
      expect(b.y).toBeGreaterThanOrEqual(TOP_CLEAR);
      expect(b.y + b.h).toBeLessThanOrEqual(pane.h - BOTTOM_CLEAR);
      expect(b.x + b.w).toBeLessThanOrEqual(pane.w);
      expect(b.x).toBeGreaterThanOrEqual(0);
    }
  });

  it("is as wide as it likes on a wide canvas and shrinks to fit a narrow one", () => {
    expect(panelBox(DEFAULT_PLACE, { w: 1440, h: 900 }).w).toBe(MAX_W);
    expect(panelBox(DEFAULT_PLACE, { w: 320, h: 500 }).w).toBeLessThan(320);
  });
});

describe("clampPlace", () => {
  it("keeps a dragged panel inside the canvas, whatever the pointer did", () => {
    const pane = { w: 1000, h: 800 };
    const far = clampPlace({ right: -500, top: -500 }, pane);
    const b = panelBox(far, pane);
    expect(b.x + b.w).toBeLessThanOrEqual(pane.w);
    expect(b.y).toBeGreaterThanOrEqual(0);
    const low = panelBox(clampPlace({ right: 9999, top: 9999 }, pane), pane);
    expect(low.x).toBeGreaterThanOrEqual(0);
    expect(low.y + low.h).toBeLessThanOrEqual(pane.h);
  });

  it("brings a saved place back inside when the window got smaller", () => {
    const saved = { right: 12, top: 700 };
    const b = panelBox(clampPlace(saved, { w: 600, h: 500 }), { w: 600, h: 500 });
    expect(b.y + b.h).toBeLessThanOrEqual(500);
  });
});

describe("remembering", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it("keeps the place and the folded state for the next visit", () => {
    const s = store();
    savePanel({ place: { right: 40, top: 120 }, folded: true }, s);
    expect(loadPanel(s)).toEqual({ place: { right: 40, top: 120 }, folded: true });
  });

  it("starts unfolded at the default place with nothing saved, and shrugs off damage or a browser without storage", () => {
    expect(loadPanel(store())).toEqual({ place: DEFAULT_PLACE, folded: false });
    const bad = store();
    bad.setItem("agora.commentsPanel", "{not json");
    expect(loadPanel(bad)).toEqual({ place: DEFAULT_PLACE, folded: false });
    expect(loadPanel({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } })).toEqual({ place: DEFAULT_PLACE, folded: false });
    expect(() => savePanel({ place: DEFAULT_PLACE, folded: false }, { getItem: () => null, setItem: () => { throw new Error("blocked"); } })).not.toThrow();
  });
});
