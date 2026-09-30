// Going back up from a child canvas: ⌘↑ (Mac) / Ctrl+↑ goes to the parent, except while typing or
// when Excalidraw's flowchart owns the key (one box selected); the one-time hint remembers its dismissal.
import { describe, expect, it } from "vitest";
import type { El } from "../canvas/scene.ts";
import { parentIndex } from "./graph.ts";
import { backHintSeen, isUpKey, markBackHintSeen, onBackHintSeen, parentCanvas, upKeyLabel, upOnKey } from "./up.ts";

const key = (k: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; editable: boolean }>) => ({ key: "ArrowUp", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k });
const node = (id: string, type = "rectangle", child?: string) => ({ id, type, isDeleted: false, groupIds: [], customData: child ? { childCanvas: child } : {} }) as unknown as El;
// 总架构 (c1) › 后端 (be) › 订单 (orders)
const index = parentIndex(new Map([["c1", [node("api", "rectangle", "be")]], ["be", [node("o", "rectangle", "orders")]], ["orders", []]]));

describe("the up shortcut", () => {
  it("is ⌘↑ on a Mac and Ctrl+↑ elsewhere, with nothing else held", () => {
    expect(isUpKey(key({ metaKey: true }), true)).toBe(true);
    expect(isUpKey(key({ ctrlKey: true }), true)).toBe(false);
    expect(isUpKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isUpKey(key({ metaKey: true, shiftKey: true }), true)).toBe(false); // ⇧⌘↑ is Excalidraw's
    expect(isUpKey(key({ metaKey: true, key: "ArrowLeft" }), true)).toBe(false);
    expect(isUpKey(key({}), true)).toBe(false); // a bare ↑ moves the selection
    expect(upKeyLabel(true)).toBe("⌘↑");
    expect(upKeyLabel(false)).toBe("Ctrl+↑");
  });
  it("goes one level up, and nowhere from the top", () => {
    expect(parentCanvas("orders", index)).toBe("be");
    expect(upOnKey(key({ metaKey: true }), "orders", index, [], true)).toBe("be");
    expect(upOnKey(key({ metaKey: true }), "be", index, [], true)).toBe("c1");
    expect(upOnKey(key({ metaKey: true }), "c1", index, [], true)).toBeNull();
  });
  it("leaves the key alone while typing or when Excalidraw grows a flowchart from one selected box", () => {
    expect(upOnKey(key({ metaKey: true, editable: true }), "be", index, [], true)).toBeNull();
    expect(upOnKey(key({ metaKey: true }), "be", index, [node("x")], true)).toBeNull();
    expect(upOnKey(key({ metaKey: true }), "be", index, [node("x", "text")], true)).toBe("c1");
    expect(upOnKey(key({ metaKey: true }), "be", index, [node("x"), node("y")], true)).toBe("c1"); // a group: not a flowchart start
  });
});

describe("the one-time hint", () => {
  it("shows until dismissed, then stays dismissed in this browser", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    let heard = 0;
    const off = onBackHintSeen(() => heard++);
    expect(backHintSeen(s)).toBe(false);
    markBackHintSeen(s);
    expect(backHintSeen(s)).toBe(true);
    expect(heard).toBe(1);
    off();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(backHintSeen(broken)).toBe(false);
    expect(() => markBackHintSeen(broken)).not.toThrow();
  });
});
