// 对小人说话: what the box says after Enter, and when the figure nods (workstation/talk.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, handleEvent, type Binding } from "../session/agents.ts";
import { deliveryNote, sendState, talk, watchDelivery } from "./talk.ts";

const binding = (agent: Binding["agent"]): Binding => ({ agent, model: "m", effort: "", nativeId: "n", createdAt: 1 });
const idle = { running: false, busy: false, queued: 0, held: null, activity: null, error: null, terminal: { alive: false, attach: "", clients: 0, app: null } };
const seed = (sid: string, over: Partial<typeof idle> = {}) => handleEvent({ t: "status", sessionId: sid, binding: binding("claude"), ...idle, ...over });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  agents.forget("s1");
});

describe("sendState: is it queued behind a running turn?", () => {
  it("queued while a turn runs, is busy, or others already wait", async () => {
    await seed("s1", { running: true });
    expect(sendState("s1")).toBe("queued");
    await seed("s1", { busy: true });
    expect(sendState("s1")).toBe("queued");
    await seed("s1", { queued: 2 });
    expect(sendState("s1")).toBe("queued");
  });
  it("sent when the agent is idle, or nothing is known yet", async () => {
    await seed("s1");
    expect(sendState("s1")).toBe("sent");
    expect(sendState("unknown-session")).toBe("sent");
  });
});

describe("deliveryNote: the words under the box", () => {
  it("names the agent, and says when it will arrive", () => {
    expect(deliveryNote("Claude Code", "sent")).toBe("已发给 Claude Code");
    expect(deliveryNote("Claude Code", "queued")).toBe("已发给 Claude Code · 会在这一轮结束后送达");
    expect(deliveryNote("Claude Code", "delivered")).toBe("已发给 Claude Code · 已送达");
  });
});

describe("watchDelivery: the nod waits for the message to show up in the session", () => {
  it("calls back once a user item with those words appears after the send, and not before", async () => {
    await seed("s1", { running: true });
    const done = vi.fn();
    const off = watchDelivery("s1", "把它挪到左边", 1000, done);
    await handleEvent({ t: "transcript", sessionId: "s1", items: [{ id: "old", kind: "user", text: "把它挪到左边", at: 900 }] }); // an older, identical message
    await handleEvent({ t: "transcript", sessionId: "s1", items: [{ id: "a1", kind: "assistant", text: "好", at: 1100 }] });
    expect(done).not.toHaveBeenCalled();
    await handleEvent({ t: "transcript", sessionId: "s1", items: [{ id: "u9", kind: "user", text: "画布评论之外：把它挪到左边", at: 1500, source: "agora" }] });
    expect(done).toHaveBeenCalledOnce();
    await handleEvent({ t: "transcript", sessionId: "s1", items: [{ id: "u10", kind: "user", text: "把它挪到左边", at: 1600 }] });
    expect(done).toHaveBeenCalledOnce(); // once
    off();
  });

  it("finds a message that is already there, and stops watching when told", async () => {
    await handleEvent({ t: "transcript", sessionId: "s1", items: [{ id: "u1", kind: "user", text: "现在就到", at: 2000 }] });
    const now = vi.fn();
    watchDelivery("s1", "现在就到", 1000, now);
    expect(now).toHaveBeenCalledOnce();
    const never = vi.fn();
    const off = watchDelivery("s1", "不会到", 1000, never);
    off();
    await handleEvent({ t: "transcript", sessionId: "s1", items: [{ id: "u2", kind: "user", text: "不会到", at: 3000 }] });
    expect(never).not.toHaveBeenCalled();
  });
});

describe("talk.said: the nod", () => {
  it("records who nods and when", () => {
    talk.said("r1");
    expect(talk.get()).toMatchObject({ runId: "r1" });
  });
});
