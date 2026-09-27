// Workspace model (see web/docs/workspace-model.md): which canvases and sessions exist,
// which are open as tabs, and the naming / placement rules. Pure functions only.
import { activate, addTab, group, groupOf, groups, removeTab, type Group, type Node } from "./layout.ts";

export type CanvasDoc = { id: string; kind: "canvas"; title: string };
export type SessionDoc = { id: string; kind: "session"; sessionId: string; title: string };
/** Everything that exists in the workspace, open or closed. Open = has a tab in the layout tree. */
export type Doc = CanvasDoc | SessionDoc;
export type DocKind = Doc["kind"];
export type GroupKind = DocKind | "mixed";

export const UNTITLED_CANVAS = "未命名画布";
export const SAMPLE_CANVAS = "示例架构图";
export const SESSION = "会话";

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

/** Old saved workspaces (v1) had untitled session docs and a shared counter; give sessions their own names. */
export function migrateDocs(docs: (Doc | { id: string; kind: "session"; sessionId: string; title?: string })[]): Doc[] {
  const out: Doc[] = [];
  for (const d of docs) {
    if (d.kind === "session" && !d.title) out.push({ ...d, title: nextTitle(titlesOf(out, "session"), SESSION) });
    else out.push(d as Doc);
  }
  return out;
}
