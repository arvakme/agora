// FX1 (RV1 P3): when this page first saw each call of a session (`seen`, the DR2 catch-up) is kept per session and let go with it, not for ever.
import { afterEach, describe, expect, it, vi } from "vitest";

type St = { bindings: Record<string, { agent: string }>; items: Record<string, unknown[]>; status: Record<string, unknown> };
let st: St = { bindings: {}, items: {}, status: {} };
const listeners = new Set<() => void>();
vi.mock("../../session/agents", () => ({
  agents: { get: () => st, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) },
  adapters: { subscribe: () => () => {} },
  agentName: (k: string) => k,
  fetchRuns: () => Promise.reject(new Error("404 not found")),
}));
vi.mock("../../multi/writes", () => ({ sessionNames: { get: () => ({}), subscribe: () => () => {} } }));
vi.mock("./derive", () => ({
  fromTree: () => ({ children: [], dispatches: new Map() }),
  runFromTranscript: (i: { sessionId: string; name: string; items: { id: string }[] }) => ({
    id: i.sessionId, agent: "claude", name: i.name, sessionId: i.sessionId, receipts: [], children: [], running: false, lastAt: 1,
    segs: i.items.map((it, n) => ({ kind: "read", start: n, end: n + 1, path: "a", label: "read", itemId: it.id })),
  }),
}));

const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));
const items = (...ids: string[]) => ids.map((id) => ({ id }));
afterEach(() => vi.unstubAllGlobals());

describe("seen: per session, released with it", () => {
  it("a session that leaves the page's bindings takes its calls' stamps with it; the others keep theirs", async () => {
    vi.stubGlobal("window", { setInterval: () => 1 });
    const { runs, seen } = await import("./store");
    st = { bindings: { s1: { agent: "claude" }, s2: { agent: "claude" } }, items: { s1: items("a", "b"), s2: items("c") }, status: {} };
    const off = runs.subscribe(() => {});
    const first = runs.get().roots.find((r) => r.id === "s2")!.segs[0].seen;
    expect(seen.size()).toBe(3);
    st = { ...st, bindings: { s2: { agent: "claude" } }, items: { s2: st.items.s2 } };
    listeners.forEach((l) => l());
    await flush();
    expect(seen.size()).toBe(1); // s1's two calls are gone
    expect(runs.get().roots.find((r) => r.id === "s2")!.segs[0].seen).toBe(first); // s2's is the very stamp it had: the catch-up is not restarted
    off();
  });
  it("the store stopping (the last subscriber leaves) lets all of them go", async () => {
    vi.stubGlobal("window", { setInterval: () => 1 });
    const { runs, seen } = await import("./store");
    st = { bindings: { s1: { agent: "claude" } }, items: { s1: items("a") }, status: {} };
    const off = runs.subscribe(() => {});
    expect(seen.size()).toBe(1);
    off();
    expect(seen.size()).toBe(0);
  });
});
