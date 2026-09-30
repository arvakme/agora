// A double-click on a node is Excalidraw's own (edit its text, add text on empty canvas): nothing in the page takes it to enter a
// sub-diagram any more. The canvas view has no double-click handler and the hit test that only served it is gone.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("no double-click to enter", () => {
  it("the canvas view does not handle a double-click", () => {
    expect(src("../canvas/CanvasView.tsx")).not.toMatch(/onDoubleClick|dblclick/i);
  });
  it("the entrance mark does not swallow one either, and does not advertise it", () => {
    const s = src("./NestedLayer.tsx");
    expect(s).not.toMatch(/onDoubleClick/);
    expect(s).not.toContain("双击");
  });
  it("the hit test for it is gone", () => {
    expect(src("../canvas/nodes.ts")).not.toContain("childNodeAt");
    expect(src("./NestedLayer.tsx")).not.toContain("childAt");
  });
});
