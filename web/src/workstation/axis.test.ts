// Replay playback skips the collapsed idle stretches (workstation/axis.ts).
import { describe, expect, it } from "vitest";
import { advance } from "./axis.ts";

describe("advance (replay playback)", () => {
  const gaps = [{ a: 100, b: 1000 }];
  it("plays through a break without taking any time", () => {
    expect(advance(50, 40, gaps)).toBe(90);
    expect(advance(50, 60, gaps)).toBe(1010);
  });
  it("jumps out of a break it starts in", () => {
    expect(advance(500, 5, gaps)).toBe(1005);
  });
  it("is a function of wall time only (no per-frame accumulation)", () => {
    let t = 0;
    for (let i = 0; i < 100; i++) t = advance(t, 3, gaps);
    expect(t).toBe(advance(0, 300, gaps));
  });
});
