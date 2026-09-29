// Comments handed to agents by @ (comments/mention.ts): the list, the routing of a message, the naming.
import { describe, expect, it } from "vitest";
import type { Binding, Status } from "../session/agents.ts";
import { agoText, applyMention, handoffLine, mentionOptions, mentionQuery, mentionRows, routeMessage, stillMentioned, threadSessionName, type MentionRow, type MentionSources, type MentionTarget } from "./mention.ts";

const NOW = 10_000_000;
const MIN = 60_000;
const agents = [{ kind: "claude", name: "Claude Code" }, { kind: "codex", name: "Codex" }, { kind: "pi", name: "Pi" }];
const b = (agent: string, createdAt = 1): Binding => ({ agent, model: "m", effort: "", nativeId: "n", createdAt });
const st = (over: Partial<Status> = {}): Status => ({ running: false, busy: false, queued: 0, held: null, activity: null, error: null, terminal: { alive: false, attach: "", clients: 0, app: null }, ...over });
const gone = st({ native: { state: "missing", blocking: true, nativeId: "n", candidates: [], message: "原生会话目录已不在" } });
const copy = st({ copy: { from: "x", fromInstance: "y", at: 1 } });

const src = (over: Partial<MentionSources> = {}): MentionSources => ({
  agents,
  bindings: { "s-main": b("claude"), "s-2": b("codex") },
  status: {},
  activeAt: {},
  names: { "s-main": "主对话", "s-2": "评论 #1 · 浏览器" },
  now: NOW,
  ...over,
});
const titles = (rows: MentionRow[]) => rows.map((r) => r.title);
const picks = (rows: MentionRow[]) => rows.filter((r): r is Extract<MentionRow, { target: MentionTarget }> => "target" in r);

describe("the @ list once something is typed: every agent and every conversation that can take a message", () => {
  it("offers the session agents first, then the conversations by name", () => {
    expect(mentionOptions(src(), "").map((o) => o.label)).toEqual(["Claude Code", "Codex", "Pi", "主对话", "评论 #1 · 浏览器"]);
  });
  it("filters both by what is typed after the @, in a name or an agent kind", () => {
    expect(mentionOptions(src(), "co").map((o) => o.label)).toEqual(["Claude Code", "Codex", "评论 #1 · 浏览器"]);
    expect(mentionOptions(src(), "主").map((o) => o.label)).toEqual(["主对话"]);
    expect(mentionOptions(src(), "zzz")).toEqual([]);
  });
  it("lists the more recent conversations first", () => {
    expect(mentionOptions(src({ activeAt: { "s-2": 9 } }), "").map((o) => o.label).slice(3)).toEqual(["评论 #1 · 浏览器", "主对话"]);
  });
  it("a conversation with nothing in it yet (activeAt 0) is as recent as it was created", () => {
    const s = src({ bindings: { old: b("pi", 5), fresh: b("pi", 9) }, names: { old: "old", fresh: "fresh" }, activeAt: { old: 0, fresh: 0 } });
    expect(mentionOptions(s, "").filter((o) => o.type === "session").map((o) => o.label)).toEqual(["fresh", "old"]);
  });
  it("never lists a conversation that cannot take a message: no process, a copy, its native directory gone", () => {
    const s = src({ bindings: { a: b("pi"), dead: b("pi"), cp: b("pi"), ok: b("pi") }, names: { a: "a", dead: "dead", cp: "cp", ok: "ok" }, status: { dead: gone, cp: copy } });
    expect(mentionOptions(s, "").filter((o) => o.type === "session").map((o) => o.label)).toEqual(["a", "ok"]);
    expect(mentionOptions(s, "dead")).toEqual([]);
    expect(mentionOptions(s, "cp")).toEqual([]);
  });
  it("still lists a conversation whose native log is gone while a live terminal holds it (sendable's own rule)", () => {
    const held = { ...gone, terminal: { alive: true, attach: "", clients: 0, app: "tmux" as const } };
    expect(mentionOptions(src({ status: { "s-main": held } }), "主").map((o) => o.label)).toEqual(["主对话"]);
  });
  it("names a conversation nobody named after its agent", () => {
    expect(mentionOptions(src({ names: {} }), "会话").map((o) => o.label)).toEqual(["Claude Code 会话", "Codex 会话"]);
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

describe("the @ list with nothing typed yet: at most four choices and 「更多」", () => {
  const many = {
    bindings: { old: b("pi"), a: b("claude"), c: b("codex"), d: b("claude"), e: b("pi"), other: b("codex") },
    names: { old: "旧的", a: "对话 A", c: "对话 C", d: "对话 D", e: "对话 E", other: "别的画布" },
    activeAt: { old: NOW - 90 * MIN, a: NOW - 5 * MIN, c: NOW - 2 * MIN, d: NOW - 30 * MIN, e: NOW - 60 * MIN, other: NOW - 1 * MIN },
    canvas: ["old", "a", "c", "d", "e"],
  };
  it("recommended new conversation, the two most recent conversations on this canvas, then 「更多」", () => {
    const rows = mentionRows(src(many), "", false);
    expect(titles(rows)).toEqual(["Codex · 新对话", "对话 C", "对话 A", "更多… 输入名字搜索"]);
    expect(picks(rows)[0]).toMatchObject({ badge: "推荐", target: { type: "agent", kind: "codex" } }); // c is the latest on this canvas
    expect(picks(rows).slice(1).map((r) => r.note)).toEqual(["2 分钟前", "5 分钟前"]);
    expect(picks(rows).slice(1).map((r) => r.target)).toEqual([{ type: "session", sid: "c", agent: "codex", label: "对话 C" }, { type: "session", sid: "a", agent: "claude", label: "对话 A" }]);
    expect("more" in rows[3]).toBe(true);
  });
  it("only one 推荐 row, and it is a new conversation", () => {
    const rows = picks(mentionRows(src(many), "", false));
    expect(rows.filter((r) => r.badge)).toHaveLength(1);
    expect(rows[0].target.type).toBe("agent");
  });
  it("a conversation on another canvas is not one of the two, however recent", () => {
    expect(titles(mentionRows(src(many), "", false))).not.toContain("别的画布");
  });
  it("a thread that is bound to a conversation starts with 「继续交给 …」", () => {
    const handoff = { sessionId: "d", agent: "claude", name: "对话 D" };
    const rows = mentionRows(src({ ...many, handoff }), "", false);
    expect(titles(rows)).toEqual(["继续交给 对话 D", "Codex · 新对话", "对话 C", "对话 A", "更多… 输入名字搜索"]);
    expect(picks(rows)[0].target).toEqual({ type: "session", sid: "d", agent: "claude", label: "对话 D" });
    expect(picks(rows)).toHaveLength(4); // four choices and 「更多」, never more
  });
  it("the bound conversation is not listed a second time among the recent ones", () => {
    const handoff = { sessionId: "c", agent: "codex", name: "对话 C" };
    const t = titles(mentionRows(src({ ...many, handoff }), "", false));
    expect(t).toEqual(["继续交给 对话 C", "Codex · 新对话", "对话 A", "对话 D", "更多… 输入名字搜索"]);
  });
  it("a bound conversation that can no longer take a message is not offered (nor is one that is gone)", () => {
    const handoff = { sessionId: "c", agent: "codex", name: "对话 C" };
    expect(titles(mentionRows(src({ ...many, handoff, status: { c: gone } }), "", false))).not.toContain("继续交给 对话 C");
    expect(titles(mentionRows(src({ ...many, handoff: { sessionId: "nope", agent: "pi", name: "没了" } }), "", false)).some((t) => t.startsWith("继续交给"))).toBe(false);
  });
  it("conversations that cannot take a message are never among the two", () => {
    const rows = mentionRows(src({ ...many, status: { c: gone, a: copy } }), "", false);
    expect(titles(rows)).toEqual(["Codex · 新对话", "对话 D", "对话 E", "更多… 输入名字搜索"]);
  });
  it("with no conversation on the canvas, only the recommended one and 「更多」", () => {
    expect(titles(mentionRows(src({ ...many, canvas: [] }), "", false))).toEqual(["Codex · 新对话", "更多… 输入名字搜索"]);
  });
  it("recommends the agent of the busiest conversation on this canvas, else the most used, else Claude Code", () => {
    expect(picks(mentionRows(src({ ...many, canvas: [] }), "", false))[0].target).toMatchObject({ kind: "codex" }); // claude ×2, pi ×2, codex ×2: a tie goes to the one that worked last
    expect(picks(mentionRows(src({ bindings: {}, names: {} }), "", false))[0].target).toMatchObject({ kind: "claude" });
  });
  it("「更多」expands to the whole list: every agent, then every conversation that can take a message", () => {
    const rows = mentionRows(src(many), "", true);
    expect(rows.every((r) => "target" in r)).toBe(true);
    expect(titles(rows)).toEqual(["Claude Code", "Codex", "Pi", "别的画布", "对话 C", "对话 A", "对话 D", "对话 E", "旧的"]);
  });
  it("typing something replaces the short list by the search, with no 「更多」", () => {
    const rows = mentionRows(src(many), "对话", false);
    expect(titles(rows)).toEqual(["对话 C", "对话 A", "对话 D", "对话 E"]);
  });
  it("says how long ago in minutes, hours, days", () => {
    expect(agoText(NOW - 10_000, NOW)).toBe("刚刚");
    expect(agoText(NOW - 5 * MIN, NOW)).toBe("5 分钟前");
    expect(agoText(NOW - 3 * 60 * MIN, NOW)).toBe("3 小时前");
    expect(agoText(NOW - 2 * 24 * 60 * MIN, NOW)).toBe("2 天前");
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
