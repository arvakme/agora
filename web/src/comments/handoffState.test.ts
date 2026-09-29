// 交给 Agent 的三处落差 (E1, C 验收第 7 步): the button says who gets the comment, the pin says the agent has
// answered (until the person closes the thread with ✓), and a hand-off that failed earlier does not sit beside
// the answer that came later. Pure functions; the messages below are thread #1 of the 圆桌 AI copy as it was.
import { describe, expect, it } from "vitest";
import { collapseSuperseded, handLabel, PIN_LABEL, pinState, type Folded } from "./handoffState.ts";
import type { Message } from "./threads.ts";

const you: Message = { id: "m1", author: "you", text: "这里的限流是按用户还是按 IP？看代码回答，一两句话", at: 1 };
const failed: Message = { id: "m2", author: "system", text: "没有选定 agent，评论没有交出去。", at: 2, tone: "warn", action: "switch-session" };
const errored: Message = { id: "m2b", author: "system", text: "Agent 没有完成：boom", at: 3, tone: "error", sessionId: "s1" };
const answer: Message = { id: "m3", author: "agent", text: "两种都有", at: 4, sessionId: "s1" };
const t = (o: { resolved?: boolean; agent?: "idle" | "running"; messages: Message[] }) => ({ resolved: false, agent: "idle" as const, ...o });

describe("pinState: what the pin says about the agent", () => {
  it("unanswered (nothing from an agent yet, also after a failed hand-off), running, answered, closed", () => {
    expect(pinState(t({ messages: [you] }))).toBe("pending");
    expect(pinState(t({ messages: [you, failed] }))).toBe("pending");
    expect(pinState(t({ agent: "running", messages: [you] }))).toBe("running");
    expect(pinState(t({ messages: [you, answer] }))).toBe("answered");
    expect(pinState(t({ resolved: true, messages: [you, answer] }))).toBe("resolved");
  });

  it("answered lasts until the person closes the thread: a person's follow-up makes it unanswered again, a new run makes it running, a deleted answer does not count", () => {
    expect(pinState(t({ messages: [you, answer, { ...you, id: "m4", at: 5 }] }))).toBe("pending");
    expect(pinState(t({ agent: "running", messages: [you, answer, { ...you, id: "m4", at: 5 }] }))).toBe("running");
    expect(pinState(t({ messages: [you, { ...answer, deleted: true, text: "" }] }))).toBe("pending");
    // a hand-off that ended in an error is not an answer
    expect(pinState(t({ messages: [you, errored] }))).toBe("pending");
  });

  it("the four states have four different words", () => {
    expect(new Set(Object.values(PIN_LABEL)).size).toBe(4);
    expect(PIN_LABEL.answered).toBe("已答复");
    expect(PIN_LABEL.pending).toBe("未答复");
    expect(PIN_LABEL.running).toBe("处理中");
  });
});

describe("handLabel: the 交给 … button", () => {
  it("names the agent the comment would go to", () => {
    expect(handLabel({ name: "Claude Code" })).toBe("交给 Claude Code");
  });
  it("with several sessions the session's name comes with it", () => {
    expect(handLabel({ name: "Claude Code", many: true, sessionName: "限流的问题" })).toBe("交给 Claude Code · 限流的问题");
    expect(handLabel({ name: "Codex", many: true })).toBe("交给 Codex");
  });
  it("no target: 交给 Agent… (the chooser opens); while it runs: 处理中", () => {
    expect(handLabel({})).toBe("交给 Agent…");
    expect(handLabel({ running: true, name: "Claude Code" })).toBe("处理中");
  });
});

describe("collapseSuperseded: an old failed hand-off next to the answer that came later", () => {
  it("the failure (no agent chosen, or the agent did not finish) folds into one grey line once an agent has answered", () => {
    const out = collapseSuperseded([you, failed, answer], () => "Claude Code");
    expect(out.map((m) => m.id)).toEqual(["m1", "folded-m2", "m3"]);
    expect((out[1] as Folded).text).toBe("之前未交出，已重新交给 Claude Code");
    expect(collapseSuperseded([you, failed, errored, answer]).length).toBe(3); // two failures, one line
    expect((collapseSuperseded([you, failed, errored, answer])[1] as Folded).text).toBe("之前未交出，已重新交给 Agent");
  });
  it("a failure with no answer after it stays as it is (it is the current state, with its 换一个会话 button); so does everything else", () => {
    expect(collapseSuperseded([you, failed])).toEqual([you, failed]);
    expect(collapseSuperseded([you, failed, { ...you, id: "m5", at: 9 }])).toEqual([you, failed, { ...you, id: "m5", at: 9 }]);
    expect(collapseSuperseded([you, answer])).toEqual([you, answer]);
  });
  it("the line names the agent that actually answered in the thread, not the one the comment would go to now", () => {
    const name = (sessionId?: string) => (sessionId === "s-codex" ? "Codex" : "Claude Code");
    const byCodex: Message = { ...answer, sessionId: "s-codex" };
    const out = collapseSuperseded([you, failed, byCodex], name);
    expect((out[1] as Folded).text).toBe("之前未交出，已重新交给 Codex");
    // several answers: the last one counts
    const byClaude: Message = { ...answer, id: "m8", at: 8, sessionId: "s-claude" };
    expect((collapseSuperseded([you, failed, byCodex, byClaude], name)[1] as Folded).text).toBe("之前未交出，已重新交给 Claude Code");
    // a deleted answer did not answer
    const gone: Message = { ...byClaude, deleted: true };
    expect((collapseSuperseded([you, failed, byCodex, gone], name)[1] as Folded).text).toBe("之前未交出，已重新交给 Codex");
  });
  it("only failures before the last answer fold; one after it stays", () => {
    const later: Message = { ...failed, id: "m9", at: 10 };
    const out = collapseSuperseded([you, failed, answer, later]);
    expect(out.map((m) => m.id)).toEqual(["m1", "folded-m2", "m3", "m9"]);
  });
});
