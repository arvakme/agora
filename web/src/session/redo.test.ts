// 重做 puts back exactly what 撤销 took off, and refuses when the person changed those elements in between,
// the same way undoBatch refuses when they changed them after the agent did.
import { describe, expect, it, vi } from "vitest";

// the canvas modules pull in Excalidraw's runtime for builders this test does not use
vi.mock("@excalidraw/excalidraw", () => ({ convertToExcalidrawElements: () => [], FONT_FAMILY: {}, ROUNDNESS: {}, exportToSvg: () => null, exportToBlob: () => null }));
import { undoBatch, type Batch } from "../ops/apply";
import type { El, Scene } from "../canvas/scene";
import { redoBatch, redoOf, versionsAfterRedo } from "./redo";

const el = (id: string, over: Partial<El> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, ...over }) as unknown as El;

// The agent moved "a" (v1 → v2) and created "b" (v1).
const before = new Map<string, El | null>([["a", el("a", { x: 0 })], ["b", null]]);
const batch: Batch = { before, after: new Map([["a", 2], ["b", 1]]) };
const afterAgent: Scene = [el("a", { x: 100, version: 2 }), el("b", { version: 1 }), el("c")] as Scene;

function undone() {
  const r = undoBatch(afterAgent, batch);
  expect(r.scene).toBeDefined();
  return r.scene as El[];
}

describe("redo", () => {
  it("brings back the moved element and the created one", () => {
    const now = undone();
    expect(now.find((e) => e.id === "a")!.x).toBe(0);
    expect(now.find((e) => e.id === "b")!.isDeleted).toBe(true);
    const r = redoBatch(now as Scene, redoOf(afterAgent, now, batch));
    expect(r.stale).toEqual([]);
    const scene = r.scene!;
    expect(scene.find((e) => e.id === "a")!.x).toBe(100);
    expect(scene.find((e) => e.id === "b")!.isDeleted).toBe(false);
  });

  it("leaves what the batch did not touch alone", () => {
    const now = undone();
    const c = now.find((e) => e.id === "c");
    const scene = redoBatch(now as Scene, redoOf(afterAgent, now, batch)).scene!;
    expect(scene.find((e) => e.id === "c")).toBe(c);
  });

  it("writes newer versions, so a saved copy of the canvas takes them", () => {
    const now = undone();
    const scene = redoBatch(now as Scene, redoOf(afterAgent, now, batch)).scene!;
    for (const id of ["a", "b"]) expect(scene.find((e) => e.id === id)!.version).toBeGreaterThan(now.find((e) => e.id === id)!.version);
  });

  it("refuses, naming the element, when it was changed after the undo", () => {
    const now = undone().map((e) => (e.id === "a" ? { ...e, x: 7, version: e.version + 1 } : e)) as Scene;
    const r = redoBatch(now, redoOf(afterAgent, undone(), batch));
    expect(r.scene).toBeUndefined();
    expect(r.stale).toEqual(["a"]);
  });

  it("refuses when an element is gone from the scene", () => {
    const now = undone().filter((e) => e.id !== "b") as Scene;
    expect(redoBatch(now, redoOf(afterAgent, undone(), batch)).stale).toEqual(["b"]);
  });

  it("can be undone again: the batch is told the versions redo wrote", () => {
    const now = undone();
    const redo = redoOf(afterAgent, now, batch);
    const redone = redoBatch(now as Scene, redo).scene!;
    expect(undoBatch(redone as Scene, batch).scene, "the old batch no longer matches").toBeUndefined();
    const again = undoBatch(redone as Scene, { before, after: versionsAfterRedo(redone as Scene, redo) });
    expect(again.stale).toEqual([]);
    expect(again.scene!.find((e) => e.id === "a")!.x).toBe(0);
    expect(again.scene!.find((e) => e.id === "b")!.isDeleted).toBe(true);
  });
});
