// The one-time 「在子图里。点左上角返回…」 hint (nested/up.ts) stays quiet while a turn plays: its
// camera goes in and out of sub-diagrams by itself and the hint would sit on the menu. Nothing is
// marked as seen, so a person who walks into a sub-diagram afterwards still gets it.
import { describe, expect, it } from "vitest";
import { backHintQuiet, backHintSeen, backHintVisible } from "./up.ts";

describe("backHintVisible", () => {
  it("shows for someone who has not seen it, unless quiet", () => {
    expect(backHintVisible(false, false)).toBe(true);
    expect(backHintVisible(false, true)).toBe(false);
  });
  it("never shows once seen", () => {
    expect(backHintVisible(true, false)).toBe(false);
    expect(backHintVisible(true, true)).toBe(false);
  });
});

describe("backHintQuiet", () => {
  it("is off by default, tells listeners when it changes, and does not mark the hint seen", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const seen: boolean[] = [];
    const off = backHintQuiet.subscribe(() => seen.push(backHintQuiet.get()));
    expect(backHintQuiet.get()).toBe(false);
    backHintQuiet.set(true);
    backHintQuiet.set(true);
    backHintQuiet.set(false);
    off();
    expect(seen).toEqual([true, false]);
    expect(backHintSeen(store)).toBe(false);
  });
});
