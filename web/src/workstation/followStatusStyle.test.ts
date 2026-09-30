// The 「跟着 X」 line sits over the drawing (connectors, labels run under it): it has its own paper and a frame, in tokens
// that switch with the theme, so it reads on a busy canvas in light and dark (ACC1 #11).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rule = (css: string, sel: string) => new RegExp(`(?:^|\\n)${sel.replace(/[.:()]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe(".ws-follow-status", () => {
  const css = readFileSync(new URL("./replay.css", import.meta.url), "utf8");
  it("has a solid token background and a frame, and no hard-coded colours", () => {
    const r = rule(css, ".ws-follow-status");
    expect(r).toMatch(/background: var\(--surface\)/);
    expect(r).toMatch(/box-shadow: var\(--frame\)/);
    expect(r).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
