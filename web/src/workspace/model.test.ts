// Workspace model rules: naming without gaps, close vs. open, group kinds and placement.
import { describe, expect, it } from "vitest";
import { group, groups, moveTab, type Node } from "./layout.ts";
import { closeTab, groupKind, homeGroup, migrateDocs, nextTitle, openIds, openTab, placement, UNTITLED_CANVAS } from "./model.ts";

const kinds: Record<string, "canvas" | "session"> = { c1: "canvas", c2: "canvas", c3: "canvas", p1: "session", p2: "session" };
const kindOf = (id: string) => kinds[id];

describe("nextTitle", () => {
  it("takes the smallest free number, so closed or deleted numbers are reused", () => {
    expect(nextTitle([], UNTITLED_CANVAS)).toBe("未命名画布 1");
    expect(nextTitle(["未命名画布 1", "未命名画布 3"], UNTITLED_CANVAS)).toBe("未命名画布 2");
    expect(nextTitle(["未命名画布 1", "改过名的", "未命名画布 2"], UNTITLED_CANVAS)).toBe("未命名画布 3");
  });
  it("counts each kind on its own", () => {
    expect(nextTitle(["未命名画布 1", "未命名画布 2"], "会话")).toBe("会话 1");
  });
  it("leaves the first one bare when asked", () => {
    expect(nextTitle([], "示例架构图", true)).toBe("示例架构图");
    expect(nextTitle(["示例架构图"], "示例架构图", true)).toBe("示例架构图 2");
  });
});

describe("close and reopen", () => {
  it("closing a tab keeps the rest of the layout; the last tab leaves an empty group", () => {
    let root: Node = group(["c1", "p1"]);
    root = closeTab(root, "p1");
    expect(openIds(root)).toEqual(["c1"]);
    root = closeTab(root, "c1");
    expect(root.kind).toBe("group");
    expect(openIds(root)).toEqual([]);
  });
  it("closing the last tab of one group removes that group", () => {
    const g = group(["c1", "p1"]);
    let root = moveTab(g, "p1", g.id, "right");
    expect(groups(root)).toHaveLength(2);
    root = closeTab(root, "p1");
    expect(groups(root)).toHaveLength(1);
  });
  it("reopening puts the tab back where it was, or activates it if already open", () => {
    const g = group(["c1", "c2", "c3"]);
    const at = placement(g, "c2")!;
    const closed = closeTab(g, "c2");
    const back = openTab(closed, "c2", at.groupId, at.index) as typeof g;
    expect(back.tabs).toEqual(["c1", "c2", "c3"]);
    expect(back.active).toBe("c2");
    expect((openTab(back, "c1") as typeof g).active).toBe("c1");
  });
  it("opens into an empty group", () => {
    const root = openTab(closeTab(group(["c1"]), "c1"), "c2");
    expect(openIds(root)).toEqual(["c2"]);
  });
});

describe("group kind and placement", () => {
  it("derives the kind from the tabs", () => {
    expect(groupKind(["c1", "c2"], kindOf)).toBe("canvas");
    expect(groupKind(["p1"], kindOf)).toBe("session");
    expect(groupKind(["c1", "p1"], kindOf)).toBe("mixed");
    expect(groupKind([], kindOf)).toBe("mixed");
  });
  it("new canvases join the recent canvas's group; sessions go beside their canvas", () => {
    const g = group(["c1", "p1"]);
    const root = moveTab(g, "p1", g.id, "right");
    const [left, right] = groups(root);
    expect(homeGroup(root, "canvas", { kindOf, recentCanvas: "c1", focused: "p1" })).toEqual({ groupId: left.id, split: false });
    expect(homeGroup(root, "session", { kindOf, linkedCanvas: "c1", focused: "c1" })).toEqual({ groupId: right.id, split: false });
  });
  it("splits a session off when its canvas's group is the only one", () => {
    const root = group(["c1"]);
    expect(homeGroup(root, "session", { kindOf, linkedCanvas: "c1" })).toEqual({ groupId: root.id, split: true });
  });
});

describe("migrateDocs", () => {
  it("names untitled v1 session docs 会话 1, 2… and keeps canvases", () => {
    const docs = migrateDocs([
      { id: "c1", kind: "canvas", title: "架构图 1" },
      { id: "p1", kind: "session", sessionId: "s-a" },
      { id: "p3", kind: "session", sessionId: "s-b" },
    ]);
    expect(docs.map((d) => d.title)).toEqual(["架构图 1", "会话 1", "会话 2"]);
  });
});
