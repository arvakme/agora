// The session head's 「画在：…」: only top-level canvases are listed (a sub-diagram belongs to its tree).
import { describe, expect, it } from "vitest";
import { canvasChoices, topOf } from "./canvasChoices.ts";

const titles = { a: "圆桌 AI 总架构", b: "controlplane", c: "webapp", d: "未命名画布 1" };
const index = new Map([
  ["b", { canvasId: "a", elementId: "n1" }],
  ["c", { canvasId: "a", elementId: "n2" }],
]);

describe("canvasChoices", () => {
  it("lists top-level canvases only, in the workspace's order", () => {
    expect(canvasChoices(titles, index)).toEqual([
      { id: "a", title: "圆桌 AI 总架构" },
      { id: "d", title: "未命名画布 1" },
    ]);
  });
  it("one top-level canvas: a single choice (the head then shows text, no dropdown)", () => {
    expect(canvasChoices({ a: "A", b: "B" }, new Map([["b", { canvasId: "a", elementId: "x" }]]))).toEqual([{ id: "a", title: "A" }]);
  });
  it("a child whose parent is not in the workspace counts as top-level", () => {
    expect(canvasChoices({ b: "B" }, new Map([["b", { canvasId: "gone", elementId: "x" }]]))).toEqual([{ id: "b", title: "B" }]);
  });
});

describe("topOf", () => {
  it("walks up to the tree's top canvas; a top canvas is its own", () => {
    expect(topOf("c", index)).toBe("a");
    expect(topOf("a", index)).toBe("a");
    expect(topOf("zzz", index)).toBe("zzz");
  });
  it("does not loop on a cycle", () => {
    const loop = new Map([["x", { canvasId: "y", elementId: "1" }], ["y", { canvasId: "x", elementId: "2" }]]);
    expect(["x", "y"]).toContain(topOf("x", loop));
  });
});
