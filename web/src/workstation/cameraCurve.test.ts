// Finding the frames where the camera's view is not continuous (workstation/cameraCurve.ts): a canvas switch is its own thing (a
// cut under a cross-fade); on one canvas a frame whose velocity differs from the last by more than a few px is a snap, a zoom that
// changes by a step in a frame is a jump, and a view crossing the screen faster than a limit is too fast.
import { describe, expect, it } from "vitest";
import { viewProblems, type ViewSample } from "./cameraCurve.ts";

const F = 1000 / 60;
const frames = (n: number, f: (i: number) => Partial<ViewSample>): ViewSample[] => Array.from({ length: n }, (_, i) => ({ t: i * F, canvas: "c1", zoom: 1, sx: 0, sy: 0, ...f(i) }));

describe("viewProblems", () => {
  it("a view at rest, or gliding at a steady speed, has nothing to report", () => {
    expect(viewProblems(frames(60, () => ({}))).snaps).toEqual([]);
    expect(viewProblems(frames(60, (i) => ({ sx: -i * 2 }))).snaps).toEqual([]);
  });
  it("a smooth ease-out (each frame a little slower than the last) is not a snap", () => {
    const r = viewProblems(frames(60, (i) => ({ sx: -300 * (1 - Math.exp(-i / 12)) })), { snapPx: 8 });
    expect(r.snaps.filter((s) => s.t > 100)).toEqual([]);
  });
  it("a view that jumps in one frame is a snap, with its size", () => {
    const r = viewProblems(frames(30, (i) => ({ sx: i < 15 ? 0 : -200 })));
    expect(r.snaps[0]).toMatchObject({ t: 15 * F });
    expect(r.snaps[0].px).toBeGreaterThan(150);
  });
  it("a canvas switch is listed as a switch, not as a snap", () => {
    const r = viewProblems(frames(30, (i) => ({ canvas: i < 15 ? "c1" : "c-api", sx: i < 15 ? 0 : -900 })));
    expect(r.switches).toEqual([{ t: 15 * F, from: "c1", to: "c-api" }]);
    expect(r.snaps).toEqual([]);
  });
  it("zoom changing by a step in a frame is a jump; a slow zoom is not", () => {
    expect(viewProblems(frames(30, (i) => ({ zoom: i < 15 ? 1 : 0.6 }))).zoomJumps).toHaveLength(1);
    expect(viewProblems(frames(60, (i) => ({ zoom: 1 - i * 0.003 }))).zoomJumps).toEqual([]);
  });
  it("too fast: the view crossing more than the limit per second", () => {
    const r = viewProblems(frames(30, (i) => ({ sx: -i * 100 })), { fastPxPerSecond: 3000 });
    expect(r.fast.length).toBeGreaterThan(0);
    expect(viewProblems(frames(30, (i) => ({ sx: -i * 10 })), { fastPxPerSecond: 3000 }).fast).toEqual([]);
  });
});
