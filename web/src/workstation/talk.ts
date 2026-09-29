// 对小人说话 (web/docs/workstation.md §12): what ./TalkBubble.tsx says after Enter, and the nod.
// The message may wait behind the agent's running turn, so the figure nods when it really arrives — a user
// item with those words shows up in the session (`watchDelivery`) — not when it is sent. `at` is wall-clock
// ms; the frame loop compares it with its own time, so nothing here renders anything per frame.
import { useSyncExternalStore } from "react";
import { agents } from "../session/agents";

export type SendState = "sent" | "queued" | "delivered";
/** Sent behind a turn that is running (or others already waiting)? Messages from the panel wait for the turn to end. */
export function sendState(sessionId: string): "sent" | "queued" {
  const s = agents.get().status[sessionId];
  return s && (s.running || s.busy || s.queued > 0) ? "queued" : "sent";
}
export const deliveryNote = (agent: string, state: SendState) => `已发给 ${agent}${state === "queued" ? " · 会在这一轮结束后送达" : state === "delivered" ? " · 已送达" : ""}`;

/** Calls `done` once, when a user item containing `words` and newer than `sentAt` is in the session's transcript. Returns the stop. */
export function watchDelivery(sessionId: string, words: string, sentAt: number, done: () => void): () => void {
  let finished = false;
  const check = () => {
    if (finished || !agents.get().items[sessionId]?.some((it) => it.kind === "user" && it.at >= sentAt && (it.text ?? "").includes(words))) return;
    finished = true;
    off();
    done();
  };
  const off = agents.subscribe(check);
  check();
  return () => ((finished = true), off());
}

export type Talk = { runId: string; at: number } | null;
let state: Talk = null;
const ls = new Set<() => void>();

export const talk = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  /** The message to `runId`'s session went out. */
  said(runId: string) {
    state = { runId, at: Date.now() };
    ls.forEach((l) => l());
  },
};
export const useTalk = () => useSyncExternalStore(talk.subscribe, talk.get);
