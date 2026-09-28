// The day's summary (web/docs/workstation.md「新想法」): from the runs alone — how many agents worked, how
// many walks from node to node, files written, commands run, how long someone waited on you, and the
// node with the most work — up to the playhead. The prototype's scenario, worked out by hand.
import { describe, expect, it } from "vitest";
import type { Ctx } from "./place.ts";
import { scenario } from "./runs/fixtures.ts";
import { flatten, type RunSeg, type WorkRun } from "./runs/types.ts";
import { summarize } from "./summary.ts";

const S = 1000;
const base = 1_000_000;
const all = flatten(scenario(base, base + 60 * S)).map((f) => f.run);
// the prototype's diagram: Web 前端, API 服务, MySQL, Redis, 支付服务; tests/ and docs/ are off it
const ctx: Ctx = {
  locate: (p) =>
    p.startsWith("server/db/") ? { place: "db" } : p.startsWith("server/payments/") ? { place: "pay" } : p.startsWith("server/cache/") ? { place: "cache" } : p.startsWith("server/") ? { place: "api" } : p.startsWith("web/") ? { place: "web" } : null,
  dock: (p) => ({ web: { x: -300, y: 0 }, api: { x: 0, y: 0 }, db: { x: 300, y: 200 }, cache: { x: 0, y: 200 }, pay: { x: 300, y: 0 } })[p] ?? { x: 600, y: 300 },
  reduced: false,
  run: (id) => all.find((r) => r.id === id),
};

describe("summarize", () => {
  it("the whole scenario: 5 agents (3 sub-agents), 9 walks between nodes, 4 files written, 3 commands, 6 s waiting on you, API 服务 the busiest", () => {
    // walks: Pi api→db→api→图外, Claude Code web→pay→api→pay→cache, Codex api→图外 and back to hand over;
    // the Claude sub-agent only glances at docs/ (no walk); the receipts-only worker never moves
    expect(summarize(all, ctx, base, base + 46 * S)).toEqual({ agents: 5, subs: 3, steps: 9, files: 4, commands: 3, waited: 6000, busiest: { place: "api", ms: 41_900 } });
  });

  it("up to the playhead (20 s in): only what had happened by then", () => {
    expect(summarize(all, ctx, base, base + 20 * S)).toEqual({ agents: 3, subs: 1, steps: 5, files: 2, commands: 0, waited: 0, busiest: { place: "api", ms: 21_500 } });
  });

  it("two agents waiting on you at once count once", () => {
    const wait = (s: number, e: number): RunSeg => ({ kind: "wait", start: s * S, end: e * S, label: "等你回复" });
    const a: WorkRun = { id: "a", agent: "pi", name: "Pi", segs: [wait(0, 10)], receipts: [], running: false, lastAt: 0, children: [] };
    const b: WorkRun = { ...a, id: "b", name: "Codex", segs: [wait(5, 15)] };
    expect(summarize([a, b], { ...ctx, run: () => undefined }, 0, 60 * S).waited).toBe(15_000);
  });
});
