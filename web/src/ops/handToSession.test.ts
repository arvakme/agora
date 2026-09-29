// "交给 Agent" from a comment (ops/agent.ts handToSession): goes to a live session, never a dead one, as a
// dispatch the server keeps (it posts the answer into the thread; this page only starts it and shows it); a
// refused hand-over leaves a way to pick another session, and picking one sends again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// the canvas side pulls in Excalidraw, which vitest cannot load; a comment hand-off only needs the anchor names
vi.mock("../canvas/anchors", () => ({ resolveAnchor: () => ({ names: [] }) }));
vi.mock("../canvas/context", () => ({ threadRequest: () => "" }));
vi.mock("../canvas/scene", () => ({ byId: () => new Map() }));
vi.mock("../session/runTurn", () => ({ runTurn: async () => ({}), undoTurn: () => ({ ok: true, stale: [] }), sceneIndex: () => ({}) }));
import { createThreadStore } from "../comments/threads.ts";
import { handToSession } from "./agent.ts";
import { agents, handleEvent, type Binding } from "../session/agents.ts";
import { sessions } from "../session/store.ts";
import { openSessions, ui } from "../session/ui.ts";
import { pointerFollow } from "../pointer/follow.ts";

const binding = (agent: Binding["agent"], createdAt: number): Binding => ({ agent, model: "m", effort: "", nativeId: "n", createdAt });
const status = { running: false, busy: false, queued: 0, held: null, activity: null, error: null, terminal: { alive: false, attach: "", clients: 0, app: null } };
const goneNative = { state: "missing", blocking: true, nativeId: "n", candidates: [], message: "原生会话目录已不在" };
const api = { getSceneElementsIncludingDeleted: () => [] } as never;
const anchor = { kind: "canvas" } as never;

let bodies: { url: string; body: { to: string; task: string; source: { kind: string; threadId: string } } }[];
let posted: { store: ReturnType<typeof createThreadStore>; id: string } | null = null;
let failFor: Set<string>;

beforeEach(() => {
  sessions.reset();
  bodies = [];
  failFor = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      bodies.push({ url, body });
      if (failFor.has(body.to)) return new Response(JSON.stringify({ error: "session s 的原生会话不在了" }), { status: 409 });
      const n = bodies.length;
      const d = { id: `0d5f6a1e-0000-4000-8000-00000000000${n}`, state: "dispatched", source: body.source, target: { sessionId: body.to, agent: "claude", new: false } };
      // Later the server's turn ends: it posts the answer into the thread file and tells the page.
      setTimeout(() => {
        posted?.store.reply(body.source.threadId, { author: "agent", text: "好了", sessionId: body.to });
        void handleEvent({ t: "dispatch", dispatch: { ...d, state: "done" } });
      }, 5);
      return new Response(JSON.stringify(d), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  ui.chooseAgent = async () => undefined;
  for (const id of ["dead", "live", "watched", "picked"]) agents.forget(id);
  pointerFollow.set("");
});

const setup = async (specs: Record<string, { agent: Binding["agent"]; at: number; dead?: boolean }>) => {
  for (const [id, s] of Object.entries(specs)) {
    sessions.create("c1", id);
    agents.hydrateBindings({ [id]: binding(s.agent, s.at) });
    await handleEvent({ t: "status", sessionId: id, binding: binding(s.agent, s.at), ...status, ...(s.dead ? { native: goneNative } : {}) });
    await handleEvent({ t: "transcript", sessionId: id, items: [{ id: `u-${id}`, kind: "user", at: s.at }] });
  }
  const store = createThreadStore("c1");
  const t = store.create(anchor, "把缓存换成 Redis");
  posted = { store, id: t.id };
  return { store, id: t.id };
};

describe("handToSession", () => {
  it("sends to the live session, skipping a dead one that was more recently active", async () => {
    const { store, id } = await setup({ dead: { agent: "pi", at: 50, dead: true }, live: { agent: "claude", at: 10 } });
    await handToSession(api, store, id);
    expect(bodies.map((b) => [b.url, b.body.to])).toEqual([["/api/agent/dispatches", "live"]]);
    expect(bodies[0].body.source).toMatchObject({ kind: "comment", threadId: id });
    expect(store.thread(id)!.messages.at(-1)).toMatchObject({ author: "agent", sessionId: "live" });
  });

  it("sends to the session the person has open and is looking at, even if another was active later", async () => {
    const { store, id } = await setup({ live: { agent: "claude", at: 90 }, watched: { agent: "codex", at: 10 } });
    openSessions.mount("watched");
    pointerFollow.set("watched");
    await handToSession(api, store, id);
    openSessions.unmount("watched");
    expect(bodies.map((b) => b.url)).toEqual(["/api/agent/dispatches"]);
  });

  it("with no live session the person is asked to choose, and the pick gets the comment", async () => {
    const { store, id } = await setup({ dead: { agent: "pi", at: 5, dead: true } });
    ui.chooseAgent = vi.fn(async () => (sessions.create("c1", "picked"), agents.hydrateBindings({ picked: binding("claude", 6) }), "picked")); // the chooser makes the session
    await handToSession(api, store, id);
    expect(ui.chooseAgent).toHaveBeenCalledOnce();
    expect(bodies.map((b) => b.url)).toEqual(["/api/agent/dispatches"]);
  });

  it("a failed send leaves a 换一个会话 action in the thread, not just a sentence", async () => {
    const { store, id } = await setup({ live: { agent: "claude", at: 10 } });
    failFor.add("live");
    await handToSession(api, store, id);
    const last = store.thread(id)!.messages.at(-1)!;
    expect(last).toMatchObject({ author: "system", tone: "error", action: "switch-session", sessionId: "live" });
    expect(last.text).toContain("没有交出去");
  });

  it("switching opens the chooser and sends the comment again to what was chosen", async () => {
    const { store, id } = await setup({ live: { agent: "claude", at: 10 } });
    failFor.add("live");
    await handToSession(api, store, id);
    sessions.create("c1", "picked");
    agents.hydrateBindings({ picked: binding("codex", 20) });
    ui.chooseAgent = vi.fn(async () => "picked");
    await handToSession(api, store, id, { choose: true });
    expect(ui.chooseAgent).toHaveBeenCalledOnce();
    expect(bodies.map((b) => b.body.to)).toEqual(["live", "picked"]);
    expect(bodies[1].body.task).toContain("把缓存换成 Redis");
    expect(store.thread(id)!.messages.at(-1)).toMatchObject({ author: "agent", sessionId: "picked" });
  });
});
