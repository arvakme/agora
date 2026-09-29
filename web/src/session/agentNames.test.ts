// 名字不再是 undefined (session/agents.ts `agentName` / `useAgentName`): what an agent is called before the adapter list has answered, after it, and
// when the page hears the list arrive. (A component using `useAgentName` is drawn again on that notice: the hook subscribes to `adapters`.)
import { afterEach, describe, expect, it, vi } from "vitest";

const KINDS = ["pi", "claude", "codex", "grok", "cursor", "devin"];
const info = (kind: string, name: string) => ({ kind, name, tier: "T1", maxTier: "T1", installed: true, tested: "", caps: { headless: true, terminal: true, catalog: true, subagents: false, forkHeadless: true, cost: false, waits: "none" }, icon: { kind: "mark", src: kind }, logDir: `~/.${kind}/`, deleteCommand: null });
const REGISTRY = [info("pi", "Pi"), info("claude", "Claude Code"), info("codex", "Codex"), info("grok", "Grok"), info("cursor", "Cursor"), info("devin", "Devin")];

describe("what an agent is called", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("before the adapter list has answered: the three built-in names, the others their kind with a capital — never undefined or a bare lower-case kind", async () => {
    const m = await import("./agents.ts");
    expect(m.agentName("pi")).toBe("Pi");
    expect(m.agentName("claude")).toBe("Claude Code");
    expect(m.agentName("codex")).toBe("Codex");
    expect(m.agentName("grok")).toBe("Grok");
    expect(m.agentName("cursor")).toBe("Cursor");
    expect(m.agentName("devin")).toBe("Devin");
    expect(m.agentName("droid")).toBe("Droid");
    for (const k of [...KINDS, "droid", "worker", "x"]) {
      const n = m.agentName(k);
      expect(n, k).not.toMatch(/undefined/);
      expect(n[0], k).toBe(n[0].toUpperCase());
    }
    expect(m.agentName(undefined)).toBe("Agent");
    expect(m.agentName("")).toBe("Agent");
  });

  it("after: the registry's names (a CLI's own spelling wins), and still never undefined for one it does not list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [...REGISTRY.slice(0, 3), info("grok", "Grok CLI")] })));
    const m = await import("./agents.ts");
    await m.loadAdapters();
    expect(m.agentName("grok")).toBe("Grok CLI");
    expect(m.agentName("claude")).toBe("Claude Code");
    expect(m.agentName("cursor")).toBe("Cursor"); // not listed: its kind with a capital
    for (const k of [...KINDS, "droid"]) expect(m.agentName(k)).not.toMatch(/undefined/);
  });

  it("the page hears the list arrive (what draws a name is drawn again), also when the list cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => REGISTRY })));
    const m = await import("./agents.ts");
    const heard = vi.fn();
    const off = m.adapters.subscribe(heard);
    const v0 = m.adapters.version();
    expect(m.agentName("grok")).toBe("Grok");
    await m.loadAdapters();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(m.adapters.version()).toBe(v0 + 1);
    off();
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const n = await import("./agents.ts");
    const heard2 = vi.fn();
    n.adapters.subscribe(heard2);
    await n.loadAdapters();
    expect(heard2).toHaveBeenCalledTimes(1);
    expect(n.agentName("grok")).toBe("Grok");
  });

  it("a caller that is not a component asks again and gets the new name (the run's name in the workstation)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [info("grok", "Grok CLI")] })));
    const m = await import("./agents.ts");
    const { runName } = await import("../workstation/runs/store.ts");
    const bound = { s1: { agent: "grok" } };
    expect(runName("s1", bound, {})).toBe("Grok");
    await m.loadAdapters();
    expect(runName("s1", bound, {})).toBe("Grok CLI");
  });
});
