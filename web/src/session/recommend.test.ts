// Which agent is recommended for a new conversation (session/recommend.ts): the @ list and the new-session chooser share it.
import { describe, expect, it } from "vitest";
import type { Binding } from "./agents.ts";
import { kindShown, recommendAgent } from "./recommend.ts";

const b = (agent: string, createdAt = 1): Binding => ({ agent, model: "m", effort: "", nativeId: "n", createdAt });
const kinds = ["pi", "claude", "codex", "grok", "cursor", "devin"];

describe("recommendAgent: three levels of fallback", () => {
  it("1. the agent of the session that worked most recently on this canvas", () => {
    const bindings = { a: b("pi"), c: b("codex"), z: b("claude") };
    const r = recommendAgent({ kinds, bindings, activeAt: { a: 5, c: 9, z: 100 }, canvas: ["a", "c"] });
    expect(r).toBe("codex"); // z is busier but not on this canvas
  });
  it("uses the creation time of a session that has not done anything yet", () => {
    const bindings = { a: b("pi", 50), c: b("codex", 10) };
    expect(recommendAgent({ kinds, bindings, activeAt: {}, canvas: ["a", "c"] })).toBe("pi");
  });
  it("a session whose transcript is still empty reports activeAt 0: it counts from its creation, not from 1970", () => {
    const bindings = { a: b("pi", 50), c: b("codex", 10) };
    expect(recommendAgent({ kinds, bindings, activeAt: { a: 0, c: 0 }, canvas: ["c", "a"] })).toBe("pi");
  });
  it("2. with no session on this canvas: the agent most used in the project", () => {
    const bindings = { a: b("codex"), b: b("codex"), c: b("pi"), d: b("grok") };
    expect(recommendAgent({ kinds, bindings, activeAt: {}, canvas: [] })).toBe("codex");
    expect(recommendAgent({ kinds, bindings, activeAt: {} })).toBe("codex"); // the canvas is not known
  });
  it("breaks a tie in usage by the more recent one", () => {
    const bindings = { a: b("pi"), c: b("grok") };
    expect(recommendAgent({ kinds, bindings, activeAt: { a: 1, c: 2 }, canvas: [] })).toBe("grok");
  });
  it("3. with no session at all: Claude Code", () => {
    expect(recommendAgent({ kinds, bindings: {}, activeAt: {}, canvas: [] })).toBe("claude");
  });
  it("never recommends an agent that cannot start a session (not among the session kinds)", () => {
    const bindings = { a: b("gone-agent") };
    expect(recommendAgent({ kinds, bindings, activeAt: {}, canvas: ["a"] })).toBe("claude");
    expect(recommendAgent({ kinds: ["pi", "codex"], bindings: {}, activeAt: {} })).toBe("pi"); // no Claude Code here either
  });
});

describe("the chooser's selected agent", () => {
  it("is the recommended one until the person picks another", () => {
    expect(kindShown(null, "codex")).toBe("codex");
    expect(kindShown("pi", "codex")).toBe("pi");
  });
});
