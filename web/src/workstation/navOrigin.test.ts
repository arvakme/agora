// FX4 · P2 #4: who changed the canvas is told at the place it happens (the app's `go`, popstate, tabs) — not guessed later from how recent some input was.
import { describe, expect, it } from "vitest";
import { byCamera, userNav } from "./navOrigin";

describe("userNav: the person's own navigation, as events", () => {
  it("note() counts and tells the listeners; the camera's own navigation (byCamera) is not the person's", () => {
    let told = 0;
    const off = userNav.subscribe(() => told++);
    const s0 = userNav.seq();
    userNav.note();
    expect(userNav.seq()).toBe(s0 + 1);
    expect(told).toBe(1);
    byCamera(() => userNav.note());
    expect(userNav.seq()).toBe(s0 + 1);
    expect(told).toBe(1);
    off();
    userNav.note();
    expect(told).toBe(1);
  });
  it("byCamera passes the value through, nests, and lets go when the function throws", () => {
    expect(byCamera(() => 5)).toBe(5);
    const s0 = userNav.seq();
    byCamera(() => byCamera(() => userNav.note()));
    expect(() => byCamera(() => { throw new Error("x"); })).toThrow("x");
    userNav.note();
    expect(userNav.seq()).toBe(s0 + 1);
  });
});
