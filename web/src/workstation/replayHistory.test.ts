// A PR replay's camera goes into and out of sub-diagrams with the app's own navigation (`nav.go`, which
// pushes a browser-history entry each time). During a replay those pushes are replaced instead, so
// the history is what it was before the replay; on leaving, the address is the one it was entered with
// (minus the replay's own ?replay=).
import { describe, expect, it, vi } from "vitest";
import { replacingPush, withoutReplayParam } from "./replayHistory.ts";

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

describe("withoutReplayParam: the address to leave behind", () => {
  it("drops ?replay= and keeps the rest", () => {
    expect(withoutReplayParam("http://h/?replay=pr-1&canvas=c1#x")).toBe("/?canvas=c1#x");
    expect(withoutReplayParam("http://h/p?replay=pr-1")).toBe("/p");
  });
  it("leaves an address without it as it was", () => {
    expect(withoutReplayParam("http://h/?canvas=c1")).toBe("/?canvas=c1");
    expect(withoutReplayParam("http://h/")).toBe("/");
  });
});
