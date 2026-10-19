import { describe, expect, it } from "vitest";
import { columns, group, groups } from "./layout.ts";
import { collapse, narrowRoot, sheetPair } from "./narrow.ts";

describe("collapse (a phone shows one pane)", () => {
  const two = columns(group(["c1", "c2"], "c2"), group(["s1"]), [0.6, 0.4]);

  it("puts every tab of every column into one group, in screen order", () => {
    const g = collapse(two, "c1");
    expect(g.tabs).toEqual(["c1", "c2", "s1"]);
  });

  it("shows the focused tab, wherever it was", () => {
    expect(collapse(two, "s1").active).toBe("s1");
    expect(collapse(two, "c2").active).toBe("c2");
  });

  it("falls back to the first tab when the focus is not in the layout", () => {
    expect(collapse(two, "gone").active).toBe("c1");
  });

  it("keeps one group id across focus changes, so the pane is not remounted when the tab changes", () => {
    expect(collapse(two, "c1").id).toBe(collapse(two, "s1").id);
  });

  it("does not touch the layout it is given", () => {
    const before = JSON.stringify(two);
    collapse(two, "s1");
    expect(JSON.stringify(two)).toBe(before);
    expect(groups(two)).toHaveLength(2);
  });
});

describe("narrowRoot (a turn plays on a phone)", () => {
  const two = columns(group(["c1", "c2"], "c2"), group(["s1"]), [0.6, 0.4]);

  it("without a play it is the one collapsed pane", () => {
    expect(narrowRoot(two, "s1", null)).toEqual(collapse(two, "s1"));
  });

  it("with a play it puts the canvas over the session, the canvas taking most of the height", () => {
    const n = narrowRoot(two, "s1", { top: "c1", bottom: "s1" });
    if (n.kind !== "split") throw new Error("expected a split");
    expect(n.dir).toBe("col");
    expect(groups(n).map((g) => g.active)).toEqual(["c1", "s1"]);
    expect(n.sizes[0]).toBeGreaterThan(n.sizes[1]);
  });

  it("keeps the same ids while the play goes on or ends, so the panes are not remounted", () => {
    const a = narrowRoot(two, "s1", { top: "c1", bottom: "s1" });
    const b = narrowRoot(two, "c1", { top: "c2", bottom: "s1" });
    expect(groups(a).map((g) => g.id)).toEqual(groups(b).map((g) => g.id));
  });

  it("falls back to the collapsed pane when one of the two tabs is not open", () => {
    expect(narrowRoot(two, "s1", { top: "gone", bottom: "s1" })).toEqual(collapse(two, "s1"));
  });
});

describe("sheetPair (the session panel as a bottom bar on a phone)", () => {
  const kind = (id: string) => (id.startsWith("c") ? "canvas" : id.startsWith("s") ? "session" : undefined);
  const canvasOf = (id: string) => ({ s1: "c1", s2: "c2" })[id];
  const open = new Set(["c1", "c2", "s1", "s2"]);

  it("pairs the focused canvas with the session that is on it", () => {
    expect(sheetPair(open, "c2", "c1", kind, canvasOf, false)).toMatchObject({ top: "c2", bottom: "s2" });
  });

  it("pairs the focused session with the canvas used last", () => {
    expect(sheetPair(open, "s1", "c2", kind, canvasOf, false)).toMatchObject({ top: "c2", bottom: "s1" });
  });

  it("is a strip of fixed height folded, and a share of the screen pulled up", () => {
    expect(sheetPair(open, "c1", "c1", kind, canvasOf, false)?.bottomPx).toBeGreaterThan(0);
    const up = sheetPair(open, "c1", "c1", kind, canvasOf, true);
    expect(up?.bottomPx).toBeUndefined();
    expect(up?.bottomShare).toBeGreaterThan(0.4);
  });

  it("pulled up, takes the share the person dragged the divider to", () => {
    expect(sheetPair(open, "c1", "c1", kind, canvasOf, true, 0.3)?.bottomShare).toBe(0.3);
    expect(sheetPair(open, "c1", "c1", kind, canvasOf, true, null)?.bottomShare).toBeGreaterThan(0.4);
  });

  it("is the one pane of tabs when there is no canvas or no session open", () => {
    expect(sheetPair(new Set(["c1"]), "c1", "c1", kind, canvasOf, false)).toBeNull();
    expect(sheetPair(new Set(["s1"]), "s1", "c1", kind, canvasOf, false)).toBeNull();
  });

  it("folded, the strip's share follows the screen height", () => {
    const n = narrowRoot(columns(group(["c1"]), group(["s1"]), [0.5, 0.5]), "c1", { top: "c1", bottom: "s1", bottomPx: 150 }, 600);
    if (n.kind !== "split") throw new Error("expected a split");
    expect(n.sizes[1]).toBeCloseTo(0.25);
  });
});

describe("narrowRoot keeps both stacked panes tall enough", () => {
  const two = columns(group(["c1"]), group(["s1"]), [0.5, 0.5]);
  const bottomOf = (share: number, height: number) => {
    const n = narrowRoot(two, "c1", { top: "c1", bottom: "s1", bottomShare: share }, height);
    if (n.kind !== "split") throw new Error("expected a split");
    return n.sizes[1];
  };

  it("pulls a share dragged on a taller screen back into range", () => {
    expect(bottomOf(0.9, 600)).toBeCloseTo(0.7); // 180 / 600 left to the canvas
    expect(bottomOf(0.1, 600)).toBeCloseTo(0.3);
  });

  it("leaves a share in range as it is", () => {
    expect(bottomOf(0.55, 600)).toBeCloseTo(0.55);
  });

  it("does not clamp on a screen too short for two minimums", () => {
    expect(bottomOf(0.9, 300)).toBeCloseTo(0.9);
  });
});

