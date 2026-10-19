// A selected figure's bubble has one button at most (workstation/bubbleActions.ts): 打开会话 (when it has a session). Clicking the bubble itself is what follows,
// so there is no 「跟随」 button. The route is not a button either: it belongs to a played turn (▶ 回放这一轮).
import { describe, expect, it } from "vitest";
import { bubbleActions } from "./bubbleActions.ts";

describe("bubbleActions", () => {
  it("a session's agent: 打开会话", () => {
    expect(bubbleActions(true)).toEqual(["打开会话"]);
  });
  it("a sub-agent has no session of its own: no button (the bubble itself follows)", () => {
    expect(bubbleActions(false)).toEqual([]);
  });
  it("never a 「跟随」 button: clicking the bubble does that", () => {
    for (const s of [true, false]) expect(bubbleActions(s).join()).not.toMatch(/跟随/);
  });
  it("never a way to enter or leave a trace", () => {
    for (const s of [true, false]) expect(bubbleActions(s).join()).not.toMatch(/追踪/);
  });
});
