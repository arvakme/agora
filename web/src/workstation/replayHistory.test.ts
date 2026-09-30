// The camera of a played turn goes into and out of sub-diagrams with the app's own navigation (`nav.go`, which
// pushes a browser-history entry each time). While it plays those pushes are replaced instead, so the
// history is what it was before.
import { describe, expect, it, vi } from "vitest";
import { replacingPush } from "./replayHistory.ts";

const fake = () => {
  const h = { pushState: vi.fn(), replaceState: vi.fn() };
  return h;
};

describe("replacingPush: pushState becomes replaceState for the length of one call", () => {
  it("a push made inside goes to replaceState with the same arguments", () => {
    const h = fake();
    const push = h.pushState;
    replacingPush(() => h.pushState({ canvas: "c2" }, "", "/?canvas=c2"), h);
    expect(push).not.toHaveBeenCalled();
    expect(h.replaceState).toHaveBeenCalledWith({ canvas: "c2" }, "", "/?canvas=c2");
  });
  it("outside, pushState is the original again", () => {
    const h = fake();
    const push = h.pushState;
    replacingPush(() => {}, h);
    expect(h.pushState).toBe(push);
    h.pushState({}, "", "/x");
    expect(push).toHaveBeenCalledTimes(1);
  });
  it("and is put back even when what it ran throws", () => {
    const h = fake();
    const push = h.pushState;
    expect(() => replacingPush(() => { throw new Error("x"); }, h)).toThrow("x");
    expect(h.pushState).toBe(push);
  });
  it("returns what the call returned", () => {
    expect(replacingPush(() => 7, fake())).toBe(7);
  });
});
