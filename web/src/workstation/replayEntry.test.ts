// Replaying does not open the follow tab by itself (web/docs/workstation.md §3, §10); the session panel's view changes only by its own events.
import { describe, expect, it } from "vitest";
import { autoFollowTabAllowed, panelView } from "./clock.ts";

describe("autoFollowTabAllowed: the follow tab does not open by itself during a replay", () => {
  it("live, with the switch on: by the usual rules", () => expect(autoFollowTabAllowed(false, true)).toBe(true));
  it("replaying: not (a tab you opened yourself stays)", () => expect(autoFollowTabAllowed(true, true)).toBe(false));
  it("the switch is off (the default): never by itself — only 「跟随」 opens it", () => {
    expect(autoFollowTabAllowed(false, false)).toBe(false);
    expect(autoFollowTabAllowed(true, false)).toBe(false);
  });
});

describe("panelView: the session panel's view changes only by its own events, never by entering a replay", () => {
  it("the toggle flips chat and trajectory", () => {
    expect(panelView("chat", "toggle")).toBe("trajectory");
    expect(panelView("trajectory", "toggle")).toBe("chat");
  });
  it("a turn link goes to chat; a trajectory link or a stop clicked on the canvas goes to trajectory", () => {
    expect(panelView("trajectory", "turn")).toBe("chat");
    expect(panelView("chat", "trajectory")).toBe("trajectory");
    expect(panelView("chat", "step")).toBe("trajectory");
  });
});
