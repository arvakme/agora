// The adapter registry on the page (GET /api/agent/adapters): which CLIs the picker offers, their
// names, where their logs are and how to delete a native session — no CLI names hard-coded
// beyond the fallback used before the list arrives.
import { afterEach, describe, expect, it, vi } from "vitest";

const info = (kind: string, name: string, tier: string, extra: Record<string, unknown> = {}) => ({
  kind,
  name,
  tier,
  maxTier: tier,
  installed: true,
  tested: "",
  caps: { headless: tier === "T1", terminal: tier === "T1", catalog: tier === "T1", subagents: false, forkHeadless: true, cost: false, waits: "none" },
  icon: { kind: "mark", src: kind },
  logDir: `~/.${kind}/`,
  deleteCommand: null,
  seedmuxNames: [kind],
  ...extra,
});

describe("adapter registry on the page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to the three built-in session agents before the list loads", async () => {
    const m = await import("./agents.ts");
    expect(m.sessionKinds()).toEqual(["pi", "claude", "codex"]);
    expect(m.deleteCommandOf("codex")).toBe("codex delete {id}");
    expect(m.forkHeadless("codex")).toBe(false);
    expect(m.agentName("grok")).toBe("grok");
  });

  it("uses the server's list: T1 kinds for the picker, names, log dirs and delete commands for any CLI", async () => {
    const list = [info("pi", "Pi", "T1"), info("claude", "Claude Code", "T1"), info("codex", "Codex", "T1", { deleteCommand: "codex delete {id}", caps: { forkHeadless: false } }), info("grok", "Grok", "T2", { deleteCommand: "grok sessions delete {id}" })];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => list })));
    const m = await import("./agents.ts");
    await m.loadAdapters();
    expect(m.sessionKinds()).toEqual(["pi", "claude", "codex"]);
    expect(m.agentName("grok")).toBe("Grok");
    expect(m.AGENT_NAMES.grok).toBe("Grok");
    expect(m.logDirOf("grok")).toBe("~/.grok/");
    expect(m.deleteCommandOf("grok")).toBe("grok sessions delete {id}");
    const { nativeRemoval } = await import("../workspace/trash.ts");
    expect(nativeRemoval({ agent: "grok", nativeId: "g-1" } as never)).toBe("grok sessions delete g-1");
    expect(nativeRemoval({ agent: "claude", nativeId: "c-1", logPath: "/l/c-1.jsonl" } as never)).toBe("rm /l/c-1.jsonl");
  });
});
