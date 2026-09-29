// A selected figure's bubble has two buttons at most (workstation/bubbleActions.ts): 打开会话 (when it has a session) and 跟随.
// The route is not a button: it belongs to a played turn (▶ 回放这一轮).
import { describe, expect, it } from "vitest";
import { bubbleActions } from "./bubbleActions.ts";

describe("bubbleActions", () => {
  it("a session's agent: 打开会话 and 跟随", () => {
    expect(bubbleActions(true)).toEqual(["打开会话", "跟随"]);
  });
  it("a sub-agent has no session of its own: 跟随 only", () => {
    expect(bubbleActions(false)).toEqual(["跟随"]);
  });
  it("never a way to enter or leave a trace", () => {
    for (const s of [true, false]) expect(bubbleActions(s).join()).not.toMatch(/追踪/);
  });
});
