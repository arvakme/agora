import { describe, expect, it } from "vitest";
import type { Thread } from "../comments/threads";
import type { Session, Turn } from "../session/store";
import { foldSessions, participants, sessionRecords, threadsFromFile, threadsToFile, type SessionsState } from "./format";

const ann = { id: "mailto:ann@x", name: "Ann" };
const bob = { id: "mailto:bob@x", name: "Bob" };
const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1",
  n: 1,
  anchor: { ids: ["e1"], rel: { x: 1, y: 0 }, last: { x: 0, y: 0 } },
  resolved: false,
  agent: "running",
  createdAt: 1,
  createdBy: ann,
  messages: [
    { id: "m1", author: "you", text: "改成 Redis", at: 1, by: ann },
    { id: "m2", author: "agent", text: "好", at: 2, turnId: "tu1" },
    { id: "m3", author: "you", text: "同意", at: 3, by: bob },
  ],
  ...over,
});

describe("threads file", () => {
  it("stores human messages as author human + by, drops the transient agent state, lists participants", () => {
    const f = threadsToFile({ seq: 1, threads: [thread()] });
    expect(f.threads[0].messages.map((m) => m.author)).toEqual(["human", "agent", "human"]);
    expect(f.threads[0].participants).toEqual([ann, bob]);
    expect("agent" in f.threads[0]).toBe(false);
  });
  it("round-trips back to the in-memory shape (idle, author you)", () => {
    const back = threadsFromFile(JSON.parse(JSON.stringify(threadsToFile({ seq: 1, threads: [thread()] }))))!;
    expect(back.seq).toBe(1);
    expect(back.threads[0]).toEqual({ ...thread(), agent: "idle" });
  });
  it("participants ignore messages without a person", () => {
    expect(participants({ createdBy: undefined, messages: [{ id: "a", author: "agent", text: "", at: 0 }] })).toEqual([]);
  });
});

describe("session log", () => {
  const s: Session = { id: "s1", canvasId: "c1", createdAt: 1, turnIds: ["tu1"] };
  const turn = (status: Turn["status"], batchId?: string): Turn =>
    ({ id: "tu1", n: 1, sessionId: "s1", canvasId: "c1", origin: { kind: "chat" }, request: "x", refs: [], mentions: [], startedAt: 1, status, steps: [], ...(batchId && { reply: { text: "ok", batchId } }) }) as Turn;
  const state = (t: Turn): SessionsState => ({ sessions: { s1: s }, turns: { tu1: t }, batches: { b1: { before: [], after: [] } } });

  it("first sync writes header, turns and referenced batches; later syncs append only changes", () => {
    const a = sessionRecords(undefined, s, state(turn("running")));
    expect(a.records.map((r) => r.t)).toEqual(["session", "turn"]);
    expect(sessionRecords(a.next, s, state(turn("running"))).records).toEqual([]);
    const b = sessionRecords(a.next, s, state(turn("applied", "b1")));
    expect(b.records.map((r) => r.t)).toEqual(["turn", "batch"]);
    expect(sessionRecords(b.next, s, state(turn("applied", "b1"))).records).toEqual([]);
  });

  it("folds the server's per-session files into one state that counts as written", () => {
    const st = state(turn("applied", "b1"));
    const { state: folded, logged } = foldSessions({ s1: { state: { session: s, turns: st.turns, batches: st.batches } } });
    expect(folded).toEqual(st);
    expect(sessionRecords(logged.get("s1"), s, folded).records).toEqual([]);
  });
});
