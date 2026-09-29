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

// ── where the box goes (web/docs/workstation.md §12 对小人说话) ──

export type TBox = { x: number; y: number; w: number; h: number };
export type TalkView = { id: string; drawn: boolean };

/**
 * Which view hosts the one box: the view that really draws the figure. The one that has it now keeps it
 * (the box does not jump while you type); else the main canvas over a follow tab (`follow:<canvas>`); else the first.
 */
export function pickTalkHost(views: readonly TalkView[], prev: string | null): string | null {
  const drawn = views.filter((v) => v.drawn);
  if (!drawn.length) return null;
  return drawn.find((v) => v.id === prev)?.id ?? drawn.find((v) => !v.id.startsWith("follow:"))?.id ?? drawn[0].id;
}

/** The placeholder: while a turn runs the words wait for its end. */
export const talkPlaceholder = (name: string, working: boolean, sub = false) =>
  working ? `对 ${name} 说…（这一轮结束后送达）` : sub ? `对 ${name} 说…` : `对 ${name} 说…（回车发送）`;

export type Side = "below" | "above" | "right" | "left";
const overlap = (a: TBox, b: TBox) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * The box's place, in the view's pixels: under the figure's feet; when that covers a node or a label, above
 * the bubble over its head, or to its right or left — the first that covers nothing, else the one that covers
 * least. It stays inside `area` (what the toolbar and the strip leave free). The side it had is tried first,
 * so it does not flip while the figure walks.
 */
export function placeTalk(o: { feet: { x: number; y: number }; size: { w: number; h: number }; area: TBox; obstacles: readonly TBox[]; head?: number; prev?: Side | null }): { x: number; y: number; side: Side } {
  const { feet, size, area, obstacles } = o;
  const head = o.head ?? 130; // feet → top of the bubble over the head
  const cand: Record<Side, { x: number; y: number }> = {
    below: { x: feet.x - 18, y: feet.y + 9 },
    above: { x: feet.x - size.w / 2, y: feet.y - head - size.h - 8 },
    right: { x: feet.x + 34, y: feet.y - size.h - 6 },
    left: { x: feet.x - 34 - size.w, y: feet.y - size.h - 6 },
  };
  const order: Side[] = ["below", "above", "right", "left"];
  if (o.prev) order.unshift(o.prev);
  let best: { x: number; y: number; side: Side; cost: number } | null = null;
  for (const side of new Set(order)) {
    const x = Math.max(area.x, Math.min(area.x + area.w - size.w, cand[side].x));
    const y = Math.max(area.y, Math.min(area.y + area.h - size.h, cand[side].y));
    const r = { x, y, w: size.w, h: size.h };
    const cost = obstacles.reduce((s, b) => s + overlap(r, b), 0);
    if (cost === 0) return { x, y, side };
    if (!best || cost < best.cost) best = { x, y, side, cost };
  }
  return { x: best!.x, y: best!.y, side: best!.side };
}

// The one box: each view that may draw the selected figure reports whether it does (per frame, on change only);
// the host is picked by `pickTalkHost`, so the box is mounted in exactly one view — never a hidden one holding the focus.
const drawn = new Map<string, Set<string>>();
const hostOf = new Map<string, string | null>();
const hostLs = new Set<() => void>();
export const talkHost = {
  of: (runId: string) => hostOf.get(runId) ?? null,
  subscribe: (l: () => void) => (hostLs.add(l), () => void hostLs.delete(l)),
  report(runId: string, viewId: string, on: boolean) {
    let set = drawn.get(runId);
    if (!set) drawn.set(runId, (set = new Set()));
    if (set.has(viewId) === on) return;
    if (on) set.add(viewId);
    else set.delete(viewId);
    const prev = hostOf.get(runId) ?? null;
    const next = pickTalkHost([...set].map((id) => ({ id, drawn: true })), prev);
    if (next === prev) return;
    hostOf.set(runId, next);
    hostLs.forEach((l) => l());
  },
};

/** The box was closed (Esc, or after the delivery) for the selected run: it stays closed if the figure leaves the view and comes back, until another figure is selected. */
export const talkDismissed = { run: null as string | null };
