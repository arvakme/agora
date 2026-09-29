// The follow view lives in the window manager as a tab (web/docs/workstation.md §10): where it goes when it
// first opens — a new group to the right of the canvas's, which puts it between the canvas and a session
// group already on the right — where it goes again once the person has moved it, and that it is never saved
// in the project's layout. Pure.
import { describe, expect, it } from "vitest";
import { group, groupOf, groups, moveTab, type Node, type Split } from "./layout.ts";
import { FOLLOW_TAB, followHome, insertFollow, isFollowTab, spotOf, withoutFollow } from "./followTab.ts";
import { savedWorkspace, type Doc } from "./model.ts";

const canvas = group(["c1"], "c1");
const session = group(["s1"], "s1");
const row = (children: Node[], sizes = children.map(() => 1 / children.length)): Split => ({ kind: "split", id: "row1", dir: "row", sizes, children });
const col = (children: Node[]): Split => ({ kind: "split", id: "col1", dir: "col", sizes: children.map(() => 1 / children.length), children });
const order = (n: Node) => groups(n).map((g) => g.tabs.join("+"));

describe("followHome: where the follow tab goes", () => {
  it("nowhere new when it is already there", () => {
    expect(followHome(row([canvas, group([FOLLOW_TAB]), session]), "c1")).toEqual({ action: "keep" });
  });
  it("a new group to the right of the canvas's group otherwise", () => {
    expect(followHome(canvas, "c1")).toEqual({ action: "split", target: canvas.id, zone: "right" });
  });
  it("the canvas's group is found by the canvas's tab, wherever it is", () => {
    const other = group(["c2", "c1"], "c2");
    expect(followHome(row([session, other]), "c1")).toEqual({ action: "split", target: other.id, zone: "right" });
  });
  it("falls back to the first group when the canvas is not open", () => {
    expect(followHome(row([session, group(["c2"])]), "nope")).toEqual({ action: "split", target: session.id, zone: "right" });
  });
});

describe("insertFollow", () => {
  it("canvas alone: canvas | follow, the canvas keeping most of the width", () => {
    const root = insertFollow(canvas, "c1");
    expect(order(root)).toEqual(["c1", FOLLOW_TAB]);
    const s = root as Split;
    expect(s.dir).toBe("row");
    expect(s.sizes[1]).toBeLessThan(s.sizes[0]);
    expect(s.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
  it("canvas | session: canvas | follow | session — between them, the session not moved", () => {
    const root = insertFollow(row([canvas, session], [0.6, 0.4]), "c1");
    expect(order(root)).toEqual(["c1", FOLLOW_TAB, "s1"]);
    const s = root as Split;
    expect(s.children).toHaveLength(3);
    expect(s.sizes[2]).toBeCloseTo(0.4, 9);
    expect(s.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
  it("canvas above a session: it splits the canvas's row, the session below is left alone", () => {
    const root = insertFollow(col([canvas, session]), "c1");
    expect(order(root)).toEqual(["c1", FOLLOW_TAB, "s1"]);
    const top = (root as Split).children[0] as Split;
    expect(top.dir).toBe("row");
    expect(groupOf(root, "s1")!.id).toBe(session.id);
  });
  it("does nothing when the tab is already open (the person may have moved it)", () => {
    const root = row([canvas, group([FOLLOW_TAB]), session]);
    expect(insertFollow(root, "c1")).toBe(root);
  });
  it("the canvas tab stays where it was and stays active", () => {
    const root = insertFollow(row([canvas, session]), "c1");
    expect(groupOf(root, "c1")!.active).toBe("c1");
    expect(groupOf(root, "c1")!.id).toBe(canvas.id);
  });
});

describe("where it opens again once the person has moved it", () => {
  it("dragged into the session group: it joins that group again", () => {
    const start = insertFollow(row([canvas, session]), "c1");
    const moved = moveTab(start, FOLLOW_TAB, session.id, "center");
    const spot = spotOf(moved, FOLLOW_TAB)!;
    expect(spot).toEqual({ kind: "joined", groupId: session.id });
    const again = insertFollow(withoutFollow(moved), "c1", spot);
    expect(groupOf(again, FOLLOW_TAB)!.id).toBe(session.id);
  });
  it("dragged to the left edge of the canvas: it splits off there again, by the canvas's tab", () => {
    const start = insertFollow(canvas, "c1");
    const moved = moveTab(start, FOLLOW_TAB, canvas.id, "left");
    expect(order(moved)).toEqual([FOLLOW_TAB, "c1"]);
    const spot = spotOf(moved, FOLLOW_TAB)!;
    expect(spot).toMatchObject({ kind: "split", anchorTab: "c1", zone: "left" });
    expect(order(insertFollow(withoutFollow(moved), "c1", spot))).toEqual([FOLLOW_TAB, "c1"]);
  });
  it("its anchor gone: the default place", () => {
    const again = insertFollow(canvas, "c1", { kind: "split", anchorTab: "gone", zone: "left" });
    expect(order(again)).toEqual(["c1", FOLLOW_TAB]);
  });
  it("nothing remembered for a tab that is not open", () => {
    expect(spotOf(canvas, FOLLOW_TAB)).toBeNull();
  });
});

describe("withoutFollow and the saved layout", () => {
  it("takes the tab out and the group that only held it", () => {
    const root = insertFollow(row([canvas, session]), "c1");
    expect(order(withoutFollow(root))).toEqual(["c1", "s1"]);
  });
  it("is the same tree when it is not there", () => {
    expect(withoutFollow(canvas)).toBe(canvas);
  });
  it("isFollowTab", () => {
    expect(isFollowTab(FOLLOW_TAB)).toBe(true);
    expect(isFollowTab("c1")).toBe(false);
  });
  it("the project's layout never holds it: savedWorkspace leaves the tab (and its group) out", () => {
    const docs: Doc[] = [{ id: "c1", kind: "canvas", title: "总架构" }, { id: "p-s1", kind: "session", sessionId: "s1", title: "" }];
    const root = insertFollow(row([group(["c1"], "c1"), group(["p-s1"], "p-s1")]), "c1");
    expect(JSON.stringify(root)).toContain(FOLLOW_TAB);
    const saved = savedWorkspace({ docs, root, focused: "c1" }, () => false);
    expect(JSON.stringify(saved)).not.toContain(FOLLOW_TAB);
    expect(order(saved.root)).toEqual(["c1", "p-s1"]);
  });
  it("and the focus is never the follow tab", () => {
    const docs: Doc[] = [{ id: "c1", kind: "canvas", title: "总架构" }];
    const root = insertFollow(canvas, "c1");
    const saved = savedWorkspace({ docs, root, focused: FOLLOW_TAB }, () => false);
    expect(saved.focused).toBe("c1");
  });
});

describe("opening and closing the tab leaves the room as it was", () => {
  const sizesOf = (n: Node) => (n.kind === "split" ? n.sizes : [1]);
  it("canvas | session: after follow comes and goes, the same sizes", () => {
    const start = row([canvas, session], [0.6, 0.4]);
    const back = withoutFollow(insertFollow(start, "c1"));
    expect(sizesOf(back)[0]).toBeCloseTo(0.6, 9);
    expect(sizesOf(back)[1]).toBeCloseTo(0.4, 9);
  });
  it("and after many times (it does not eat the canvas a bit each time)", () => {
    let root: Node = row([canvas, session], [0.5, 0.5]);
    for (let i = 0; i < 6; i++) root = withoutFollow(insertFollow(root, "c1"));
    expect(sizesOf(root)[0]).toBeCloseTo(0.5, 9);
  });
  it("closing it when the person has moved it to the far side gives the room to its neighbour", () => {
    const start = insertFollow(row([canvas, session], [0.5, 0.5]), "c1");
    const moved = moveTab(start, FOLLOW_TAB, session.id, "right");
    const back = withoutFollow(moved);
    expect(sizesOf(back).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(order(back)).toEqual(["c1", "s1"]);
  });
});
