// The page's agent-session store: transcript upserts, status/binding, which session a
// canvas comment goes to, and a send resolving when the server reports it done.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, effortChoices, handleEvent, type Binding } from "./agents.ts";
import { commentMessage } from "../comments/handoff.ts";

const binding = (agent: Binding["agent"], createdAt: number): Binding => ({ agent, model: "m", effort: "", nativeId: "n", createdAt });
const status = { running: false, busy: false, queued: 0, held: null, activity: null, error: null, terminal: { alive: false, attach: "tmux …", clients: 0 } };

describe("agent sessions store", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("upserts transcript items; tool results merge into their call", async () => {
    await handleEvent({ t: "transcript", sessionId: "s1", reset: true, items: [{ id: "u1", kind: "user", text: "hi", at: 1, source: "terminal" }, { id: "t1", kind: "tool", at: 2, tool: { name: "Bash", input: "agora canvas read" } }] });
    await handleEvent({ t: "transcript", sessionId: "s1", items: [{ id: "t1", kind: "tool", at: 3, tool: { output: "{...}" } }, { id: "a1", kind: "assistant", text: "ok", at: 4 }] });
    const items = agents.get().items.s1;
    expect(items.map((i) => i.id)).toEqual(["u1", "t1", "a1"]);
    expect(items[1].tool).toEqual({ name: "Bash", input: "agora canvas read", output: "{...}" });
    await handleEvent({ t: "transcript", sessionId: "s1", reset: true, items: [] });
    expect(agents.get().items.s1).toEqual([]);
  });

  it("status carries the locked binding", async () => {
    await handleEvent({ t: "status", sessionId: "s2", binding: binding("codex", 5), ...status, running: true });
    expect(agents.get().bindings.s2.agent).toBe("codex");
    expect(agents.get().status.s2.running).toBe(true);
    await handleEvent({ t: "status", sessionId: "s9", binding: {}, ...status });
    expect(agents.get().bindings.s9).toBeUndefined(); // not bound yet: the pane shows the picker
  });

  it("a canvas's comments go to its most recently active bound session", () => {
    agents.hydrateBindings({ a: binding("pi", 10), b: binding("claude", 20) });
    expect(agents.forCanvas(["a", "b", "unbound"])).toBe("b");
    expect(agents.forCanvas(["unbound"])).toBeUndefined();
  });

  it("send resolves on done, with the canvas changes made meanwhile", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(JSON.stringify({ sendId: "m-1", route: "terminal" }), { status: 200 }));
    const r = await agents.send("s3", "改一下", { canvasId: "c1", thread: { threadId: "th", threadN: 2, anchor: "Redis" } });
    expect(r.route).toBe("terminal");
    expect(agents.get().inflight.s3).toMatchObject({ sendId: "m-1", threadId: "th" });
    agents.noteTurn("s3", "t-apply");
    await handleEvent({ t: "done", sessionId: "s3", sendId: "m-1", text: "改好了", route: "terminal" });
    await expect(r.done).resolves.toMatchObject({ text: "改好了", turnIds: ["t-apply"] });
    expect(agents.get().inflight.s3).toBeUndefined();
  });

  it("a refused bind surfaces the server's reason", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(new Response(JSON.stringify({ error: "session s4 is bound to pi", locked: true }), { status: 409 }));
    await expect(agents.bind("s4", "claude", "", "")).rejects.toThrow("bound to pi");
  });
});

describe("comment hand-off message", () => {
  it("names the thread, anchors (with ids) and who said what", () => {
    const msg = commentMessage(
      { n: 3, messages: [{ id: "1", author: "you", text: "换成集群", at: 0, by: { id: "mailto:a", name: "Ann" } }, { id: "2", author: "agent", text: "好", at: 0 }] },
      [{ id: "redis", name: "Redis" }],
    );
    expect(msg.split("\n")).toEqual(["画布评论 #3（锚点：Redis（redis））：", "- Ann：换成集群", "- Agent：好", "", "请按这条评论处理画布，完成后用一两句话答复（会贴回评论线程）。"]);
  });
});

describe("effort choices", () => {
  const entry = {
    kind: "codex" as const,
    name: "Codex",
    installed: true,
    default: "",
    models: ["gpt-6-astra", "gpt-5.5"],
    featured: ["gpt-6-astra", "gpt-5.5"],
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "xhigh",
    modelEfforts: { "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"], "gpt-5.5": ["low", "medium", "high", "xhigh"], haiku: [] },
    modelDefaultEffort: { "gpt-6-astra": "xhigh", "gpt-5.5": "", haiku: "" },
  };
  it("offers exactly what the model takes and starts on its default", () => {
    expect(effortChoices(entry, "gpt-6-astra")).toEqual({ levels: ["low", "medium", "high", "xhigh", "max", "ultra"], initial: "xhigh", cliDefault: false });
    const old = effortChoices(entry, "gpt-5.5");
    expect(old.levels).not.toContain("max");
    expect(old).toMatchObject({ initial: "", cliDefault: true });
    expect(effortChoices(entry, "haiku").levels).toEqual([]);
  });
  it("falls back to the agent's vocabulary for a model the catalog does not list", () => {
    expect(effortChoices(entry, "custom").levels).toEqual(entry.efforts);
    expect(effortChoices(undefined, "x")).toEqual({ levels: [], initial: "", cliDefault: true });
  });
});
