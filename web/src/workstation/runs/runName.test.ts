// A session's name on the workstation (runs/store.ts `runName`): the agent's name, also for a CLI the page has
// not loaded the adapter list for yet (a fresh Grok session had no name and crashed the top bar's tags).
import { describe, expect, it } from "vitest";
import { runName } from "./store.ts";

describe("runName", () => {
  it("a known agent", () => expect(runName("s1", { s1: { agent: "claude" } }, {})).toBe("Claude Code"));
  it("an agent the page has no name for yet: its kind with a capital, never undefined", () => {
    expect(runName("s1", { s1: { agent: "grok" } }, {})).toBeTruthy();
    expect(runName("s1", { s1: { agent: "cursor" } }, {})).toBe("Cursor");
  });
  it("two sessions of one agent: the tab name tells them apart", () => expect(runName("s1", { s1: { agent: "pi" }, s2: { agent: "pi" } }, { s1: "画图" })).toBe("画图"));
});
