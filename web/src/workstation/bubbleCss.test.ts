// FX6: inside a bubble the words share what is left of its width by rank — the title first, the state word (「思考」) and the buttons never — so nothing
// draws over anything else. The real layout is checked in the page (round-06/evidence/FX6/probe.mjs: every child's box against every other's); this guards the rules.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./workstation.css", import.meta.url), "utf8");
const rule = (sel: string) => css.split("\n").filter((l) => l.startsWith(sel + " {") || l.startsWith(sel + ",") || l.includes(", " + sel + " {") || l.includes(", " + sel + ","));
const has = (sel: string, decl: RegExp) => rule(sel).some((l) => decl.test(l));

describe("bubble css: who gives way, and who never does", () => {
  it("the title (.who) and the warning shrink with an ellipsis, first of all", () => {
    for (const sel of [".ws-bub-in > .who", ".ws-bub-in > .warn"]) {
      expect(has(sel, /min-width: 0/), sel + " min-width").toBe(true);
      expect(has(sel, /text-overflow: ellipsis/), sel + " ellipsis").toBe(true);
    }
    const shrink = (sel: string) => Number(/flex-shrink: (\d+)/.exec(rule(sel).find((l) => /flex-shrink: \d+/.test(l)) ?? "")?.[1] ?? 0);
    expect(shrink(".ws-bub-in > .who")).toBeGreaterThan(shrink(".ws-bub-in > .f"));
  });
  it("the state word, the icon and the avatar never shrink", () => {
    expect(has(".ws-bub-in > .v", /flex-shrink: 0/)).toBe(true);
    expect(has(".ws-bub-in > .agent-avatar", /flex-shrink: 0/)).toBe(true);
    expect(has(".ws-bub-in > svg", /flex-shrink: 0/)).toBe(true);
  });
  it("the buttons never shrink, and stay off the words (a gap)", () => {
    expect(has(".ws-acts", /flex-shrink: 0/)).toBe(true);
    expect(has(".ws-acts", /margin-left: (?:[4-9]|\d\d)px/)).toBe(true);
  });
  it("the inner words box may be narrower than its content: it shrinks (min-width 0)", () => {
    expect(has(".ws-bub-in", /min-width: 0/)).toBe(true);
  });
});
