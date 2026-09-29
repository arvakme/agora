// Comments handed to agents by @ (comments/mention.ts): the list, the routing of a message, the naming.
import { describe, expect, it } from "vitest";
import { applyMention, handoffLine, mentionOptions, mentionQuery, routeMessage, stillMentioned, threadSessionName, type MentionTarget } from "./mention.ts";

const agents = [{ kind: "claude", name: "Claude Code" }, { kind: "codex", name: "Codex" }, { kind: "pi", name: "Pi" }];
const sessions = [{ sid: "s-main", agent: "claude", name: "主对话" }, { sid: "s-2", agent: "codex", name: "评论 #1 · 浏览器" }];

describe("the @ list", () => {
  it("offers the session agents first, then the existing conversations by name", () => {
    expect(mentionOptions({ agents, sessions }, "").map((o) => o.label)).toEqual(["Claude Code", "Codex", "Pi", "主对话", "评论 #1 · 浏览器"]);
  });
  it("filters both by what is typed after the @, in a name or an agent kind", () => {
    expect(mentionOptions({ agents, sessions }, "co").map((o) => o.label)).toEqual(["Claude Code", "Codex", "评论 #1 · 浏览器"]);
    expect(mentionOptions({ agents, sessions }, "主").map((o) => o.label)).toEqual(["主对话"]);
    expect(mentionOptions({ agents, sessions }, "zzz")).toEqual([]);
  });
  it("only opens for an @ at the start of a word, at the caret", () => {
    expect(mentionQuery("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionQuery("请 @cl", 5)).toEqual({ start: 2, end: 5, query: "cl" });
    expect(mentionQuery("a@b", 3)).toBeNull(); // an e-mail address is not a mention
    expect(mentionQuery("@claude 好", 9)).toBeNull(); // the word is finished
    expect(mentionQuery("@claude 好", 3)).toEqual({ start: 0, end: 3, query: "cl" }); // the caret is inside it
  });
  it("puts the picked name where the @word was", () => {
    const pick: MentionTarget = { type: "agent", kind: "claude", label: "Claude Code" };
    expect(applyMention("请 @cl 加个节点", { start: 2, end: 5, query: "cl" }, pick)).toEqual({ text: "请 @Claude Code  加个节点", caret: 15 });
  });
  it("forgets a pick whose @name was deleted from the text", () => {
    const pick: MentionTarget = { type: "agent", kind: "claude", label: "Claude Code" };
    expect(stillMentioned("@Claude Code 加节点", pick)).toBe(pick);
    expect(stillMentioned("加节点", pick)).toBeNull();
  });
});

describe("where a message goes", () => {
  const claude: MentionTarget = { type: "agent", kind: "claude", label: "Claude Code" };
  const main: MentionTarget = { type: "session", sid: "s-main", agent: "claude", label: "主对话" };
  const bound = { sessionId: "s-9", agent: "codex", name: "评论 #1 · 浏览器" };

  it("without an @ and without a hand-off it is an ordinary comment", () => {
    expect(routeMessage({ guest: false, mention: null, handoff: undefined })).toEqual({ kind: "plain" });
    expect(routeMessage({ guest: false, mention: null, handoff: null })).toEqual({ kind: "plain" });
  });
  it("mentioning an agent opens a new conversation for the thread; mentioning a conversation hands it there", () => {
    expect(routeMessage({ guest: false, mention: claude, handoff: undefined })).toEqual({ kind: "hand", to: { agent: "claude" }, bound: false });
    expect(routeMessage({ guest: false, mention: main, handoff: undefined })).toEqual({ kind: "hand", to: { sid: "s-main" }, bound: false });
  });
  it("in a bound thread a reply without an @ goes to the bound conversation", () => {
    expect(routeMessage({ guest: false, mention: null, handoff: bound })).toEqual({ kind: "hand", to: { sid: "s-9" }, bound: true });
  });
  it("an @ in a bound thread wins over the binding (it hands the thread somewhere else)", () => {
    expect(routeMessage({ guest: false, mention: main, handoff: bound })).toEqual({ kind: "hand", to: { sid: "s-main" }, bound: false });
  });
  it("a guest can never reach an agent, mentioned or bound", () => {
    expect(routeMessage({ guest: true, mention: claude, handoff: bound })).toEqual({ kind: "plain" });
  });
});

describe("naming", () => {
  it("names the thread's conversation after the comment number and the node", () => {
    expect(threadSessionName(2, "文件与解析")).toBe("评论 #2 · 文件与解析");
    expect(threadSessionName(3, "")).toBe("评论 #3 · 画布");
  });
  it("says who has the thread and how far it is", () => {
    const h = { sessionId: "s", agent: "claude", name: "评论 #1 · 浏览器" };
    expect(handoffLine(h, "Claude Code", "running", false)).toBe("由 Claude Code · 评论 #1 · 浏览器 处理中");
    expect(handoffLine(h, "Claude Code", "answered", false)).toBe("由 Claude Code · 评论 #1 · 浏览器 已答复");
    expect(handoffLine(h, "Claude Code", "pending", false)).toBe("由 Claude Code · 评论 #1 · 浏览器 已交接");
    expect(handoffLine(h, "Claude Code", "pending", true)).toContain("已不在了");
  });
});
