// Footprints (web/docs/workstation.md「新想法」): per node, how long workers stood there working and how
// long they wrote there — where the canvas showed them standing (a glance stays put, thinking and
// waiting happen where they stand), only what happened by the playhead, never the 图外 tray.
import { describe, expect, it } from "vitest";
import { footprints } from "./footprints.ts";
import { OUTSIDE, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const run = (id: string, segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id, agent: "pi", name: id, segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
const DOCKS: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 400, y: 0 }, [OUTSIDE]: { x: 200, y: 400 } };
const ctxOf = (runs: WorkRun[]): Ctx => ({
  locate: (p) => (p.startsWith("server/db/") ? { place: "db" } : p.startsWith("server/") ? { place: "api" } : null),
  dock: (p) => DOCKS[p] ?? DOCKS[OUTSIDE],
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
});
const byPlace = (fs: ReturnType<typeof footprints>) => Object.fromEntries(fs.map((f) => [f.place, { stood: f.stood, wrote: f.wrote, density: +f.density.toFixed(3) }]));

describe("footprints", () => {
  const pi = run("pi", [seg("read", 0, 4, "server/app.py"), seg("write", 4, 10, "server/db/models.py")]);

  it("per node: the time a worker stood there working and the time it wrote; writing weighs twice in the density", () => {
    expect(byPlace(footprints([pi], ctxOf([pi]), 0, 60 * S))).toEqual({
      api: { stood: 4000, wrote: 0, density: 0.333 },
      db: { stood: 6000, wrote: 6000, density: 1 },
    });
  });

  it("only the window: what had happened by the playhead, nothing before `from`", () => {
    expect(byPlace(footprints([pi], ctxOf([pi]), 0, 7 * S))).toEqual({
      api: { stood: 4000, wrote: 0, density: 0.667 },
      db: { stood: 3000, wrote: 3000, density: 1 },
    });
    expect(byPlace(footprints([pi], ctxOf([pi]), 5 * S, 60 * S))).toEqual({ db: { stood: 5000, wrote: 5000, density: 1 } });
  });

  it("a glance leaves footprints where the worker stood, not at the node it looked at", () => {
    const r = run("r", [seg("write", 0, 5, "server/app.py"), seg("read", 5, 6, "server/db/x.py"), seg("write", 6, 10, "server/users.py")]);
    expect(byPlace(footprints([r], ctxOf([r]), 0, 60 * S))).toEqual({ api: { stood: 10000, wrote: 9000, density: 1 } });
  });

  it("thinking and waiting count where the worker stands; lingering idle and the 图外 tray leave none", () => {
    const r = run("r", [seg("write", 0, 3, "server/app.py"), seg("think", 3, 5), seg("wait", 5, 8), seg("write", 8, 10, "docs/notes.md")]);
    expect(byPlace(footprints([r], ctxOf([r]), 0, 100 * S))).toEqual({ api: { stood: 8000, wrote: 3000, density: 1 } });
  });

  it("a sub-agent's work counts at its own nodes; a worker known only by its receipts leaves none", () => {
    const codex = run("codex", [seg("write", 3, 7, "server/db/a.py")], { parentId: "pi", spawnAt: 2 * S, doneAt: 8 * S });
    const worker = run("w", [], { parentId: "pi", coarse: true, spawnAt: 2 * S, doneAt: 9 * S });
    const main = run("pi", [seg("write", 0, 10, "server/app.py")], { children: [codex, worker] });
    const all = [main, codex, worker];
    expect(byPlace(footprints(all, ctxOf(all), 0, 60 * S))).toEqual({
      api: { stood: 10000, wrote: 10000, density: 1 },
      db: { stood: 4000, wrote: 4000, density: 0.4 },
    });
  });
});
