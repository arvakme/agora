// A move that is a cut (./place.ts `isCut`: over CUT_DISTANCE from the tray, or a call marked `cut`: the build replay's hop) is not a walk, so the trace has no long
// route for it and the stop is reached when the cut is over (CUT_MS), not when a walk over the whole way would have ended.
import { describe, expect, it } from "vitest";
import type { Box } from "../canvas/clearance";
import { CUT_MS, isCut, OUTSIDE, stateAt, type Ctx } from "./place.ts";
import { route, walkMap } from "./route.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";
import { traceAt } from "./trace.ts";

const S = 1000;
const BOX: Record<string, Box> = { a: { x: 0, y: 0, w: 170, h: 72 }, b: { x: 3000, y: 0, w: 170, h: 72 }, [OUTSIDE]: { x: 600, y: 470, w: 200, h: 56 } };
const dock = (p: string) => ({ x: BOX[p].x + 24, y: BOX[p].y });
const seg = (start: number, end: number, path: string, cut = false): RunSeg => ({ kind: "write", start: start * S, end: end * S, label: "w", path, ...(cut ? { cut: true as const } : {}) });
const run = (segs: RunSeg[]): WorkRun => ({ id: "r", agent: "claude", name: "r", segs, receipts: [], running: false, lastAt: 0, children: [] });
const ctx = (r: WorkRun): Ctx => ({ locate: (p) => ({ place: p.startsWith("a/") ? "a" : "b" }), dock, route: (x, y) => route(walkMap(new Map(Object.entries(BOX)), []), x, y), reduced: false, run: () => r });

describe("trace: a cut has no route and is reached when it is over", () => {
  const r = run([seg(0, 3, "a/x"), seg(3, 6, "b/y", true)]);
  const c = ctx(r);
  it("the move to the marked call is a cut", () => {
    const st = stateAt(r, 20 * S, c);
    expect(st.moves.filter((m) => isCut(m, c))).toHaveLength(1);
  });
  it("its way is empty and its stop is reached CUT_MS after it sets off", () => {
    const t = traceAt(r, 20 * S, c);
    const way = t.ways.find((w) => w.t0 >= 3 * S - 1)!;
    expect(way.legs).toEqual([]);
    expect(way.trip).toBeNull();
    expect(way.t1).toBe(way.t0 + CUT_MS);
    expect(t.stops.at(-1)!.at).toBe(way.t1);
  });
  it("a walk of the same length unmarked is still a walk with a route", () => {
    const w = run([seg(0, 3, "a/x"), seg(3, 6, "b/y")]);
    const way = traceAt(w, 20 * S, ctx(w)).ways.at(-1)!;
    expect(way.trip).not.toBeNull();
    expect(way.legs.length).toBeGreaterThan(0);
  });
});
