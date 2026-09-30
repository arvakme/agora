// 「可能过时」 is a small dot by the sub-diagram's name in the breadcrumb (the words and 「让 AI 更新」 open on hover). It does not
// follow the camera's silence (replayQuiet.ts quiets the layout saves and the hint below, not the dot): whoever went there, files changed → dot. The
// one-time 「在子图里」 hint is once per browser: it counts as seen once it has been on screen for a while, not only when dismissed.
import { describe, expect, it } from "vitest";
import { BACK_HINT_MS, backHintDue, staleDot, staleNote } from "./up.ts";

describe("staleDot: the dot by the name", () => {
  it("files changed since the sub-diagram was drawn: a dot, whoever went there (you or the camera; the camera's silence does not hide it)", () => {
    expect(staleDot(2)).toBe(true);
  });
  it("nothing changed: no dot", () => expect(staleDot(0)).toBe(false));
  it("the words on hover say how many files", () => expect(staleNote(["a.go", "b.go"])).toBe("可能过时：子图画好之后改过 2 个文件"));
});

describe("backHintDue: 「在子图里」 once per browser", () => {
  it("counts as seen after it has been shown for BACK_HINT_MS", () => {
    expect(BACK_HINT_MS).toBeGreaterThan(0);
    expect(backHintDue(BACK_HINT_MS)).toBe(true);
    expect(backHintDue(BACK_HINT_MS - 1)).toBe(false);
  });
});
