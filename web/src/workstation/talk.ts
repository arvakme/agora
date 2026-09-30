// 对小人说话 (web/docs/workstation.md §12): what ./TalkBubble.tsx says after Enter, and the nod.
// The message may wait behind the agent's running turn, so the figure nods when it really arrives — a user
// item with those words shows up in the session (`watchDelivery`) — not when it is sent. `at` is wall-clock
// ms; the frame loop compares it with its own time, so nothing here renders anything per frame.
import { agents } from "../session/agents";
import { pageLead } from "../session/pageMessage";

export type SendState = "sent" | "queued" | "delivered" | "steered" | "steerRead" | "interrupted";
/** Sent behind a turn that is running (or others already waiting)? Messages from the panel wait for the turn to end. */
export function sendState(sessionId: string): "sent" | "queued" {
  const s = agents.get().status[sessionId];
  return s && (s.running || s.busy || s.queued > 0) ? "queued" : "sent";
}
export const deliveryNote = (agent: string, state: SendState) =>
  state === "steered" ? `已插话给 ${agent}` : state === "steerRead" ? `已插话给 ${agent} · 它已读到` : state === "interrupted" ? `已停下 ${agent} 的这一轮，改说这句` : `已发给 ${agent}${state === "queued" ? " · 会在这一轮结束后送达" : state === "delivered" ? " · 已送达" : ""}`;

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

/**
 * Whom the words go to and how the box says so. A run with a session of its own is talked to directly: 「对 X 说…」.
 * A sub-agent or an outside worker (Seedmux) cannot be talked to: the box says from the start that the words go to the
 * session that dispatched it — 「对 Claude Code 说（关于 T-ed3070）…」 —, the message gets 「关于你派的 T-ed3070：」 in front,
 * and one grey line under the box says so. `working`: a turn is running, the words wait for its end.
 */
export function talkTarget(o: { name: string; hasSession: boolean; rootName: string; working: boolean; plan?: "steer" | "choose" }): { direct: boolean; placeholder: string; prefix: string; note: string | null } {
  const tail = o.working ? (o.plan === "steer" ? "（直接插进这一轮）" : o.plan === "choose" ? "（回车后选：停下改说 / 等做完）" : "（这一轮结束后送达）") : "";
  if (o.hasSession) return { direct: true, placeholder: `对 ${o.name} 说…${tail || "（回车发送）"}`, prefix: "", note: null };
  return { direct: false, placeholder: `对 ${o.rootName} 说（关于 ${o.name}）…${tail}`, prefix: `${pageLead({ source: "小人", title: `关于你派的 ${o.name}` })}关于你派的 ${o.name}：`, note: `${o.name} 是 ${o.rootName} 派的，话会发给 ${o.rootName}` };
}

/** The box's width in a pane: its own (`natural`), or the area's when the area is narrower — never under 120 (the input needs something to be typed into). */
export const talkWidth = (area: TBox, natural = 232): number => Math.max(120, Math.min(natural, area.w));

/**
 * `text` cut with an ellipsis so that it fits `px` of one line at `font` px (CJK characters a full em wide, the rest about 0.56 em). An input that has the focus does not
 * ellipsize its placeholder (it cuts the last character in half), so the words are cut here, at a character. Unchanged when they fit.
 */
export function fitEllipsis(text: string, px: number, font = 13): string {
  const em = (ch: string) => ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.56) * font * 1.04;
  let w = 0;
  for (const ch of text) w += em(ch);
  if (w <= px) return text;
  const chars = [...text];
  let used = em("…");
  const keep: string[] = [];
  for (const ch of chars) {
    if (used + em(ch) > px) break;
    used += em(ch);
    keep.push(ch);
  }
  return keep.join("").trimEnd() + "…";
}

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

// ── waiting for delivery lives here, not in the box ──
// A message sent while a turn runs waits for its end; the figure may walk into a sub-diagram meanwhile and the box unmounts.
// The watch, the 「已发给 … / 已送达」 note and the nod are this module's state per run, so none of it depends on which view draws the figure.
export type SentNote = { agent: string; state: SendState };
const sentNotes = new Map<string, SentNote>();
const stops = new Map<string, () => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const sentLs = new Set<() => void>();
const sentEmit = () => sentLs.forEach((l) => l());
export const CLOSE_AFTER_MS = 4000;
export const talkSent = {
  get: (runId: string) => sentNotes.get(runId) ?? null,
  subscribe: (l: () => void) => (sentLs.add(l), () => void sentLs.delete(l)),
  /** The words went out to `sessionId`: say so, watch for them in the session, nod (`talk.said`) when they show up. */
  start(o: { runId: string; /** The figure that nods (the session's own, for a sub-agent's box). */ nodId: string; sessionId: string; words: string; sentAt: number; agent: string; state: SendState }) {
    stops.get(o.runId)?.();
    clearTimeout(timers.get(o.runId));
    sentNotes.set(o.runId, { agent: o.agent, state: o.state });
    sentEmit();
    stops.set(
      o.runId,
      watchDelivery(o.sessionId, o.words, o.sentAt, () => {
        sentNotes.set(o.runId, { agent: o.agent, state: o.state === "steered" ? "steerRead" : o.state === "interrupted" ? "interrupted" : "delivered" });
        talk.said(o.nodId);
        sentEmit();
        timers.set(
          o.runId,
          setTimeout(() => {
            sentNotes.delete(o.runId);
            talkDismissed.run = o.runId;
            sentEmit();
          }, CLOSE_AFTER_MS),
        );
      }),
    );
  },
  /** Forget everything about `runId` (tests, a run that is gone). */
  clear(runId: string) {
    stops.get(runId)?.();
    stops.delete(runId);
    clearTimeout(timers.get(runId));
    sentNotes.delete(runId);
    sentEmit();
  },
};
