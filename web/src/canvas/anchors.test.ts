// Where a comment pin sits: outside the box it is anchored to, so it never hides the label.
import { describe, expect, it, vi } from "vitest";

// scene.ts pulls in Excalidraw's runtime for element builders this test does not use.
vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: () => [], FONT_FAMILY: {}, ROUNDNESS: {} }));
import { resolveAnchor } from "./anchors.ts";
import type { El } from "./scene.ts";

const el = (id: string, type: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) =>
  ({ id, type, x, y, width, height, isDeleted: false, ...extra }) as unknown as El;
const mapOf = (...els: El[]) => new Map(els.map((e) => [e.id, e]));

describe("resolveAnchor", () => {
  it("puts the pin tip on a box's top-right corner, whatever point was clicked", () => {
    const redis = el("redis", "rectangle", 440, 400, 104, 40);
    const st = resolveAnchor({ ids: ["redis"], rel: { x: 0.5, y: 0.5 }, last: { x: 492, y: 420 } }, mapOf(redis));
    expect(st.point).toEqual({ x: 544, y: 400 });
    expect(st.status).toBe("ok");
  });

  it("keeps the anchored point along an arrow", () => {
    const arrow = el("a", "arrow", 100, 100, 100, 0, { points: [[0, 0], [100, 0]] });
    const st = resolveAnchor({ ids: ["a"], rel: { x: 0.5, y: 0.5 }, last: { x: 150, y: 100 } }, mapOf(arrow));
    expect(st.point).toEqual({ x: 150, y: 100 });
  });

  it("falls back to the last seen corner once the box is deleted", () => {
    const anchor = { ids: ["pg"], rel: { x: 0.2, y: 0.2 }, last: { x: 0, y: 0 } };
    const pg = el("pg", "rectangle", 200, 400, 104, 40);
    resolveAnchor(anchor, mapOf(pg));
    const st = resolveAnchor(anchor, mapOf({ ...pg, isDeleted: true } as El));
    expect(st.point).toEqual({ x: 304, y: 400 });
    expect(st.status).toBe("lost");
  });
});
