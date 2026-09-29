// 短读只看 only for a read whose length is real (web/docs/workstation.md §2): a dispatched Codex reports a command with the same start
// and end, so its segment is padded to a fixed length (`durationKnown: false`) and is not a glance; several reads in a row at one node
// are work there, however short each is; a single real short read (Claude's Read) is still a glance.
import { describe, expect, it } from "vitest";
import { stateAt, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string, x: Partial<RunSeg> = {}): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}), ...x });
const run = (segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id: "r", agent: "codex", name: "Codex", segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
const DOCKS: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, cp: { x: 400, y: 0 } };
// DEMO1: controlplane/internal/ratelimit/ratelimit.go lies on the node `cp`; anything else read is outside the project
const ctx = (runs: WorkRun[]): Ctx => ({
  locate: (p) => (p.startsWith("controlplane/") ? { place: "cp" } : p.startsWith("server/") ? { place: "api" } : null),
  dock: (p) => DOCKS[p] ?? { x: 200, y: 400 },
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
});
const at = (r: WorkRun, sec: number) => stateAt(r, sec * S, ctx([r]));
const RL = "controlplane/internal/ratelimit/ratelimit.go";
const WRITE_API = seg("write", 0, 3, "server/app.py");

describe("a read whose length is not known walks to the node (DEMO1: the dispatched Codex reads ratelimit.go)", () => {
  it("a padded 0.6 s read of a node walks there, it is not a glance", () => {
    const r = run([WRITE_API, seg("read", 3, 3.6, RL, { durationKnown: false })]);
    const s = at(r, 3.2);
    expect(s).toMatchObject({ at: "cp", from: "api", pose: "walk" });
    expect(s.glance).toBeUndefined();
    expect(s.moves).toHaveLength(1);
  });
  it("the same read with a real short length is still a glance (Claude's Read)", () => {
    const r = run([WRITE_API, seg("read", 3, 3.6, RL)], { agent: "claude" });
    expect(at(r, 3.2)).toMatchObject({ at: "api", pose: "read", glance: { place: "cp" }, moves: [] });
  });
  it("outside the project (task.md, a skill) stays outside", () => {
    const r = run([seg("read", 3, 3.6, "/tmp/task.md", { durationKnown: false })]);
    expect(at(r, 3.2).at).toBe("\u0000outside");
  });
});

describe("several reads in a row at one node are work there", () => {
  it("two short real reads at the same node walk over as the first starts", () => {
    const r = run([WRITE_API, seg("read", 3, 3.5, `${RL}`), seg("read", 3.6, 4.1, "controlplane/internal/ratelimit/other.go")]);
    expect(at(r, 3.2)).toMatchObject({ at: "cp", from: "api", pose: "walk" });
  });
  it("one short read among reads of other nodes stays a glance", () => {
    const r = run([WRITE_API, seg("read", 3, 3.5, RL), seg("read", 3.6, 4.1, "server/other.py")], { agent: "claude" });
    expect(at(r, 3.2)).toMatchObject({ at: "api", glance: { place: "cp" }, moves: [] });
  });
});
