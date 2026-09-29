// Which mark each agent kind is drawn with (session/agentMarks.ts).
import { describe, expect, it } from "vitest";
import { hasOwnMark, markFor } from "./agentMarks.ts";

describe("markFor", () => {
  it("the six known CLIs each have their own mark", () => {
    for (const k of ["pi", "claude", "codex", "grok", "cursor", "devin"]) expect(markFor(k)).toBe(k);
  });
  it("any other kind falls back to its initial", () => {
    expect(markFor("droid")).toBe("initial");
    expect(markFor("")).toBe("initial");
    expect(markFor("worker")).toBe("initial");
  });
  it("hasOwnMark says the same", () => {
    expect(hasOwnMark("grok")).toBe(true);
    expect(hasOwnMark("droid")).toBe(false);
  });
});
