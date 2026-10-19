// The tab row of a whole-project share (server/canvas/share.py project_tree): which tabs show, and which canvas a replay is of.
import { describe, expect, it } from "vitest";
import { replayRoot, tabItems, type GuestTab } from "./tabs";

const tabs: GuestTab[] = [
  { id: "arch", children: [{ id: "users", depth: 1 }, { id: "sessions", depth: 2 }] },
  { id: "flow", children: [{ id: "steps", depth: 1 }] },
  { id: "misc", children: [] },
];

describe("tabItems", () => {
  it("the viewed canvas's tree follows its top-level tab; other parents fold to a count", () => {
    expect(tabItems(tabs, "arch", "users")).toEqual([
      { id: "arch", depth: 0, on: false, folded: 0 },
      { id: "users", depth: 1, on: true, folded: 0 },
      { id: "sessions", depth: 2, on: false, folded: 0 },
      { id: "flow", depth: 0, on: false, folded: 1 },
      { id: "misc", depth: 0, on: false, folded: 0 },
    ]);
  });
  it("on the top-level canvas itself, that tab is the marked one", () => expect(tabItems(tabs, "misc", "misc").filter((t) => t.on).map((t) => t.id)).toEqual(["misc"]));
});

describe("replayRoot", () => {
  it("a project share replays the top-level canvas the viewed one belongs to", () => expect(replayRoot({ canvas: { id: "users" }, path: [{ id: "arch" }, { id: "users" }], share: { scope: "project" } })).toBe("arch"));
  it("a canvas share replays the shared canvas, however deep the guest is", () => expect(replayRoot({ canvas: { id: "users" }, path: [{ id: "arch" }, { id: "users" }], share: { scope: "canvas", root: "arch" } })).toBe("arch"));
});
