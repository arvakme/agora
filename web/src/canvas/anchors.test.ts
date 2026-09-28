// Where a comment pin sits: outside the box it is anchored to, so it never hides the label.
import { describe, expect, it, vi } from "vitest";

// scene.ts pulls in Excalidraw's runtime for element builders this test does not use.
vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: () => [], FONT_FAMILY: {}, ROUNDNESS: {} }));
import { hitTest, resolveAnchor } from "./anchors.ts";
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

// An inserted library component: a transparent root carrying the component's name and caption,
// with the icon's own shapes grouped under it (libraryInsert.ts).
describe("anchors on a library component", () => {
  const G = "lib-api-x1";
  const root = el("api", "rectangle", 100, 100, 80, 80, { groupIds: [G], customData: { agora: { library: "server", name: "Server", group: G, label: "api-label" } } });
  const part = el("api-h1f9llad", "rectangle", 110, 110, 60, 60, { groupIds: ["g-inner", G] });
  const caption = el("api-label", "text", 100, 186, 80, 18, { groupIds: [G], text: "API 服务" });

  it("names an anchor on a part of the component by the component's label, not the part's id", () => {
    const st = resolveAnchor({ ids: ["api-h1f9llad"], rel: { x: 0.5, y: 0.5 }, last: { x: 0, y: 0 } }, mapOf(root, part, caption));
    expect(st.names).toEqual([{ id: "api-h1f9llad", name: "API 服务", alive: true }]);
  });

  it("aims at the component, not the shape inside it", () => {
    expect(hitTest([root, part, caption], 140, 140, 1)?.id).toBe("api");
  });

  it("leaves shapes in an ordinary group alone", () => {
    const a = el("a", "rectangle", 0, 0, 50, 50, { groupIds: ["g-user"] });
    expect(hitTest([a], 10, 10, 1)?.id).toBe("a");
  });
});
