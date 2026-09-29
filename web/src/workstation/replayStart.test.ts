// Where a play starts and where a row of the trajectory sends it: from the turn's start, or from a chosen step (paused there when the
// person only wanted the figure to stand at that step).
import { describe, expect, it } from "vitest";
import { jumpTo, startAt } from "./replayStart.ts";

const win = { start: 1_000_000, end: 1_060_000 };
describe("startAt", () => {
  it("from the turn's start (a moment before it), playing, up to the end plus the summary", () => {
    expect(startAt(win, 9_999_999)).toEqual({ at: 999_600, until: 1_063_000, paused: false });
  });
  it("from a chosen step; paused when asked", () => {
    expect(startAt(win, 9_999_999, { from: 1_030_000 })).toEqual({ at: 1_030_000, until: 1_063_000, paused: false });
    expect(startAt(win, 9_999_999, { from: 1_030_000, paused: true })).toMatchObject({ at: 1_030_000, paused: true });
  });
  it("a step outside the turn is clamped into it", () => {
    expect(startAt(win, 9_999_999, { from: 5 }).at).toBe(999_600);
    expect(startAt(win, 9_999_999, { from: 9_000_000 }).at).toBe(1_063_000);
  });
  it("a running turn ends now", () => {
    expect(startAt({ start: 1_000_000, end: null }, 1_020_000).until).toBe(1_020_000);
  });
});

describe("jumpTo: a step clicked while a play is on", () => {
  const r = { at: 1_010_000, playing: false, speed: 2, since: 0, until: 1_063_000 };
  it("paused stays paused at that step; playing goes on from it, at the same speed", () => {
    expect(jumpTo(r, 1_040_000)).toEqual({ playing: false, at: 1_040_000, until: 1_063_000, speed: 2 });
    expect(jumpTo({ ...r, playing: true }, 1_040_000)).toEqual({ playing: true, at: 1_040_000, until: 1_063_000, speed: 2 });
  });
});
