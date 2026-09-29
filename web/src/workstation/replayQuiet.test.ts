// 「可能过时」 follows the camera's silence (workstation/replayQuiet.ts).
import { describe, expect, it } from "vitest";
import { quiet, staleVisible } from "./replayQuiet.ts";

describe("staleVisible: when 「可能过时」 shows", () => {
  it("files changed since the sub-diagram was drawn, and you went there yourself: shows", () => {
    expect(staleVisible(3, false)).toBe(true);
  });
  it("the camera took the canvas there (live follow or ▶): quiet", () => {
    expect(staleVisible(3, true)).toBe(false);
  });
  it("nothing changed: nothing to show", () => {
    expect(staleVisible(0, false)).toBe(false);
  });
});

describe("quiet holds", () => {
  it("quiet while any camera holds it", () => {
    quiet.hold("live", true);
    quiet.hold("play", true);
    quiet.hold("live", false);
    expect(typeof quiet.hold).toBe("function");
    quiet.hold("play", false);
  });
});
