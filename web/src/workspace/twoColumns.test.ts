// The window is two columns by default: canvases on the left, sessions on the right (workspace/twoColumns.ts). Dropping a
// tab never makes another column; 「恢复默认布局」 puts any layout, an old many-column one too, back to two.
import { describe, expect, it } from "vitest";
import { group, groupOf, groups, type Node } from "./layout.ts";
import { defaultLayout, dropTab } from "./twoColumns.ts";

const g = (id: string, tabs: string[], active = tabs[0]): Node => ({ ...group(tabs, active), id });
const row = (...children: Node[]): Node => ({ kind: "split", id: "s", dir: "row", sizes: children.map(() => 1 / children.length), children });
const kindOf = (t: string) => (t.startsWith("c") ? "canvas" : t.startsWith("p") ? "session" : undefined);
const tabsOf = (n: Node) => groups(n).flatMap((x) => x.tabs).sort();

describe("dropTab: a tab dropped on a column joins it", () => {
  const two = row(g("L", ["c1", "c2"]), g("R", ["p1"]));
  it("into another column: it becomes a tab there, the number of columns does not grow", () => {
    const next = dropTab(two, "c2", "R", 1);
    expect(groups(next).length).toBe(2);
    expect(groupOf(next, "c2")!.id).toBe("R");
    expect(groupOf(next, "c2")!.tabs).toEqual(["p1", "c2"]);
  });
  it("into its own column: only the order changes", () => {
    const next = dropTab(two, "c2", "L", 0);
    expect(groups(next).length).toBe(2);
    expect(groupOf(next, "c2")!.tabs).toEqual(["c2", "c1"]);
  });
  it("never more columns than before, wherever it is dropped", () => {
    const four = row(g("A", ["c1"]), g("B", ["p1", "p2"]), g("C", ["c2"]), g("D", ["p3"]));
    for (const tab of ["c1", "p1", "p2", "c2", "p3"]) for (const target of ["A", "B", "C", "D"]) expect(groups(dropTab(four, tab, target)).length).toBeLessThanOrEqual(4);
    expect(groups(dropTab(two, "c1", "R")).length).toBeLessThanOrEqual(2);
    expect(tabsOf(dropTab(two, "c1", "R"))).toEqual(tabsOf(two));
  });
});

describe("defaultLayout: 恢复默认布局", () => {
  const many = row(g("A", ["c1"]), g("B", ["p1", "p2"], "p2"), g("C", ["c2"]), g("D", ["p3"]));
  it("any layout goes back to two columns, every tab kept: canvases left, sessions right", () => {
    const next = defaultLayout(many, kindOf);
    expect(next.kind).toBe("split");
    const cols = groups(next);
    expect(cols.length).toBe(2);
    expect(cols[0].tabs).toEqual(["c1", "c2"]);
    expect(cols[1].tabs).toEqual(["p1", "p2", "p3"]);
    expect(next.kind === "split" && next.sizes).toEqual([0.6, 0.4]);
  });
  it("the tab that was showing stays the one showing in its column", () => {
    const cols = groups(defaultLayout(many, kindOf));
    expect(cols[1].active).toBe("p2");
    expect(cols[0].active).toBe("c1");
  });
  it("only canvases (or only sessions): one column", () => {
    expect(groups(defaultLayout(row(g("A", ["c1"]), g("B", ["c2"])), kindOf)).length).toBe(1);
    expect(groups(defaultLayout(row(g("A", ["p1"]), g("B", ["p2"])), kindOf)).length).toBe(1);
  });
  it("already two columns like that: the same", () => {
    const next = defaultLayout(row(g("L", ["c1"]), g("R", ["p1"])), kindOf);
    expect(groups(next).map((x) => x.tabs)).toEqual([["c1"], ["p1"]]);
  });
});
