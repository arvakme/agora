// 「标出改动」holds the outline until it is clicked again; hovering a step only lends one while the pointer is on it.
import { beforeEach, describe, expect, it } from "vitest";
import { highlight } from "./ui";

const A = { canvasId: "c1", ids: ["a"], key: "turn-1" };
const B = { canvasId: "c1", ids: ["b"], key: "turn-2" };

beforeEach(() => {
  highlight.unpin();
  highlight.set(null);
});

describe("highlight", () => {
  it("draws the hovered step while there is no pinned one", () => {
    highlight.set(A);
    expect(highlight.get()).toEqual(A);
    highlight.set(null);
    expect(highlight.get()).toBeNull();
  });

  it("a pinned step stays when the pointer leaves the row", () => {
    highlight.toggle(A);
    highlight.set(B);
    expect(highlight.get()).toEqual(A); // hovering another step does not take the outline
    highlight.set(null);
    expect(highlight.get()).toEqual(A);
    expect(highlight.pinned()).toEqual(A);
  });

  it("the same key again lets go", () => {
    highlight.toggle(A);
    highlight.toggle(A);
    expect(highlight.pinned()).toBeNull();
    expect(highlight.get()).toBeNull();
  });

  it("another step replaces the pinned one", () => {
    highlight.toggle(A);
    highlight.toggle(B);
    expect(highlight.pinned()).toEqual(B);
  });

  it("unpin(key) only lets go of that step's outline", () => {
    highlight.toggle(A);
    highlight.unpin("turn-2");
    expect(highlight.pinned()).toEqual(A);
    highlight.unpin("turn-1");
    expect(highlight.pinned()).toBeNull();
  });

  it("tells its listeners each change once", () => {
    let n = 0;
    const off = highlight.subscribe(() => n++);
    highlight.toggle(A);
    highlight.toggle(A);
    off();
    expect(n).toBe(2);
  });
});
