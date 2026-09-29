// The session panel's view changes only by its own events.
import { describe, expect, it } from "vitest";
import { panelView } from "./clock.ts";

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
