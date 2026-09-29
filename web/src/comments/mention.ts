// Handing a comment to an agent is done by @-mentioning it in the comment box (web/docs/workstation.md §12):
// no @ and no hand-off bound = an ordinary comment. Everything here is pure; the UI (MentionField.tsx) and the
// hand-off (ops/agent.ts) use it.
import type { Thread } from "./threads";

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

/** The list the @ opens: the session agents (T1) first, then the conversations that already exist; `query` filters both. */
export function mentionOptions(
  o: { agents: { kind: string; name: string }[]; sessions: { sid: string; agent: string; name: string }[] },
  query: string,
): MentionTarget[] {
  const q = query.trim().toLowerCase();
  const hit = (...s: string[]) => !q || s.some((x) => x.toLowerCase().includes(q));
  return [
    ...o.agents.filter((a) => hit(a.name, a.kind)).map((a): MentionTarget => ({ type: "agent", kind: a.kind, label: a.name })),
    ...o.sessions.filter((s) => hit(s.name, s.agent)).map((s): MentionTarget => ({ type: "session", sid: s.sid, agent: s.agent, label: s.name })),
  ];
}

/** Put the chosen mention where the `@query` was; the caret goes after it. */
export function applyMention(text: string, q: MentionQuery, target: MentionTarget): { text: string; caret: number } {
  const insert = `@${target.label} `;
  return { text: text.slice(0, q.start) + insert + text.slice(q.end), caret: q.start + insert.length };
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
export const threadSessionName = (n: number, anchorName: string) => `评论 #${n} · ${anchorName || "画布"}`;

/** The line above a bound thread: who has it and how far it is. */
export function handoffLine(h: NonNullable<Thread["handoff"]>, agentName: string, state: "pending" | "running" | "answered" | "resolved", gone: boolean): string {
  if (gone) return `${agentName} · ${h.name} 已不在了，重新 @ 一个对话`;
  const what = state === "running" ? "处理中" : state === "answered" ? "已答复" : "已交接";
  return `由 ${agentName} · ${h.name} ${what}`;
}
