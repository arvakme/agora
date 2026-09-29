// Going into a replay is explicit (web/docs/workstation.md §3): dragging the playhead, ▶ on the strip, 「回放到这里」 on a
// segment's card — never a plain click. Replaying does not move the session panel or open the follow tab by itself.
import { describe, expect, it } from "vitest";
import { autoFollowTabAllowed, entersReplay, panelViewDuring } from "./clock.ts";

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

describe("panelViewDuring: the session panel keeps the person's view", () => {
  it("chat stays chat while replaying", () => expect(panelViewDuring("chat", true)).toBe("chat"));
  it("trajectory stays trajectory, live or replaying", () => {
    expect(panelViewDuring("trajectory", true)).toBe("trajectory");
    expect(panelViewDuring("trajectory", false)).toBe("trajectory");
  });
});
