// The list an @ opens is drawn on the body, but React still bubbles a press on it through the canvas: a click on a row
// must not count as a press outside the comment card (that closed the card and lost the text).
import { describe, expect, it } from "vitest";
import { MENTION_LIST_CLASS } from "../comments/mention.ts";
import { KEEPS_CARD_OPEN } from "./pressOutside.ts";

describe("what a press does not close the comment card for", () => {
  it("the @ list of the comment box is one of them", () => {
    expect(KEEPS_CARD_OPEN.split(/,\s*/)).toContain(`.${MENTION_LIST_CLASS}`);
  });
  it("and the card itself and its pins still are", () => {
    expect(KEEPS_CARD_OPEN.split(/,\s*/)).toEqual(expect.arrayContaining([".tcard", ".pin"]));
  });
});
