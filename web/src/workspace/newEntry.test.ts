// Entry points for a fresh start: the「+」menu, where a new session lands, and which level a tab shows on first screen.
import { describe, expect, it } from "vitest";
import { group, groupOf, groups, moveTab } from "./layout.ts";
import { firstScreen, openIds, placeDoc, placeQuiet, plusMenu, savedWorkspace } from "./model.ts";

const kinds: Record<string, "canvas" | "session"> = { top: "canvas", sub: "canvas", other: "canvas", p1: "session", p2: "session" };
const kindOf = (id: string) => kinds[id];

describe("plusMenu", () => {
  it("canvas groups offer a new session right under a new canvas", () => {
    expect(plusMenu("canvas")).toEqual(["canvas", "session", "sample", "open"]);
  });
  it("mixed groups offer the same", () => {
    expect(plusMenu("mixed")).toEqual(["canvas", "session", "sample", "open"]);
  });
  it("session groups have no menu: the「+」creates a session directly", () => {
    expect(plusMenu("session")).toBeNull();
  });
});

describe("placeDoc: a new session", () => {
  it("with a session column already there, joins it and becomes its active tab", () => {
    const base = group(["top", "p1"]);
    const split = moveTab(base, "p1", base.id, "right");
    const [, right] = groups(split);
    const next = placeDoc(split, "p2", "session", { kindOf: (t) => (t === "p2" ? "session" : kindOf(t)), linkedCanvas: "top", focused: "top" });
    expect(groups(next)).toHaveLength(2);
    expect(groupOf(next, "p2")?.id).toBe(right.id);
    expect(groupOf(next, "p2")?.active).toBe("p2");
  });
  it("with no session column, splits one off to the canvas's right, canvas about 60%", () => {
    const root = group(["top"]);
    const next = placeDoc(root, "p2", "session", { kindOf: (t) => (t === "p2" ? "session" : kindOf(t)), linkedCanvas: "top", focused: "top" });
    expect(next.kind).toBe("split");
    if (next.kind !== "split") return;
    expect(next.dir).toBe("row");
    expect(next.sizes).toEqual([0.6, 0.4]);
    expect(groups(next).map((g) => g.tabs)).toEqual([["top"], ["p2"]]);
  });
});

describe("firstScreen", () => {
  const topOf = (id: string) => (id === "sub" ? "top" : id);
  it("without a ?canvas= link, a tab left in a child canvas shows its tree's top", () => {
    const r = firstScreen({ root: group(["sub", "p1"], "sub"), focused: "sub", urlCanvas: null, topOf, kindOf });
    expect(openIds(r.root)).toEqual(["top", "p1"]);
    expect(groups(r.root)[0].active).toBe("top");
    expect(r.focused).toBe("top");
  });
  it("a tab already on the top, and session tabs, stay", () => {
    const root = group(["top", "other", "p1"], "other");
    const r = firstScreen({ root, focused: "p1", urlCanvas: null, topOf, kindOf });
    expect(r.root).toBe(root);
    expect(r.focused).toBe("p1");
  });
  it("with a ?canvas= link (also a reload inside a child) the layout is left alone", () => {
    const root = group(["sub"]);
    expect(firstScreen({ root, focused: "sub", urlCanvas: "sub", topOf, kindOf })).toEqual({ root, focused: "sub" });
  });
  it("a top and one of its children both open collapse into the top", () => {
    const r = firstScreen({ root: group(["top", "sub"], "sub"), focused: "sub", urlCanvas: null, topOf, kindOf });
    expect(openIds(r.root)).toEqual(["top"]);
    expect(r.focused).toBe("top");
  });
});

describe("FX2a · #2b: a canvas opened for an agent's read does not take the pane from the person", () => {
  const ctx = { kindOf: (t: string) => (t === "child" ? ("canvas" as const) : kindOf(t)), recentCanvas: "top", focused: "top" };
  it("its tab is added, and the tab the person is looking at stays the active one; nothing is split", () => {
    const root = group(["top", "c2"], "top");
    const next = placeQuiet(root, "child", ctx);
    expect(openIds(next)).toContain("child");
    expect(groups(next)).toHaveLength(1);
    expect(groups(next)[0].active).toBe("top");
  });
  it("a session next to it: also untouched", () => {
    const base = group(["top", "p1"], "top");
    const split = moveTab(base, "p1", base.id, "right");
    const next = placeQuiet(split, "child", ctx);
    expect(groups(next).map((g) => g.active)).toEqual(groups(split).map((g) => g.active));
    expect(groups(next)).toHaveLength(2);
  });
  it("the ordinary open still takes the pane (the person asked for it)", () => {
    const root = group(["top"], "top");
    expect(groups(placeDoc(root, "child", "canvas", ctx))[0].active).toBe("child");
  });
});

describe("FX4 · P2 #3: a quiet tab is not saved into the person's layout", () => {
  it("opened quietly, saved: the open list has no such tab (docs stay); once the person took it, it is saved", () => {
    const docs = [
      { id: "top", kind: "canvas" as const, title: "top" },
      { id: "child", kind: "canvas" as const, title: "child" },
    ];
    const root = placeQuiet(group(["top"], "top"), "child", { kindOf: (t: string) => (t === "child" ? ("canvas" as const) : kindOf(t)), recentCanvas: "top", focused: "top" });
    expect(openIds(root)).toContain("child");
    const hidden = savedWorkspace({ docs, root, focused: "top" }, () => false, () => undefined, new Set(["child"]));
    expect(openIds(hidden.root)).toEqual(["top"]);
    expect(hidden.docs.map((d) => d.id)).toEqual(["top", "child"]);
    const owned = savedWorkspace({ docs, root, focused: "top" }, () => false, () => undefined, new Set());
    expect(openIds(owned.root)).toEqual(["top", "child"]);
  });
  it("a focused quiet tab is not the saved focus", () => {
    const docs = [
      { id: "top", kind: "canvas" as const, title: "top" },
      { id: "child", kind: "canvas" as const, title: "child" },
    ];
    const root = group(["top", "child"], "top");
    const out = savedWorkspace({ docs, root, focused: "child" }, () => false, () => undefined, new Set(["child"]));
    expect(out.focused).toBe("top");
  });
});
