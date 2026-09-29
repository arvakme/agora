// A comment thread handed to an agent by @ (ops/agent.ts handOff): a new conversation for the thread the first
// time, the bound conversation afterwards, an existing conversation when one is mentioned; a bound conversation
// that is gone ends the hand-off. The server keeps the dispatch, binds the thread and posts the answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the canvas side pulls in Excalidraw, which vitest cannot load; a comment hand-off only needs the anchor names
vi.mock("../canvas/anchors", () => ({ resolveAnchor: () => ({ names: [{ id: "n1", name: "文件与解析" }] }) }));
vi.mock("../canvas/context", () => ({ threadRequest: () => "" }));
vi.mock("../canvas/scene", () => ({ byId: () => new Map() }));
// persist.ts reads `location` on import; only the adoption of a session file matters here
vi.mock("../persist", () => ({ adoptSession: (_id: string, s: { state: { session: { id: string } } }) => ({ sessions: { [s.state.session.id]: s.state.session }, turns: {}, batches: {} }) }));
vi.mock("../session/runTurn", () => ({ runTurn: async () => ({}), undoTurn: () => ({ ok: true, stale: [] }), sceneIndex: () => ({}) }));
import { createThreadStore } from "../comments/threads.ts";
import { threadSessionTitles } from "../comments/sessionTitles.ts";
import { handOff } from "./agent.ts";
import { agents, handleEvent } from "../session/agents.ts";
import { sessions } from "../session/store.ts";

const api = { getSceneElementsIncludingDeleted: () => [] } as never;
const anchor = { ids: ["n1"], rel: { x: 0.5, y: 0.5 }, last: { x: 0, y: 0 } };

type Body = { to?: string; new?: string; task: string; source: { kind: string; threadId: string; threadN: number; name?: string } };
let bodies: Body[];
let store: ReturnType<typeof createThreadStore>;
let refuse: string | null;

beforeEach(() => {
  bodies = [];
  refuse = null;
  sessions.reset();
  store = createThreadStore("c1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === "/api/project/snapshot") {
        const session = { id: "s-new1", canvasId: "c1", createdAt: 1, turnIds: [] };
        return new Response(JSON.stringify({ sessions: { "s-new1": { version: "v1", state: { session, turns: {}, batches: {} } } }, bindings: { "s-new1": { agent: "claude", model: "", effort: "", nativeId: "n", createdAt: 1 } } }), { status: 200 });
      }
      const body = JSON.parse(init?.body ?? "{}") as Body;
      bodies.push(body);
      if (refuse) return new Response(JSON.stringify({ error: refuse }), { status: 409 });
      const sid = body.to ?? "s-new1";
      const d = { id: `0d5f6a1e-0000-4000-8000-00000000000${bodies.length}`, state: "dispatched", source: body.source, target: { sessionId: sid, agent: body.new ?? "claude", new: !!body.new } };
      setTimeout(() => {
        store.reply(body.source.threadId, { author: "agent", text: "好了", sessionId: sid });
        void handleEvent({ t: "dispatch", dispatch: { ...d, state: "done" } } as never);
      }, 5);
      return new Response(JSON.stringify(d), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const thread = () => store.create(anchor, "@Claude Code 这里加一个说明节点");

describe("handOff", () => {
  it("the first @ of an agent opens a new conversation named after the comment and the node", async () => {
    const t = thread();
    await handOff(api, store, t.id, { agent: "claude" }, { bound: false });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].new).toBe("claude");
    expect(bodies[0].to).toBeUndefined();
    expect(bodies[0].source).toMatchObject({ kind: "comment", threadId: t.id, threadN: 1, name: "评论 #1 · 文件与解析" });
    expect(threadSessionTitles.get("s-new1")).toBe("评论 #1 · 文件与解析"); // the workspace names the new session's tab with it
    expect(sessions.get().sessions["s-new1"]).toMatchObject({ canvasId: "c1" }); // and the conversation is on the page now (adopted from the server's file, not created: a second write would conflict)
    expect(agents.get().bindings["s-new1"]).toMatchObject({ agent: "claude" });
    expect(store.thread(t.id)!.agent).toBe("idle");
    expect(store.thread(t.id)!.messages.at(-1)).toMatchObject({ author: "agent", sessionId: "s-new1" });
  });

  it("a reply in a bound thread goes to the bound conversation with only what it has not seen", async () => {
    const t = thread();
    store.reply(t.id, { author: "agent", text: "加好了", sessionId: "s-9" });
    store.reply(t.id, { author: "you", text: "再改成蓝色" });
    await handOff(api, store, t.id, { sid: "s-9" }, { bound: true, name: "评论 #1 · 文件与解析" });
    expect(bodies[0].to).toBe("s-9");
    expect(bodies[0].new).toBeUndefined();
    expect(bodies[0].task).toContain("有新的回复");
    expect(bodies[0].task).toContain("再改成蓝色");
    expect(bodies[0].task).not.toContain("这里加一个说明节点");
  });

  it("an @ on an existing conversation hands the thread to that one and names the binding after it", async () => {
    const t = thread();
    await handOff(api, store, t.id, { sid: "s-main" }, { bound: false, name: "主对话" });
    expect(bodies[0]).toMatchObject({ to: "s-main", source: { name: "主对话" } });
    expect(bodies[0].task).toContain("这里加一个说明节点"); // a conversation that has not seen the thread gets all of it
  });

  it("a bound conversation that is gone ends the hand-off and says so, so the person can @ again", async () => {
    const t = thread();
    store.merge({ seq: 1, threads: [{ ...store.thread(t.id)!, handoff: { sessionId: "s-9", agent: "claude", name: "n" }, updatedAt: Date.now() + 1 }] });
    expect(store.thread(t.id)!.handoff).toBeTruthy();
    refuse = "session s-9 has no agent yet";
    await handOff(api, store, t.id, { sid: "s-9" }, { bound: true, name: "n" });
    expect(store.thread(t.id)!.handoff).toBeNull();
    const last = store.thread(t.id)!.messages.at(-1)!;
    expect(last).toMatchObject({ author: "system", tone: "error" });
    expect(last.text).toContain("已经不在了");
    expect(store.thread(t.id)!.agent).toBe("idle");
  });

  it("any other refusal is just reported; the thread stays bound", async () => {
    const t = thread();
    store.merge({ seq: 1, threads: [{ ...store.thread(t.id)!, handoff: { sessionId: "s-9", agent: "claude", name: "n" }, updatedAt: Date.now() + 1 }] });
    refuse = "额度用完";
    await handOff(api, store, t.id, { sid: "s-9" }, { bound: true, name: "n" });
    expect(store.thread(t.id)!.handoff).toBeTruthy();
    expect(store.thread(t.id)!.messages.at(-1)!.text).toContain("没有交出去：额度用完");
  });
});

describe("the binding lives in the thread record", () => {
  it("takes in the binding the server wrote, and ending it wins over an older copy", () => {
    const t = store.create(anchor, "hi");
    const now = Date.now();
    store.merge({ seq: 1, threads: [{ ...store.thread(t.id)!, handoff: { sessionId: "s-1", agent: "codex", name: "评论 #1 · x" }, updatedAt: now + 10 }] });
    expect(store.thread(t.id)!.handoff).toEqual({ sessionId: "s-1", agent: "codex", name: "评论 #1 · x" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + 20); // the person ends it after the server bound it
    store.endHandoff(t.id);
    vi.useRealTimers();
    expect(store.thread(t.id)!.handoff).toBeNull();
    // the server's older copy (still bound) arrives late: it does not bind the thread again
    store.merge({ seq: 1, threads: [{ ...store.thread(t.id)!, handoff: { sessionId: "s-1", agent: "codex", name: "评论 #1 · x" }, updatedAt: now + 10 }] });
    expect(store.thread(t.id)!.handoff).toBeNull();
  });
});
