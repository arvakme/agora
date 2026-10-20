// Handing a comment to an agent is done by @-mentioning it in the comment box (web/docs/workstation.md §12):
// no @ and no hand-off bound = an ordinary comment. Everything here is pure; the UI (MentionField.tsx) and the
// hand-off (ops/agent.ts) use it.
import { sendable } from "../session/pickSession";
import { lastActive, recommendAgent } from "../session/recommend";
import type { Binding, Status } from "../session/agents";
import type { Thread } from "./threads";
import { tr, lang } from "../i18n";

/** Who an @ names: a kind of agent (a new conversation for this thread) or an existing conversation. */
export type MentionTarget =
  | { type: "agent"; kind: string; label: string }
  | { type: "session"; sid: string; agent: string; label: string };

export type MentionQuery = { start: number; end: number; query: string };

/** The `@word` being typed right before the caret (at the start of the text or after whitespace), if any. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, end: caret, query: m[2] } : null;
}

/** What the @ list is drawn from: the agents, every conversation, and where the person is. */
export type MentionSources = {
  agents: { kind: string; name: string }[];
  bindings: Record<string, Binding>;
  status: Record<string, Status | undefined>;
  activeAt: Record<string, number>;
  names: Record<string, string>;
  /** What was said first in a conversation (a short line): tells apart conversations that carry the same name. */
  topics?: Record<string, string>;
  /** The conversations on this canvas; unknown = all of them. */
  canvas?: readonly string[];
  /** The conversation this thread is bound to. */
  handoff?: Thread["handoff"];
  now: number;
};

/** Which half of the list a choice is in: carrying on with a conversation that exists, or starting a new one (an @agent). */
export type MentionGroup = "continue" | "new";
export const GROUP_TITLES: Record<MentionGroup, string> = { continue: tr("继续已有会话", "Continue a session"), new: tr("新开一个", "Start a new one") };

/** One line of the list: a choice (`running`: that conversation is at work), or 「更多」 that opens the whole list. */
export type MentionRow = { target: MentionTarget; title: string; note: string; group: MentionGroup; badge?: string; running?: boolean } | { more: true; title: string };

const RECENT = 2;
export const MORE_TITLE = tr("更多… 输入名字搜索", "More… type a name to search");
export const RECOMMENDED = tr("推荐", "Recommended");

/** "刚刚" / "N 分钟前" / "N 小时前" / "N 天前". */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return tr("刚刚", "just now");
  if (s < 3600) return tr(`${Math.round(s / 60)} 分钟前`, `${Math.round(s / 60)}m ago`);
  if (s < 86400) return tr(`${Math.round(s / 3600)} 小时前`, `${Math.round(s / 3600)}h ago`);
  return tr(`${Math.round(s / 86400)} 天前`, `${Math.round(s / 86400)}d ago`);
}

/**
 * What each conversation is called in the list and in the text (`@label`). A conversation nobody named is called after its agent,
 * so several look the same, and one can look like the agent itself: those get the first thing said in them, else how long ago
 * (and a short id if even that is the same). Every label is unique, so the @name in a comment says which one was meant.
 */
function labels(o: MentionSources): Map<string, string> {
  const live = Object.keys(o.bindings).filter((sid) => sendable(o.bindings[sid], o.status[sid]));
  const at = (sid: string) => lastActive(o.bindings[sid], o.activeAt[sid]);
  const base = (sid: string) => o.names[sid] || tr(`${nameOf(o, o.bindings[sid].agent)} 会话`, `${nameOf(o, o.bindings[sid].agent)} session`);
  const agentNames = new Set(o.agents.map((a) => a.name));
  const count = new Map<string, number>();
  for (const sid of live) count.set(base(sid), (count.get(base(sid)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const sid of live) {
    const b = base(sid);
    out.set(sid, count.get(b)! > 1 || agentNames.has(b) ? `${b} · ${o.topics?.[sid] || agoText(at(sid), o.now)}` : b);
  }
  const seen = new Map<string, number>();
  for (const l of out.values()) seen.set(l, (seen.get(l) ?? 0) + 1);
  for (const [sid, l] of out) if (seen.get(l)! > 1) out.set(sid, `${l} #${sid.slice(-4)}`);
  return out;
}

/** The conversations that can still take a message, the most recently active first. */
function liveSessions(o: MentionSources, only?: readonly string[]) {
  const at = (sid: string) => lastActive(o.bindings[sid], o.activeAt[sid]);
  const named = labels(o);
  return (only ?? Object.keys(o.bindings))
    .filter((sid) => named.has(sid))
    .sort((a, b) => at(b) - at(a))
    .map((sid) => ({ sid, agent: o.bindings[sid].agent, name: named.get(sid)!, at: at(sid), running: !!o.status[sid]?.running }));
}

/** What a conversation's line says besides its name: its agent, and that it is at work or how long ago it last did anything. */
const sessionNote = (o: MentionSources, s: { agent: string; at: number; running: boolean }) => `${nameOf(o, s.agent)} · ${s.running ? tr("工作中", "working") : agoText(s.at, o.now)}`;
const sessionRow = (o: MentionSources, s: ReturnType<typeof liveSessions>[number]): MentionRow => ({ target: { type: "session", sid: s.sid, agent: s.agent, label: s.name }, title: s.name, note: sessionNote(o, s), group: "continue", running: s.running || undefined });
const nameOf = (o: MentionSources, kind: string) => o.agents.find((a) => a.kind === kind)?.name ?? kind;

/** Everything an @ can name that is worth listing: the session agents, then the conversations that can take a message; `query` filters both. */
export function mentionOptions(o: MentionSources, query: string): MentionTarget[] {
  const q = query.trim().toLowerCase();
  const hit = (...s: string[]) => !q || s.some((x) => x.toLowerCase().includes(q));
  return [
    ...o.agents.filter((a) => hit(a.name, a.kind)).map((a): MentionTarget => ({ type: "agent", kind: a.kind, label: a.name })),
    ...liveSessions(o).filter((s) => hit(s.name, s.agent)).map((s): MentionTarget => ({ type: "session", sid: s.sid, agent: s.agent, label: s.name })),
  ];
}

/**
 * The lines the @ list shows. With nothing typed: the thread's own conversation (when bound), the recommended new
 * conversation, the two most recent conversations on this canvas, and 「更多」 (which `expanded` turns into the whole
 * list). Once something is typed: the search over everything, no 「更多」.
 */
export function mentionRows(o: MentionSources, query: string, expanded: boolean): MentionRow[] {
  if (query.trim() || expanded) {
    const live = new Map(liveSessions(o).map((s) => [s.sid, s]));
    const found = mentionOptions(o, query);
    const sessions = found.flatMap((t) => (t.type === "session" ? [sessionRow(o, live.get(t.sid)!)] : []));
    const agents = found.flatMap((t): MentionRow[] => (t.type === "agent" ? [{ target: t, title: t.label, note: tr("新对话", "New conversation"), group: "new" }] : []));
    return [...sessions, ...agents];
  }
  const rows: MentionRow[] = [];
  const bound = o.handoff && liveSessions(o, [o.handoff.sessionId])[0];
  if (bound) rows.push({ target: { type: "session", sid: bound.sid, agent: bound.agent, label: o.handoff!.name }, title: tr(`继续交给 ${o.handoff!.name}`, `Keep handing to ${o.handoff!.name}`), note: "", group: "continue", running: bound.running || undefined });
  // the ones at work come first, all of them (two conversations working at once are the ones to tell apart), then the most recent up to two
  const others = liveSessions(o, o.canvas).filter((s) => s.sid !== bound?.sid).sort((a, b) => Number(b.running) - Number(a.running));
  const working = others.filter((s) => s.running).length;
  for (const s of others.slice(0, Math.max(RECENT, working))) rows.push(sessionRow(o, s));
  const kind = recommendAgent({ kinds: o.agents.map((a) => a.kind), bindings: o.bindings, activeAt: o.activeAt, canvas: o.canvas });
  const name = nameOf(o, kind);
  rows.push({ target: { type: "agent", kind, label: name }, title: tr(`${name} · 新对话`, `${name} · New conversation`), note: "", group: "new", badge: RECOMMENDED });
  rows.push({ more: true, title: MORE_TITLE });
  return rows;
}

/** Put the chosen mention where the `@query` was; the caret goes after it. */
export function applyMention(text: string, q: MentionQuery, target: MentionTarget): { text: string; caret: number } {
  const insert = `@${target.label} `;
  return { text: text.slice(0, q.start) + insert + text.slice(q.end), caret: q.start + insert.length };
}

/**
 * What a send carries, by Enter or by the send button (both call this, so they cannot differ): the text, trimmed, and the pick
 * made in the list while its `@name` is still in the text. Nothing for an empty box.
 */
export function submitMention(text: string, picked: MentionTarget | null): { text: string; mention: MentionTarget | null } | null {
  const t = text.trim();
  return t ? { text: t, mention: stillMentioned(t, picked) } : null;
}

/** The mention picked earlier only counts while its `@label` is still in the text. */
export const stillMentioned = (text: string, picked: MentionTarget | null): MentionTarget | null => (picked && text.includes(`@${picked.label}`) ? picked : null);

/** Where a message written in a thread goes. A guest never reaches an agent, whatever the text says. */
export type Route = { kind: "plain" } | { kind: "hand"; to: { sid: string } | { agent: string }; bound: boolean };

export function routeMessage(o: { guest: boolean; mention: MentionTarget | null; handoff: Thread["handoff"] }): Route {
  if (o.guest) return { kind: "plain" };
  if (o.mention) return { kind: "hand", to: o.mention.type === "agent" ? { agent: o.mention.kind } : { sid: o.mention.sid }, bound: false };
  if (o.handoff) return { kind: "hand", to: { sid: o.handoff.sessionId }, bound: true };
  return { kind: "plain" };
}

/** The name of the conversation a thread opens the first time an agent is mentioned in it. */
export const threadSessionName = (n: number, anchorName: string) => tr(`评论 #${n} · ${anchorName || "画布"}`, `Comment #${n} · ${anchorName || "Canvas"}`);

/** The line above a bound thread: who has it and how far it is. */
export function handoffLine(h: NonNullable<Thread["handoff"]>, agentName: string, state: "pending" | "running" | "answered" | "resolved", gone: boolean): string {
  if (gone) return tr(`${agentName} · ${h.name} 已不在了，重新 @ 一个对话`, `${agentName} · ${h.name} is gone; @ another conversation`);
  if (lang() === "en") return `${state === "running" ? "Being handled" : state === "answered" ? "Answered" : "Handed"} by ${agentName} · ${h.name}`;
  const what = state === "running" ? "处理中" : state === "answered" ? "已答复" : "已交接";
  return `由 ${agentName} · ${h.name} ${what}`;
}
export const MENTION_LIST_CLASS = "mention-list";
