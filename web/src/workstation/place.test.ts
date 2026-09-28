// stateAt: where a worker is and what it does at t is a pure function of its run and t — jumping to
// a moment gives the same state as playing up to it; idle workers leave after a minute; sub-agents
// start at their dispatcher, walk back and hand over.
import { describe, expect, it } from "vitest";
import { bursts, FADE_MS, HANDOFF_MS, IDLE_LEAVE_MS, OUTSIDE, stateAt, writeConflicts, conflictAt, type Ctx } from "./place.ts";
import { scenario } from "./runs/fixtures.ts";
import type { AgentRun, RunSeg } from "./runs/types.ts";

const S = 1000;
const seg = (kind: RunSeg["kind"], start: number, end: number, path?: string): RunSeg => ({ kind, start: start * S, end: end * S, label: kind, ...(path ? { path } : {}) });
const run = (segs: RunSeg[], x: Partial<AgentRun> = {}): AgentRun => ({ id: "r", agent: "pi", name: "Pi", segs, receipts: [], running: false, lastAt: 0, children: [], ...x });
const NODES: Record<string, { x: number; y: number }> = { api: { x: 0, y: 0 }, db: { x: 400, y: 0 }, [OUTSIDE]: { x: 200, y: 400 } };
const ctx = (runs: AgentRun[] = [], reduced = false): Ctx => ({
  locate: (p) => (p.startsWith("server/db/") ? { place: "db" } : p.startsWith("server/") ? { place: "api" } : p.startsWith("orders/") ? { place: "api", portal: { canvasId: "c2", label: "订单模块" } } : null),
  dock: (p) => NODES[p] ?? NODES[OUTSIDE],
  reduced,
  run: (id) => runs.find((r) => r.id === id),
});

describe("stateAt: a session's worker", () => {
  const r = run([seg("think", 0, 2), seg("read", 2, 4, "server/app.py"), seg("write", 6, 9, "server/db/models.py"), seg("wait", 9, 12), seg("write", 20, 22, "docs/notes.md")]);
  const c = ctx([r]);
  it("is absent before any work, and appears where its first work lands", () => {
    expect(stateAt(r, -1, c).present).toBe(false);
    expect(stateAt(r, 1 * S, c)).toMatchObject({ present: true, at: "api", pose: "think" });
  });
  it("walks to the node of the next file as that call starts, then works there", () => {
    const s = stateAt(r, 6.2 * S, c);
    expect(s).toMatchObject({ at: "db", from: "api", pose: "walk" });
    expect(s.w).toBeGreaterThan(0);
    expect(s.w).toBeLessThan(1);
    const w = s.walk!;
    expect(stateAt(r, w.t1 + 1, c)).toMatchObject({ at: "db", pose: "write", w: 1 });
    expect(stateAt(r, 10 * S, c)).toMatchObject({ at: "db", pose: "wait" });
  });
  it("goes to the 图外 tray for files off the diagram", () => {
    expect(stateAt(r, 23 * S, c).at).toBe(OUTSIDE);
  });
  it("jumping straight to a time gives the same state as stepping there", () => {
    for (const t of [0.5, 3, 6.4, 7.5, 11, 21.5, 30].map((x) => x * S)) {
      let stepped = stateAt(r, 0, c);
      for (let u = 0; u <= t; u += 250) stepped = stateAt(r, u, c);
      expect(stateAt(r, t, ctx([r]))).toEqual(stateAt(r, t, c));
      if (t % 250 === 0) expect(stepped).toEqual(stateAt(r, t, c));
    }
  });
  it("leaves the canvas after a minute idle (fading out), and comes back where new work is", () => {
    const end = 22 * S;
    expect(stateAt(r, end + IDLE_LEAVE_MS - 1, c)).toMatchObject({ present: true, fade: 1, pose: "idle" });
    const fading = stateAt(r, end + IDLE_LEAVE_MS + FADE_MS / 2, c);
    expect(fading.present).toBe(true);
    expect(fading.fade).toBeCloseTo(0.5, 5);
    expect(stateAt(r, end + IDLE_LEAVE_MS + FADE_MS + 1, c).present).toBe(false);
    const back = run([...r.segs, seg("read", 200, 205, "server/db/x.py")]);
    // a new stretch: appears at its first place, no walk from where it left
    expect(stateAt(back, 201 * S, ctx([back]))).toMatchObject({ present: true, at: "db", pose: "read", w: 1, walk: null });
  });
  it("reduced motion: never walks", () => {
    expect(stateAt(r, 6.2 * S, ctx([r], true))).toMatchObject({ at: "db", pose: "write", w: 1, walk: null });
  });
  it("names the child canvas when the file lies below the node", () => {
    const p = run([seg("write", 0, 5, "orders/service.py")]);
    expect(stateAt(p, 1 * S, ctx([p])).portal).toEqual({ canvasId: "c2", label: "订单模块" });
  });
});

describe("bursts", () => {
  it("splits work where nothing happened for over a minute", () => {
    const b = bursts([seg("read", 0, 1), seg("read", 30, 31), seg("read", 200, 201)]);
    expect(b.map((x) => x.length)).toEqual([2, 1]);
  });
});

describe("stateAt: sub-agents (the prototype's scenario)", () => {
  const base = 1_000_000;
  const [pi, cc] = scenario(base, base + 60 * S);
  const all = [pi, ...pi.children, cc, ...cc.children];
  const c: Ctx = { ...ctx(all), locate: (p) => (p.startsWith("server/") ? { place: "api" } : p.startsWith("web/") ? { place: "web" } : null), dock: (p) => ({ api: { x: 0, y: 0 }, web: { x: -300, y: 0 } })[p] ?? { x: 300, y: 300 } };
  const codex = pi.children[0];
  const worker = pi.children[1];
  it("a sub-agent appears at its dispatcher's spot when dispatched", () => {
    expect(stateAt(codex, codex.spawnAt! - 1, c).present).toBe(false);
    expect(stateAt(codex, codex.spawnAt! + 100, c)).toMatchObject({ present: true, at: stateAt(pi, codex.spawnAt!, c).at });
  });
  it("walks back to its dispatcher, hands over, then fades out", () => {
    const done = codex.doneAt!;
    const back = stateAt(codex, done + 10, c);
    expect(back.pose).toBe("walk");
    expect(back.at).toBe(stateAt(pi, done, c).at);
    const arrive = back.walk!.t1;
    expect(stateAt(codex, arrive + 10, c).pose).toBe("handoff");
    expect(stateAt(codex, arrive + HANDOFF_MS + FADE_MS + 10, c).present).toBe(false);
  });
  it("a receipts-only worker never moves and shows it only has receipts", () => {
    const s = stateAt(worker, worker.spawnAt! + 3 * S, c);
    expect(s.moves).toEqual([]);
    expect(s.pose).toBe("unknown");
    expect(stateAt(worker, worker.doneAt! + 10, c).fade).toBeLessThan(1);
    expect(stateAt(worker, worker.doneAt! + FADE_MS + 10, c).present).toBe(false);
  });
});

describe("writeConflicts", () => {
  it("finds two runs writing one file at overlapping times", () => {
    const a = run([seg("write", 0, 10, "server/users.py")], { id: "a" });
    const b = run([seg("write", 5, 12, "server/users.py"), seg("write", 20, 30, "server/x.py")], { id: "b" });
    const list = writeConflicts([a, b]);
    expect(list).toEqual([{ path: "server/users.py", start: 5 * S, end: 10 * S, runs: ["a", "b"] }]);
    expect(conflictAt(list, "a", 7 * S)).not.toBeNull();
    expect(conflictAt(list, "a", 11 * S)).toBeNull();
  });
});

describe("appearing", () => {
  it("fades in over a moment instead of popping", async () => {
    const { APPEAR_MS } = await import("./place.ts");
    const r = run([seg("read", 10, 20, "server/a.py")]);
    const c = ctx([r]);
    expect(stateAt(r, 10 * S + APPEAR_MS / 2, c).fade).toBeCloseTo(0.5, 5);
    expect(stateAt(r, 10 * S + APPEAR_MS + 1, c).fade).toBe(1);
  });
});
