// While a turn plays the trajectory follows the current step. Only the person really scrolling stops that: the program's
// own scrolling, the pane switching views, and a trackpad's leftover momentum from before the play are not.
import { describe, expect, it } from "vitest";
import { isUserScroll, quietFor, QUIET_MS } from "./followModel.ts";

const at = 10_000;
const until = at + QUIET_MS; // the program did something at `at`
describe("isUserScroll", () => {
  it("a wheel or touch move after the quiet time is the person", () => {
    expect(isUserScroll({ kind: "wheel", dy: 40 }, at + QUIET_MS + 1, until)).toBe(true);
    expect(isUserScroll({ kind: "touch" }, at + QUIET_MS + 1, until)).toBe(true);
  });
  it("the same events inside the quiet time (play just started, or the program just scrolled) are not", () => {
    expect(isUserScroll({ kind: "wheel", dy: 40 }, at + 10, until)).toBe(false);
    expect(isUserScroll({ kind: "touch" }, at + 10, until)).toBe(false);
  });
  it("a wheel event that moves nothing is not a scroll", () => {
    expect(isUserScroll({ kind: "wheel", dy: 0, dx: 0 }, at + QUIET_MS + 1, until)).toBe(false);
  });
  it("paging keys count; Space or Enter on a button is pressing it, not scrolling", () => {
    expect(isUserScroll({ kind: "key", key: "PageDown", onButton: false }, at + QUIET_MS + 1, until)).toBe(true);
    expect(isUserScroll({ kind: "key", key: " ", onButton: false }, at + QUIET_MS + 1, until)).toBe(true);
    expect(isUserScroll({ kind: "key", key: " ", onButton: true }, at + QUIET_MS + 1, until)).toBe(false);
    expect(isUserScroll({ kind: "key", key: "Enter", onButton: false }, at + QUIET_MS + 1, until)).toBe(false);
  });
});

describe("quietFor", () => {
  it("extends the quiet time, never shortens it", () => {
    expect(quietFor(5000, 1000)).toBe(5000 + QUIET_MS);
    expect(quietFor(5000, 5000 + 10 * QUIET_MS)).toBe(5000 + 10 * QUIET_MS);
  });
});
