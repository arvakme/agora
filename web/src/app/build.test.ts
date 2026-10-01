import { describe, expect, it } from "vitest";
import { buildLabel } from "./build";

describe("buildLabel: which code this page's server runs", () => {
  it("is the first seven characters of the commit", () => {
    expect(buildLabel({ sha: "b1fbb5b0123456789012345678901234567890ab", dirty: false })).toEqual({ text: "b1fbb5b", title: "b1fbb5b0123456789012345678901234567890ab" });
  });

  it("marks a checkout with uncommitted changes", () => {
    expect(buildLabel({ sha: "b1fbb5b0123456789012345678901234567890ab", dirty: true })).toEqual({
      text: "b1fbb5b+",
      title: "b1fbb5b0123456789012345678901234567890ab（有未提交的改动）",
    });
  });

  it("says nothing when the server could not tell (an old server, or no git)", () => {
    expect(buildLabel(undefined)).toBeNull();
    expect(buildLabel({ sha: null, dirty: false })).toBeNull();
  });
});
