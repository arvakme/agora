// Replay time comes from the wall clock, never from counting frames: a tab that got no frames for
// a while (background, frozen) shows the right moment as soon as it draws again.
import { describe, expect, it } from "vitest";
import { replayTime, type Replay } from "./clock.ts";

describe("replayTime", () => {
  const r: Replay = { at: 1000, playing: true, speed: 4, since: 50_000, until: 100_000 };
  it("advances with wall time × speed, whatever happened in between", () => {
    expect(replayTime(r, 50_000)).toBe(1000);
    expect(replayTime(r, 55_000)).toBe(21_000); // 5 s hidden at 4× = 20 s of the recording
  });
  it("stops at the end of the recording; a paused replay stays put", () => {
    expect(replayTime(r, 90_000)).toBe(100_000);
    expect(replayTime({ ...r, playing: false }, 90_000)).toBe(1000);
  });
});
