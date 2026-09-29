// The short name on the 「跟随 …」 button (workstation/stripRules.ts).
import { describe, expect, it } from "vitest";
import { shortAgentName } from "./stripRules.ts";

describe("shortAgentName", () => {
  it("the agent, not its task (the full name is the tooltip)", () => expect(shortAgentName("Claude Code · 看看沙箱云电脑在手…")).toBe("Claude Code"));
  it("a plain name stays", () => expect(shortAgentName("Pi")).toBe("Pi"));
});
