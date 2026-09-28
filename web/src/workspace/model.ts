// Workspace model (see web/docs/workspace-model.md): which canvases and sessions exist,
// which are open as tabs, and the naming / placement rules. Pure functions only.
import { activate, addTab, group, groupOf, groups, removeTab, type Group, type Node } from "./layout.ts";

/** `reviewedAt`: a child canvas the person checked against the code at that time (docs/nested-canvas.md §5). */
export type CanvasDoc = { id: string; kind: "canvas"; title: string; reviewedAt?: number };
/**
 * A session's `title` is the name the person gave it ("" = automatic: agent name + topic, see
 * sessionTitles). `topic` is taken once from its first message (topicOf).
 */
export type SessionDoc = { id: string; kind: "session"; sessionId: string; title: string; topic?: string };
/** Everything that exists in the workspace, open or closed. Open = has a tab in the layout tree. */
export type Doc = CanvasDoc | SessionDoc;
export type DocKind = Doc["kind"];
export type GroupKind = DocKind | "mixed";

export const UNTITLED_CANVAS = "未命名画布";
export const SAMPLE_CANVAS = "示例架构图";
export const SESSION = "会话";
/** A session with no agent chosen yet: a draft, kept in memory until the agent is picked. */
export const DRAFT_SESSION = "新会话";
/** Names older builds gave every session ("会话 3"); they count as automatic, not as the person's choice. */
const LEGACY_SESSION = /^会话 \d+$/;

/**
 * Smallest free "base N" among the given titles (N starts at 1), so closing or deleting
 * "未命名画布 2" frees that name again. With `bareFirst`, the first one is just "base".
 */
export function nextTitle(titles: string[], base: string, bareFirst = false): string {
  const taken = new Set(titles);
  if (bareFirst && !taken.has(base)) return base;
  for (let n = bareFirst ? 2 : 1; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

export const titlesOf = (docs: Doc[], kind: DocKind) => docs.filter((d) => d.kind === kind).map((d) => d.title);

/** Session docs have a stable id derived from the session, so any path that creates a session maps to one doc. */
export const sessionDocId = (sessionId: string) => `p-${sessionId}`;

export const emptyGroup = (): Group => group([], "");
export const openIds = (root: Node) => groups(root).flatMap((g) => g.tabs);
export const isOpen = (root: Node, id: string) => !!groupOf(root, id);

/** A group's kind comes from its tabs: all canvases, all sessions, or mixed (also when empty). */
export function groupKind(tabs: string[], kindOf: (id: string) => DocKind | undefined): GroupKind {
  const kinds = new Set(tabs.map(kindOf));
  return kinds.size === 1 ? ([...kinds][0] ?? "mixed") : "mixed";
}

/** Close = take the tab out of the layout. The last tab of the only group leaves an empty group. */
export const closeTab = (root: Node, id: string): Node => (isOpen(root, id) ? (removeTab(root, id) ?? emptyGroup()) : root);

/** Where a doc's tab sits, so an undone delete can put it back. */
export function placement(root: Node, id: string): { groupId: string; index: number } | null {
  const g = groupOf(root, id);
  return g ? { groupId: g.id, index: g.tabs.indexOf(id) } : null;
}

/** Show a tab: activate it where it is, or add it to `groupId` (falling back to the first group). */
export function openTab(root: Node, id: string, groupId?: string, index?: number): Node {
  const at = groupOf(root, id);
  if (at) return activate(root, at.id, id);
  const all = groups(root);
  const target = all.find((g) => g.id === groupId) ?? all[0];
  return addTab(root, target.id, id, index === undefined ? undefined : Math.min(index, target.tabs.length));
}

/**
 * Show `to` where `from` is (same group, same place): entering a child canvas or going back up
 * keeps the tab where it was. `from` is closed (still exists); if `to` is already open elsewhere
 * it is just brought forward and `from` stays.
 */
export function replaceTab(root: Node, from: string, to: string): { root: Node; closed: boolean } {
  if (from === to) return { root, closed: false };
  const there = groupOf(root, to);
  if (there) return { root: activate(root, there.id, to), closed: false };
  const g = groupOf(root, from);
  if (!g) return { root: openTab(root, to), closed: false };
  return { root: closeTab(openTab(root, to, g.id, g.tabs.indexOf(from)), from), closed: true };
}

/**
 * Canvases in tree order for 所有画布: each child right under its parent, with its depth.
 * `parentOf` gives a canvas's parent canvas (nested canvases); loops are cut.
 */
export function canvasTree(ids: string[], parentOf: (id: string) => string | undefined): { id: string; depth: number }[] {
  const known = new Set(ids);
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of ids) {
    const p = parentOf(id);
    if (p && known.has(p) && p !== id) kids.set(p, [...(kids.get(p) ?? []), id]);
    else roots.push(id);
  }
  const out: { id: string; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, depth });
    for (const k of kids.get(id) ?? []) walk(k, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  for (const id of ids) walk(id, 0); // a loop has no root: list what is left at the top
  return out;
}

/**
 * The group a doc opens into when no group is named:
 * a canvas joins the group of the most recent open canvas (or any canvas group);
 * a session goes beside its canvas (a group without it, preferring one that holds sessions);
 * when the canvas's group is the only one, the session splits off to its right (`split`).
 */
export function homeGroup(
  root: Node,
  kind: DocKind,
  ctx: { kindOf: (id: string) => DocKind | undefined; recentCanvas?: string; linkedCanvas?: string; focused?: string },
): { groupId: string; split: boolean } {
  const all = groups(root);
  const fallback = ((ctx.focused ? groupOf(root, ctx.focused) : undefined) ?? all[0]).id;
  const hasKind = (g: Group, k: DocKind) => g.tabs.some((t) => ctx.kindOf(t) === k);
  if (kind === "canvas") {
    const recent = ctx.recentCanvas ? groupOf(root, ctx.recentCanvas) : undefined;
    return { groupId: (recent ?? all.find((g) => hasKind(g, "canvas")))?.id ?? fallback, split: false };
  }
  const home = ctx.linkedCanvas ? groupOf(root, ctx.linkedCanvas) : undefined;
  const away = all.filter((g) => g !== home);
  const pick = away.find((g) => hasKind(g, "session")) ?? away[0];
  if (pick) return { groupId: pick.id, split: false };
  // Only the canvas's own group is left: split beside it, unless it is empty or holds nothing else useful.
  return home && home.tabs.length ? { groupId: home.id, split: true } : { groupId: fallback, split: false };
}

/**
 * Saved session docs from older builds: no title (v1) or a numbered "会话 N" become automatic
 * names (title ""). Only the doc's name changes; the session and its records are untouched.
 */
export function migrateDocs(docs: (Doc | { id: string; kind: "session"; sessionId: string; title?: string })[]): Doc[] {
  return docs.map((d) => (d.kind === "session" && (!d.title || LEGACY_SESSION.test(d.title)) ? { ...d, title: "" } : (d as Doc)));
}

/** Whether the person named this session (an automatic name follows the agent and topic). */
export const isNamed = (d: SessionDoc) => !!d.title && !LEGACY_SESSION.test(d.title);

/**
 * Display names for session docs, in workspace order: the person's name if they gave one,
 * else "<agent>" / "<agent> · <topic>", or "新会话" while no agent is chosen. Automatic names
 * that collide get a suffix ("Claude Code · 加 Kafka 2"); there is no global counter.
 */
export function sessionTitles(docs: Doc[], info: (sessionId: string) => { agent?: string } | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const sessionDocs = docs.filter((d): d is SessionDoc => d.kind === "session");
  const taken = sessionDocs.filter(isNamed).map((d) => d.title);
  for (const d of sessionDocs) {
    if (isNamed(d)) {
      out[d.id] = d.title;
      continue;
    }
    const agent = info(d.sessionId)?.agent;
    const base = agent ? (d.topic ? `${agent} · ${d.topic}` : agent) : DRAFT_SESSION;
    out[d.id] = nextTitle(taken, base, true);
    taken.push(out[d.id]);
  }
  return out;
}

/** Display width: CJK and full-width characters count 2, everything else 1. */
const cols = (ch: string) => (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1);

/**
 * A short topic from a session's first message, without calling a model:
 * 1. drop what Agora appends (the `[[agora]]` footer, the "（引用的画布元素…）/（当前选区…）" note);
 *    a comment hand-off ("画布评论 #n（…）：") uses its first comment's text;
 * 2. take the first non-empty line, drop Markdown markers and polite openers (请 / 帮我 / 麻烦 /
 *    能不能 / 可以 / please / can you …) and trailing punctuation;
 * 3. keep 18 columns (a CJK character is 2), adding "…" when cut. Empty → no topic.
 */
export function topicOf(text: string | undefined, maxCols = 18): string {
  if (!text) return "";
  let t = text.split("[[agora]]")[0];
  t = t.replace(/\n*（(引用的画布元素|当前选区)[^）]*）\s*$/u, "");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  let line = lines[0];
  if (/^画布评论 #\d+/.test(line)) line = (lines.find((l) => /^- [^：]+：/.test(l)) ?? "").replace(/^- [^：]+：/, "");
  line = line.replace(/^([#>*\-]+|\d+[.)、])\s*/, "");
  for (let prev = ""; prev !== line; ) {
    prev = line;
    line = line.replace(/^(请你?|麻烦你?|帮我|帮忙|能不能|能否|可以|可不可以|我想|我们|please|can you|could you)[\s,，]*/iu, "");
  }
  line = line.replace(/\s+/g, " ").replace(/[\s。．.！!？?，,；;：:、~～]+$/u, "").trim();
  let out = "";
  let w = 0;
  for (const ch of line) {
    if (w + cols(ch) > maxCols) return `${out.trimEnd()}…`;
    out += ch;
    w += cols(ch);
  }
  return out;
}

/**
 * What workspace.json holds: every doc except draft sessions (no agent chosen yet, created on
 * this page). Their tabs are left out of the saved layout too; nothing else is dropped.
 */
export function savedWorkspace(ws: { docs: Doc[]; root: Node; focused: string }, isDraft: (sessionId: string) => boolean): { v: 2; docs: Doc[]; root: Node; focused: string } {
  const drafts = ws.docs.filter((d) => d.kind === "session" && isDraft(d.sessionId)).map((d) => d.id);
  if (!drafts.length) return { v: 2, ...ws };
  let root: Node = ws.root;
  for (const id of drafts) if (groupOf(root, id)) root = removeTab(root, id) ?? emptyGroup();
  const focused = drafts.includes(ws.focused) ? (groups(root).find((g) => g.active)?.active ?? "") : ws.focused;
  return { v: 2, docs: ws.docs.filter((d) => !drafts.includes(d.id)), root, focused };
}
