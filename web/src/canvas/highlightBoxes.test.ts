// FX5 · #2: the outline a hovered session step draws on the canvas is on what the step changed — its nodes — not on every arrow and every label of the graph.
import { describe, expect, it } from "vitest";
import { highlightBoxes } from "./highlightBoxes";

const e = (id: string, type: string, o: Record<string, unknown> = {}) => ({ id, type, isDeleted: false, ...o });

describe("highlightBoxes", () => {
  it("a step that touched nodes, their arrows and their labels: only the nodes are outlined", () => {
    const els = [e("a", "rectangle"), e("b", "ellipse"), e("ab", "arrow"), e("a-t", "text", { containerId: "a" }), e("ab-t", "text", { containerId: "ab" })];
    expect(highlightBoxes(els).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("a step that touched only an arrow (and its label): the arrow is outlined, its label is not", () => {
    const els = [e("ab", "arrow"), e("ab-t", "text", { containerId: "ab" })];
    expect(highlightBoxes(els).map((x) => x.id)).toEqual(["ab"]);
  });
  it("a free note (text with no container) is a thing of its own", () => {
    expect(highlightBoxes([e("n", "text"), e("a", "rectangle")]).map((x) => x.id)).toEqual(["n", "a"]);
  });
  it("deleted elements are not outlined; nothing in, nothing out", () => {
    expect(highlightBoxes([e("a", "rectangle", { isDeleted: true })])).toEqual([]);
    expect(highlightBoxes([])).toEqual([]);
  });
});
