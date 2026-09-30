// 短读只看 (./place.ts stateAt; web/docs/workstation.md §2): a read of another node that is short —
// one read of a real length, under GLANCE_MS, with nothing else right after it at that node — is a
// glance: the worker stays where it stands, in the read pose, looking over at that node. A longer
// read, or one followed by writing or running something there, walks over as the read starts. Still
// a pure function of the log and t.
import { describe, expect, it } from "vitest";
import { GLANCE_MS, stateAt, type Ctx } from "./place.ts";
import type { RunSeg, WorkRun } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string, x: Partial<RunSeg> = {}): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}), ...x });
const run = (segs: RunSeg[], x: Partial<WorkRun> = {}): WorkRun => ({ id: "r", agent: "pi", name: "Pi", segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
const DOCKS: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 400, y: 0 } };
const ctx = (runs: WorkRun[]): Ctx => ({
  locate: (p) => (p.startsWith("server/db/") ? { place: "db" } : p.startsWith("server/") ? { place: "api" } : null),
  dock: (p) => DOCKS[p] ?? { x: 200, y: 400 },
  reduced: false,
  run: (id) => runs.find((r) => r.id === id),
});
const at = (r: WorkRun, sec: number) => stateAt(r, sec * S, ctx([r]));
const WRITE_API = seg("write", 0, 3, "server/app.py");

describe("stateAt: a short read is a glance (短读只看)", () => {
  it("a read of another node under GLANCE_MS: the worker stays put in the read pose, looking over at that node — no walk", () => {
    expect(GLANCE_MS).toBe(2500);
    const r = run([WRITE_API, seg("read", 3, 5.4, "server/db/models.py"), seg("write", 5.4, 9, "server/app.py")]);
    expect(at(r, 4)).toMatchObject({ at: "api", pose: "read", glance: { place: "db" }, moves: [], trip: null, w: 1 });
    const after = at(r, 6);
    expect(after).toMatchObject({ at: "api", pose: "write", moves: [], trip: null });
    expect(after.glance).toBeUndefined();
  });

  it("several reads in a row at that node are work there, however short: the worker walks over as the first read starts", () => {
    const two = run([WRITE_API, seg("read", 3, 4, "server/db/a.py"), seg("read", 4, 5.4, "server/db/b.py"), seg("think", 5.4, 8)]);
    const s = at(two, 3.1);
    expect(s).toMatchObject({ at: "db", from: "api", pose: "walk" });
    expect(s.glance).toBeUndefined();
    expect(s.moves).toEqual([{ from: "api", to: "db", t: 3 * S, slot: 0 }]);
    expect(at(two, 7)).toMatchObject({ at: "db", pose: "think", w: 1 });
  });

  it("a read of GLANCE_MS or more walks over", () => {
    const r = run([WRITE_API, seg("read", 3, 5.5, "server/db/models.py")]);
    expect(at(r, 3.1)).toMatchObject({ at: "db", pose: "walk" });
    expect(at(r, 3.1).moves).toHaveLength(1);
  });

  it("a short read followed by a write or a command at that node walks over", () => {
    const write = run([WRITE_API, seg("read", 3, 3.5, "server/db/models.py"), seg("write", 3.5, 6, "server/db/models.py")]);
    expect(at(write, 3.2)).toMatchObject({ at: "db", from: "api", pose: "walk" });
    const cmd = run([WRITE_API, seg("read", 3, 3.5, "server/db/models.py"), seg("exec", 3.5, 6, "server/db/migrate.py", { cmd: "python server/db/migrate.py" })]);
    expect(at(cmd, 3.2)).toMatchObject({ at: "db", from: "api", pose: "walk" });
  });

  it("sub-agents glance too, from where they were sent", () => {
    const parent = run([WRITE_API, seg("delegate", 3, 4)], { id: "p" });
    const sub = run([seg("read", 4.5, 5, "server/db/models.py"), seg("write", 5, 9, "server/app.py")], { id: "s", parentId: "p", spawnAt: 4 * S, doneAt: 9 * S });
    const c = ctx([parent, sub]);
    expect(stateAt(sub, 4.7 * S, c)).toMatchObject({ at: "api", pose: "read", glance: { place: "db" }, moves: [] });
  });

  it("is a pure function of the log and t: jumping to a time and stepping there agree", () => {
    const r = run([WRITE_API, seg("read", 3, 4, "server/db/a.py"), seg("read", 4.2, 6, "server/db/b.py"), seg("write", 6, 9, "server/app.py"), seg("read", 9, 10, "server/db/c.py")]);
    const c = ctx([r]);
    for (const t of [0.5, 3.4, 4.1, 4.6, 6.2, 8, 9.5, 11].map((x) => x * S)) {
      let stepped = stateAt(r, 0, c);
      for (let u = 0; u <= t; u += 100) stepped = stateAt(r, u, c);
      expect(stateAt(r, t, ctx([r]))).toEqual(stateAt(r, t, c));
      if (t % 100 === 0) expect(stepped).toEqual(stateAt(r, t, c));
    }
  });
});
