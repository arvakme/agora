// Going into a replay is explicit (web/docs/workstation.md §3): dragging the playhead, ▶ on the strip, 「回放到这里」 on a
// segment's card — never a plain click. Replaying does not move the session panel or open the follow tab by itself.
import { describe, expect, it } from "vitest";
import { autoFollowTabAllowed, entersReplay, panelView } from "./clock.ts";

describe("entersReplay: which gestures go into a replay", () => {
  it("a click on a segment only selects it", () => expect(entersReplay("click")).toBe(false));
  it("a click on the bare track does not either", () => expect(entersReplay("click-track")).toBe(false));
  it("dragging the playhead does", () => expect(entersReplay("drag")).toBe(true));
  it("▶ on the strip does", () => expect(entersReplay("play")).toBe(true));
  it("「回放到这里」 on the card does", () => expect(entersReplay("replay-here")).toBe(true));
  it("locating a segment's node does not", () => expect(entersReplay("locate")).toBe(false));
});

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
  it("no replay gesture is an event of it: entering a replay (drag / ▶ / 回放到这里) leaves the view as the person had it", () => {
    for (const g of ["drag", "play", "replay-here"] as const) {
      expect(entersReplay(g)).toBe(true);
      for (const v of ["chat", "trajectory"] as const) expect(panelView(v, g)).toBe(v);
    }
  });
});
