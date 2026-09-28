// Workspace model rules: naming without gaps, close vs. open, group kinds and placement.
import { describe, expect, it } from "vitest";
import { group, groups, moveTab, type Node } from "./layout.ts";
import { closeTab, groupKind, homeGroup, isNamed, listGroups, migrateDocs, nextTitle, openIds, openTab, placement, savedWorkspace, sessionTitles, topicOf, UNTITLED_CANVAS, type Doc, type SessionDoc } from "./model.ts";

const kinds: Record<string, "canvas" | "session"> = { c1: "canvas", c2: "canvas", c3: "canvas", p1: "session", p2: "session" };
const kindOf = (id: string) => kinds[id];

describe("nextTitle", () => {
  it("takes the smallest free number, so closed or deleted numbers are reused", () => {
    expect(nextTitle([], UNTITLED_CANVAS)).toBe("未命名画布 1");
    expect(nextTitle(["未命名画布 1", "未命名画布 3"], UNTITLED_CANVAS)).toBe("未命名画布 2");
    expect(nextTitle(["未命名画布 1", "改过名的", "未命名画布 2"], UNTITLED_CANVAS)).toBe("未命名画布 3");
  });
  it("counts each kind on its own", () => {
    expect(nextTitle(["未命名画布 1", "未命名画布 2"], "会话")).toBe("会话 1");
  });
  it("leaves the first one bare when asked", () => {
    expect(nextTitle([], "示例架构图", true)).toBe("示例架构图");
    expect(nextTitle(["示例架构图"], "示例架构图", true)).toBe("示例架构图 2");
  });
});

describe("close and reopen", () => {
  it("closing a tab keeps the rest of the layout; the last tab leaves an empty group", () => {
    let root: Node = group(["c1", "p1"]);
    root = closeTab(root, "p1");
    expect(openIds(root)).toEqual(["c1"]);
    root = closeTab(root, "c1");
    expect(root.kind).toBe("group");
    expect(openIds(root)).toEqual([]);
  });
  it("closing the last tab of one group removes that group", () => {
    const g = group(["c1", "p1"]);
    let root = moveTab(g, "p1", g.id, "right");
    expect(groups(root)).toHaveLength(2);
    root = closeTab(root, "p1");
    expect(groups(root)).toHaveLength(1);
  });
  it("reopening puts the tab back where it was, or activates it if already open", () => {
    const g = group(["c1", "c2", "c3"]);
    const at = placement(g, "c2")!;
    const closed = closeTab(g, "c2");
    const back = openTab(closed, "c2", at.groupId, at.index) as typeof g;
    expect(back.tabs).toEqual(["c1", "c2", "c3"]);
    expect(back.active).toBe("c2");
    expect((openTab(back, "c1") as typeof g).active).toBe("c1");
  });
  it("opens into an empty group", () => {
    const root = openTab(closeTab(group(["c1"]), "c1"), "c2");
    expect(openIds(root)).toEqual(["c2"]);
  });
});

describe("group kind and placement", () => {
  it("derives the kind from the tabs", () => {
    expect(groupKind(["c1", "c2"], kindOf)).toBe("canvas");
    expect(groupKind(["p1"], kindOf)).toBe("session");
    expect(groupKind(["c1", "p1"], kindOf)).toBe("mixed");
    expect(groupKind([], kindOf)).toBe("mixed");
  });
  it("new canvases join the recent canvas's group; sessions go beside their canvas", () => {
    const g = group(["c1", "p1"]);
    const root = moveTab(g, "p1", g.id, "right");
    const [left, right] = groups(root);
    expect(homeGroup(root, "canvas", { kindOf, recentCanvas: "c1", focused: "p1" })).toEqual({ groupId: left.id, split: false });
    expect(homeGroup(root, "session", { kindOf, linkedCanvas: "c1", focused: "c1" })).toEqual({ groupId: right.id, split: false });
  });
  it("splits a session off when its canvas's group is the only one", () => {
    const root = group(["c1"]);
    expect(homeGroup(root, "session", { kindOf, linkedCanvas: "c1" })).toEqual({ groupId: root.id, split: true });
  });
});

describe("migrateDocs", () => {
  it("turns untitled and numbered 会话 N session names into automatic names, keeping everything else", () => {
    const docs = migrateDocs([
      { id: "c1", kind: "canvas", title: "架构图 1" },
      { id: "p1", kind: "session", sessionId: "s-a" },
      { id: "p2", kind: "session", sessionId: "s-b", title: "会话 5" },
      { id: "p3", kind: "session", sessionId: "s-c", title: "缓存讨论" },
    ]);
    expect(docs.map((d) => d.title)).toEqual(["架构图 1", "", "", "缓存讨论"]);
    expect(docs.map((d) => d.id)).toEqual(["c1", "p1", "p2", "p3"]); // nothing dropped
  });
});

describe("session names", () => {
  const s = (id: string, extra: Partial<SessionDoc> = {}): SessionDoc => ({ id: `p-${id}`, kind: "session", sessionId: id, title: "", ...extra });
  const agentOf: Record<string, string> = { a: "Claude Code", b: "Claude Code", c: "Pi", d: "Claude Code" };
  it("uses the agent name and topic, 新会话 for a draft, and the person's own name when given", () => {
    const docs: Doc[] = [{ id: "c1", kind: "canvas", title: "架构图" }, s("a", { topic: "加 Kafka" }), s("c"), s("x"), s("d", { title: "缓存讨论" })];
    expect(sessionTitles(docs, (id) => ({ agent: agentOf[id] }))).toEqual({ "p-a": "Claude Code · 加 Kafka", "p-c": "Pi", "p-x": "新会话", "p-d": "缓存讨论" });
  });
  it("adds a suffix only to names that collide, never a global number", () => {
    const docs: Doc[] = [s("a", { topic: "加 Kafka" }), s("b", { topic: "加 Kafka" }), s("x"), s("y"), s("c")];
    expect(Object.values(sessionTitles(docs, (id) => ({ agent: agentOf[id] })))).toEqual(["Claude Code · 加 Kafka", "Claude Code · 加 Kafka 2", "新会话", "新会话 2", "Pi"]);
    expect(isNamed(s("a", { title: "会话 3" }))).toBe(false);
  });
});

describe("topicOf", () => {
  it("takes the first line, without polite openers, Agora's notes or trailing punctuation", () => {
    expect(topicOf("帮我加 Kafka。")).toBe("加 Kafka");
    expect(topicOf("请把 Redis 换成集群\n细节：……")).toBe("把 Redis 换成集群");
    expect(topicOf("加一个消息队列\n\n（引用的画布元素：Redis（redis））")).toBe("加一个消息队列");
    expect(topicOf("讨论一下\n[[agora]] 来自 Agora · 画布「x」")).toBe("讨论一下");
    expect(topicOf("## Can you draw the auth flow?")).toBe("draw the auth flow");
    expect(topicOf("")).toBe("");
  });
  it("cuts at 18 columns, a CJK character counting 2", () => {
    expect(topicOf("把网关、鉴权和限流拆成三个独立服务")).toBe("把网关、鉴权和限流…");
  });
  it("uses the first comment of a hand-off", () => {
    expect(topicOf("画布评论 #3（锚点：Redis（redis））：\n- 小马：这里要加缓存吗？\n\n请按这条评论处理画布")).toBe("这里要加缓存吗");
  });
});

describe("savedWorkspace", () => {
  it("leaves draft sessions and their tabs out of what is saved, and nothing else", () => {
    const g = group(["c1", "p-a", "p-x"], "p-x");
    const docs: Doc[] = [{ id: "c1", kind: "canvas", title: "架构图" }, { id: "p-a", kind: "session", sessionId: "a", title: "" }, { id: "p-x", kind: "session", sessionId: "x", title: "" }];
    const saved = savedWorkspace({ docs, root: g, focused: "p-x" }, (sid) => sid === "x");
    expect(saved.docs.map((d) => d.id)).toEqual(["c1", "p-a"]);
    expect(openIds(saved.root)).toEqual(["c1", "p-a"]);
    expect(saved.focused).not.toBe("p-x");
    // no drafts: saved as is
    expect(savedWorkspace({ docs, root: g, focused: "c1" }, () => false)).toEqual({ v: 2, docs, root: g, focused: "c1" });
  });
});

// Phase 1: a session's identity is committed with workspace.json (no conversation content), so a
// fresh clone knows which agent it was and which canvas it belongs to.
describe("savedWorkspace session identity", () => {
  it("fills each session entry with its canvas and binding, leaves canvases and unknown fields alone", () => {
    const docs: Doc[] = [
      { id: "c1", kind: "canvas", title: "A" },
      { id: "p-s1", kind: "session", sessionId: "s1", title: "", topic: "加 Kafka" },
      { id: "p-s2", kind: "session", sessionId: "s2", title: "", canvasId: "c1", agent: "pi" },
    ];
    const meta = (sid: string) => (sid === "s1" ? { canvasId: "c1", agent: "claude" as const, model: "haiku", effort: "", nativeId: "n-1", createdAt: 5, started: true } : undefined);
    const out = savedWorkspace({ docs, root: group(["c1"]), focused: "c1" }, () => false, meta);
    expect(out.docs[0]).toEqual({ id: "c1", kind: "canvas", title: "A" });
    expect(out.docs[1]).toEqual({ id: "p-s1", kind: "session", sessionId: "s1", title: "", topic: "加 Kafka", canvasId: "c1", agent: "claude", model: "haiku", nativeId: "n-1", createdAt: 5, started: true });
    expect(out.docs[2]).toEqual(docs[2]); // nothing known here now: kept as saved
  });
});

describe("listGroups (所有画布)", () => {
  it("sessions of a trashed canvas wait under their own heading; truly unlinked ones apart", () => {
    const docs: Doc[] = [
      { id: "c1", kind: "canvas", title: "A" },
      { id: "p-a", kind: "session", sessionId: "a", title: "" },
      { id: "p-b", kind: "session", sessionId: "b", title: "" },
      { id: "p-c", kind: "session", sessionId: "c", title: "" },
    ];
    const canvasOf = (d: SessionDoc) => ({ a: "c1", b: "c2", c: "" })[d.sessionId as "a" | "b" | "c"];
    const g = listGroups(docs, canvasOf, new Set(["c2"]));
    expect(g.canvases.map((x) => [x.canvas.id, x.sessions.map((s) => s.sessionId)])).toEqual([["c1", ["a"]]]);
    expect(g.waiting.map((s) => s.sessionId)).toEqual(["b"]);
    expect(g.unlinked.map((s) => s.sessionId)).toEqual(["c"]);
    // c2 restored (same id): b is back under it
    const back = listGroups([...docs, { id: "c2", kind: "canvas", title: "B" }], canvasOf, new Set());
    expect(back.canvases.find((x) => x.canvas.id === "c2")!.sessions.map((s) => s.sessionId)).toEqual(["b"]);
    expect(back.waiting).toEqual([]);
  });
});

