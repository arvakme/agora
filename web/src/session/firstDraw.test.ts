// The first screen of a new project (session/firstDraw.ts): the button that asks an agent to draw the project's
// architecture, the words on the empty canvas, and the quiet way to look at the sample.
import { describe, expect, it, vi } from "vitest";
import { ARCHITECTURE_PROMPT, EMPTY_HINT, drawPlan, isEmptyCanvas, sampleRequests } from "./firstDraw.ts";

describe("drawPlan (the main button)", () => {
  it("starts the recommended agent and sends the written prompt", () => {
    expect(drawPlan("codex")).toEqual({ kind: "codex", prompt: ARCHITECTURE_PROMPT });
    expect(drawPlan("claude").kind).toBe("claude");
  });
  it("the prompt asks for what the person asked for: look, draw the architecture on this canvas, a child canvas per subsystem (upstream on top), then two or three sentences", () => {
    for (const w of ["看一下这个项目", "整体架构", "这张图", "子图", "上游在上", "下游在下", "两三句话"]) expect(ARCHITECTURE_PROMPT).toContain(w);
  });
  it("the prompt is one piece of text in one place, not a template with holes", () => {
    expect(ARCHITECTURE_PROMPT).not.toMatch(/\{\w+\}/);
  });
});

describe("the empty canvas", () => {
  it("says the canvas is empty and points at the one button, not at a second way", () => {
    expect(EMPTY_HINT).toContain("这张图还是空的");
    expect(EMPTY_HINT).toContain("画出这个项目的架构");
    expect(EMPTY_HINT).toContain("自己动手画");
  });
});

describe("看一个示例", () => {
  it("asks whoever opens canvases to open the sample as another canvas", () => {
    const open = vi.fn();
    const off = sampleRequests.subscribe(open);
    sampleRequests.request();
    expect(open).toHaveBeenCalledTimes(1);
    off();
    sampleRequests.request();
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("isEmptyCanvas", () => {
  it("an unknown canvas, no elements, or only deleted ones is empty; one live element is not", () => {
    expect(isEmptyCanvas(undefined)).toBe(true);
    expect(isEmptyCanvas([])).toBe(true);
    expect(isEmptyCanvas([{ isDeleted: true }, { isDeleted: true }])).toBe(true);
    expect(isEmptyCanvas([{ isDeleted: true }, {}])).toBe(false);
  });
});
