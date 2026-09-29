// While a turn plays, the right side shows only that turn; the person's own folding comes back when it ends.
import { describe, expect, it } from "vitest";
import { turnOpen } from "./replayScope.ts";

describe("turnOpen", () => {
  it("no play: the person's own folding", () => {
    expect(turnOpen(5, null, new Set([5]))).toBe(false);
    expect(turnOpen(6, null, new Set([5]))).toBe(true);
  });
  it("playing: only the played turn is open, whatever was folded", () => {
    expect(turnOpen(6, 6, new Set([6]))).toBe(true);
    expect(turnOpen(5, 6, new Set())).toBe(false);
  });
});
