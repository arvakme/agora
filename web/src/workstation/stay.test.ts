// A route on the canvas keeps its figure: the traced worker does not leave after a minute idle (it stands where it finished).
import { describe, expect, it } from "vitest";
import { FADE_MS, IDLE_LEAVE_MS, OUTSIDE, stateAt, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const run = (segs: RunSeg[]): WorkRun => ({ id: "r", agent: "pi", name: "Pi", segs, receipts: [], running: false, lastAt: 0, children: [], ...{} });
const ctx = (r: WorkRun, stay?: ReadonlySet<string>): Ctx => ({
  locate: (p) => (p.startsWith("server/") ? { place: "api" } : null),
  dock: () => ({ x: 0, y: 0 }),
  reduced: false,
  run: (id) => (id === r.id ? r : undefined),
  ...(stay ? { stay } : {}),
});

describe("a traced worker stays", () => {
  const r = run([seg("read", 2, 4, "server/app.py")]);
  const late = 4 * S + IDLE_LEAVE_MS + FADE_MS + 5000;
  it("without a trace it has left by then", () => {
    expect(stateAt(r, late, ctx(r)).present).toBe(false);
  });
  it("traced, it is still there, fully drawn, where it finished, idle", () => {
    expect(stateAt(r, late, ctx(r, new Set(["r"])))).toMatchObject({ present: true, fade: 1, at: "api", pose: "idle" });
    expect(stateAt(r, late, ctx(r, new Set(["r"]))).at).not.toBe(OUTSIDE);
  });
  it("another traced run does not keep this one", () => {
    expect(stateAt(r, late, ctx(r, new Set(["other"]))).present).toBe(false);
  });
});
