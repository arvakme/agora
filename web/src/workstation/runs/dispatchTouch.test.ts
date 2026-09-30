// FX4 · P2 #5: what an agent changed on the canvas through the page is work at those nodes — also for a session that another session gave a task to (its own
// top-level run is dropped, the giver's child run is what is drawn: the touches must be in that one).
import { describe, expect, it, vi } from "vitest";

type St = { bindings: Record<string, { agent: string }>; items: Record<string, unknown[]>; status: Record<string, unknown> };
const st: St = { bindings: { boss: { agent: "claude" }, worker: { agent: "claude" } }, items: { boss: [], worker: [] }, status: {} };
vi.mock("../../session/agents", () => ({
  agents: { get: () => st, subscribe: () => () => {} },
  adapters: { subscribe: () => () => {} },
  agentName: (k: string) => k,
  fetchRuns: () => Promise.resolve({}),
}));
vi.mock("../../multi/writes", () => ({ sessionNames: { get: () => ({}), subscribe: () => () => {} } }));
const seg = (kind: string, start: number, end: number, extra: object = {}) => ({ kind, start, end, label: kind, ...extra });
const base = (id: string) => ({ id, sessionId: id, agent: "claude", name: id, segs: [seg("exec", 900, 6000, { cmd: "agora canvas apply" })], children: [] as unknown[], receipts: [], lastAt: 6000, running: false });
vi.mock("./derive", () => ({
  runFromTranscript: (i: { sessionId: string }) => base(i.sessionId),
  fromTree: () => ({ children: [{ ...base("dispatch-worker"), sessionId: undefined, parentId: "boss", dispatchSession: "worker" }], dispatches: new Map() }),
}));

const flush = () => new Promise<void>((r) => setTimeout(r, 20));

describe("a session that was given a task: its canvas changes are in the run that is drawn", () => {
  it("boss → worker (worker is a bound session): the worker's top-level run is dropped, and the child run has the edit at the node", async () => {
    vi.stubGlobal("window", { setInterval: () => 1 });
    const { runs } = await import("./store");
    const { touches } = await import("./touch");
    touches.clear();
    touches.record({ session: "worker", canvas: "c", at: 1000, until: 1000, say: "edit", nodes: [{ id: "node", x: 0, y: 0 }] });
    const off = runs.subscribe(() => {});
    await flush();
    await flush();
    const r = runs.get();
    expect(r.roots.map((x) => x.id)).toEqual(["boss"]);
    const child = r.flat.find((f) => f.run.id === "dispatch-worker")!.run;
    expect(child.segs.filter((s) => (s as { edit?: unknown }).edit)).toHaveLength(1);
    const boss = r.roots[0];
    expect(boss.lastAt).toBeGreaterThanOrEqual(child.lastAt); // the ancestors' lastAt follows
    off();
    vi.unstubAllGlobals();
  });
});
