// FX9: the talk box's line of words (「对 Claude Code · 画出这个项目的架构…」) ends in … instead of a half character, and says it all on hover. This guards the CSS; the page check is round-06/evidence/FX9/.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./TalkBubble.css", import.meta.url), "utf8");
const tsx = readFileSync(new URL("./TalkBubble.tsx", import.meta.url), "utf8");
const line = (sel: string) => css.split("\n").filter((l) => l.startsWith(sel + " {") || l.startsWith(sel + ","));

describe("talk box words", () => {
  it("the input, and its placeholder, end in an ellipsis and fill the box without outgrowing it", () => {
    expect(line(".ws-talk input").some((l) => /text-overflow: ellipsis/.test(l) && /min-width: 0/.test(l) && /box-sizing: border-box/.test(l))).toBe(true);
    expect(line(".ws-talk input::placeholder").some((l) => /text-overflow: ellipsis/.test(l))).toBe(true);
  });
  it("the box has a width of its own that the frame job may narrow (a pane narrower than it)", () => {
    expect(line(".ws-talk").some((l) => /max-width: 100%/.test(l))).toBe(true);
  });
  it("the whole words are the input's title (hover)", () => {
    expect(/<input[^>]*title=\{/.test(tsx.replace(/\n/g, " "))).toBe(true);
  });
});
