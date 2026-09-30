// The share window's note for a share that lets guests watch the build (SharePanel.tsx).
import { describe, expect, it } from "vitest";
import { replayText } from "./replayText";

describe("replayText", () => {
  it("says so only for a share that allows it", () => {
    expect(replayText({ buildReplay: true })).toBe("访客可看搭建过程");
    expect(replayText({ buildReplay: false })).toBe("");
    expect(replayText({})).toBe(""); // a share made before the option
  });
});
