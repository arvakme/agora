// The selection sent with a chat message: which elements it is (by name and id, a label counted with its box),
// and the words on the chip. The picture itself is Excalidraw's export (browser, checked in the evidence).
import { describe, expect, it, vi } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: () => [], FONT_FAMILY: {}, ROUNDNESS: {}, exportToSvg: () => null, exportToBlob: () => null }));
import type { El } from "../canvas/scene.ts";
import { selectionElements, selectionLabel } from "./selection.ts";

const el = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, width: 10, height: 10, isDeleted: false, ...extra }) as unknown as El;

describe("selectionElements", () => {
  const scene = [
    el("o-api", "rectangle", { boundElements: [{ id: "t-api", type: "text" }] }),
    el("t-api", "text", { text: "API 服务", containerId: "o-api" }),
    el("o-db", "rectangle", { boundElements: [{ id: "t-db", type: "text" }] }),
    el("t-db", "text", { text: "MySQL", containerId: "o-db" }),
    el("gone", "rectangle", { isDeleted: true }),
  ];

  it("names each selected element and counts a box and its label once", () => {
    expect(selectionElements(scene, ["o-api", "t-api", "o-db"])).toEqual([
      { id: "o-api", name: "API 服务" },
      { id: "o-db", name: "MySQL" },
    ]);
  });

  it("leaves out what is no longer on the canvas, and names an unlabelled element by its id", () => {
    expect(selectionElements([...scene, el("plain", "rectangle")], ["gone", "plain"])).toEqual([{ id: "plain", name: "plain" }]);
  });
});

describe("selectionLabel", () => {
  it("is the chip's words, in the composer and under the message", () => {
    expect(selectionLabel(21)).toBe("选区 · 21 个元素");
  });
});
