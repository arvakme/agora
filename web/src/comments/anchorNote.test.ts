// The card sits beside the element it is about, so it does not say what it is pinned to. It only says something when
// the element is gone (or is not on this canvas), and then offers to pin the comment somewhere else.
import { describe, expect, it } from "vitest";
import { anchorNote } from "./anchorNote.ts";

const st = (status: "ok" | "partial" | "lost", names: { id: string; name: string; alive: boolean }[]) => ({ point: { x: 0, y: 0 }, status, names });

describe("anchorNote", () => {
  it("says nothing while the pinned element is there", () => {
    expect(anchorNote(st("ok", [{ id: "a", name: "upload-session", alive: true }]))).toBeNull();
  });

  it("says the element is gone, by its name, when none is left", () => {
    expect(anchorNote(st("lost", [{ id: "a", name: "upload-session", alive: false }]))).toBe("钉住的元素已删除，或不在这张画布上：upload-session");
  });

  it("names only the ones that are gone when others remain", () => {
    const n = anchorNote(st("partial", [{ id: "a", name: "API 服务", alive: true }, { id: "b", name: "MySQL", alive: false }]));
    expect(n).toBe("有的元素已删除，或不在这张画布上：MySQL；其余还在");
  });
});
