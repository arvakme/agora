// Going into a sub-diagram is asked for explicitly (nested/enter.ts): the small mark on the node, the breadcrumb, a
// `?canvas=` link, the entrance capsule — and Shift+Enter on the selected node. A double-click is Excalidraw's own.
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene";
import { ENTER_KEY_LABEL, enterOnKey, isEnterKey, MARK_SIZE } from "./enter.ts";

const key = (o: Partial<Parameters<typeof isEnterKey>[0]> = {}) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, ...o });
const node = { id: "api", customData: { childCanvas: "c-api" } } as unknown as El;
const plain = { id: "web" } as unknown as El;
const childOf = (e: El) => ((e.customData as { childCanvas?: string } | undefined)?.childCanvas ?? null);
const exists = (c: string) => c === "c-api";

describe("Shift+Enter on the selected node", () => {
  it("goes into its sub-diagram", () => {
    expect(enterOnKey(key(), node, childOf, exists)).toBe("c-api");
  });
  it("is written ⇧↵ in the help", () => {
    expect(ENTER_KEY_LABEL).toBe("⇧↵");
  });
  it("only Shift+Enter: Enter alone edits the node's text, other modifiers are other shortcuts", () => {
    expect(isEnterKey(key({ shiftKey: false }))).toBe(false);
    expect(isEnterKey(key({ metaKey: true }))).toBe(false);
    expect(isEnterKey(key({ ctrlKey: true }))).toBe(false);
    expect(isEnterKey(key({ altKey: true }))).toBe(false);
    expect(isEnterKey(key({ key: "a" }))).toBe(false);
    expect(enterOnKey(key({ shiftKey: false }), node, childOf, exists)).toBeNull();
  });
  it("not while typing in a text field (Shift+Enter is a new line there)", () => {
    expect(enterOnKey({ ...key(), editable: true }, node, childOf, exists)).toBeNull();
  });
  it("nothing to enter: no node selected, a node without a sub-diagram, a sub-diagram that is gone", () => {
    expect(enterOnKey(key(), undefined, childOf, exists)).toBeNull();
    expect(enterOnKey(key(), plain, childOf, exists)).toBeNull();
    expect(enterOnKey(key(), { id: "x", customData: { childCanvas: "c-gone" } } as unknown as El, childOf, exists)).toBeNull();
  });
});

describe("the mark on a node with a sub-diagram", () => {
  it("has a click target of at least 24 px", () => {
    expect(MARK_SIZE).toBeGreaterThanOrEqual(24);
  });
});
