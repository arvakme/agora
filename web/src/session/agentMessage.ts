// What Agora wrote into a session as a "user" message is not something the person said: a dispatch receipt, a task
// envelope, a canvas comment handed over. The server reads the first two (server/canvas/agora_msg.py: `item.card`);
// the comment hand-off is read here, next to the builder (comments/handoff.ts). Pure: the card's words are made here,
// drawn by ./AgoraCard.tsx.
import { parseCommentMessage, type ParsedComment } from "../comments/handoff";
import type { Item } from "./agents";

export type ReceiptState = "done" | "failed" | "blocked" | "idle_no_reply";
export type MsgCard =
  | { kind: "receipt"; id: string; state: string; agent?: string; session?: string; answer: string }
  | { kind: "task"; id: string; from: string; session?: string; scope: string[] }
  | ({ kind: "comment" } & ParsedComment)
  /** A prompt the page wrote for the person (./pageMessage.ts): who wrote it, what it is, and the words the agent got. */
  | { kind: "page"; from: string; title: string; text: string };

/** The card a user message stands for; undefined for what the person wrote (in Agora or in the terminal). */
export function messageCard(it: Pick<Item, "text" | "source" | "card" | "dispatch">): MsgCard | undefined {
  if (it.source !== "agora") return undefined;
  if (it.card) return it.card as MsgCard;
  const c = it.dispatch ? parseCommentMessage(it.text) : undefined; // only a dispatch carries a comment hand-off
  return c ? { kind: "comment", ...c } : undefined;
}

const STATE_WORD: Record<string, string> = { done: "完成", failed: "失败", blocked: "受阻", idle_no_reply: "结束了，没有交回执" };
export const stateWord = (state: string) => STATE_WORD[state] ?? state;

/** The turn's head, instead of 第 N 轮: what arrived. */
export const cardTurnLabel = (c: MsgCard): string => (c.kind === "receipt" ? "收到回执" : c.kind === "task" ? "收到任务" : c.kind === "page" ? `${c.from}发来的提示` : "收到评论");

/** The one line a card is in the trajectory and in titles. */
export function cardLine(c: MsgCard): string {
  if (c.kind === "receipt") return `${c.agent ?? "对方"} 交回了你派的任务 · ${stateWord(c.state)}`;
  if (c.kind === "task") return `${c.from} 派来一个任务`;
  if (c.kind === "page") return `来自${c.from} · ${c.title}`;
  return `画布评论 #${c.n}${c.followUp ? " 有新回复" : ""}${c.messages[0] ? `：${c.messages[0].text.split("\n")[0]}` : ""}`;
}

/** A card's heading in the conversation. */
export const cardHeading = (c: MsgCard): string => (c.kind === "comment" ? `画布评论 #${c.n}${c.followUp ? " 有新回复" : ""}` : cardLine(c));

/** The first words of what came back / was asked: one line, cut where it is long; the rest opens on demand. */
export const PREVIEW_MAX = 90;
export function cardPreview(c: MsgCard): { line: string; more: boolean } {
  const full = c.kind === "receipt" ? c.answer : c.kind === "page" ? c.text : c.kind === "comment" ? (c.messages[0]?.text ?? "") : c.scope.length ? `范围：${c.scope.join("、")}` : "";
  const line = full.replace(/\s+/g, " ").trim();
  const cut = line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX)}…` : line;
  return { line: cut, more: line.length > PREVIEW_MAX || full.includes("\n") || (c.kind === "comment" && c.messages.length > 1) };
}

/** The agent's short answer to a notice is quiet: nothing else happened in the turn and it says little. */
export const QUIET_REPLY_MAX = 160;
export const quietReply = (turn: { steps: { n: number; records: { kind: string }[] }[]; reply?: { text?: string } }): boolean =>
  !!turn.reply?.text && turn.reply.text.length <= QUIET_REPLY_MAX && !turn.steps.some((s) => s.records.some((r) => r.kind === "tool"));
