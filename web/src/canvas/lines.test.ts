// How a line runs, as an agent reads it: the drawn path (only when it is not the plain straight arrow the page
// draws between two nodes) and junction dots. Same cases as tests/test_model_view_paths.py — the server's twin
// of toModelView (server/canvas/model_view.py).
import { describe, expect, it } from "vitest";
import { drawnPath, isJunction } from "./lines.ts";

const box = (id: string, x: number, y: number, w = 160, h = 64) => ({ id, type: "rectangle", x, y, width: w, height: h });
const arrow = (from: string, to: string, x: number, y: number, points: [number, number][]) => ({ x, y, points, startBinding: { elementId: from }, endBinding: { elementId: to } });
const shapes = new Map([box("a", 0, 0), box("b", 0, 300)].map((s) => [s.id, s]));

describe("drawnPath", () => {
  it("a plain straight arrow has no path", () => {
    expect(drawnPath(arrow("a", "b", 80, 70, [[0, 0], [0, 224]]), shapes)).toBeUndefined();
  });
  it("an arrow that bends shows its absolute points", () => {
    expect(drawnPath(arrow("a", "b", 40, 70, [[0, 0], [0, 100], [80, 100], [80, 224]]), shapes)).toEqual([[40, 70], [40, 170], [120, 170], [120, 294]]);
  });
  it("a straight arrow attached off centre shows its path too", () => {
    expect(drawnPath(arrow("a", "b", 30, 70, [[0, 0], [10, 224]]), shapes)).toEqual([[30, 70], [40, 294]]);
  });
});

describe("isJunction", () => {
  it("is the small dot marked in customData, nothing else", () => {
    expect(isJunction({ customData: { junction: true } })).toBe(true);
    expect(isJunction({ customData: { codePaths: ["x"] } })).toBe(false);
    expect(isJunction({})).toBe(false);
  });
});
