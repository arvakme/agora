// 「回到最新」 for the session pane (chat and trajectory): when to show the pill, what it counts, when the pane
// follows new content. Pure — the scroll listener and the pill are ./JumpPill.tsx.
export type Metrics = { top: number; height: number; client: number };
/** Slack that still counts as "at the end" (sub-pixel scrolling, a line of padding). */
export const FOLLOW_PX = 48;
/** The pill shows once the pane is this far off the end, as a share of its height. */
export const SHOW_FRACTION = 1 / 3;

/** Distance from the end (≥ 0: elastic overscroll and content that fits are at the end). */
export const distance = (m: Metrics) => Math.max(0, m.height - m.top - m.client);
/** At the end: new content scrolls into view by itself. */
export const following = (m: Metrics) => distance(m) <= FOLLOW_PX;
/** Far enough from the end for the pill. */
export const showJump = (m: Metrics) => distance(m) > m.client * SHOW_FRACTION;

/** `base`: how many items there were when the person left the end (null while at the end). */
export type Track = { base: number | null };
export type Seen = { track: Track; unread: number; follow: boolean; show: boolean };

/**
 * One look at the pane: its scroll metrics and how many items it holds. At the end: following, nothing unread.
 * Away: the count at the moment of leaving is remembered, what arrived since is unread, and the pane does not
 * follow (it would take away what is being read). The pill shows when far enough off the end, or as soon as
 * something new is waiting.
 */
export function observe(prev: Track, m: Metrics, count: number): Seen {
  if (following(m)) return { track: { base: null }, unread: 0, follow: true, show: false };
  const base = prev.base ?? count;
  const unread = Math.max(0, count - base);
  return { track: { base }, unread, follow: false, show: showJump(m) || unread > 0 };
}

/** The pill's words. (A turn still running is a dot beside them.) */
export const jumpLabel = (unread: number, _running: boolean) => (unread > 0 ? `↓ ${unread} 条新消息` : "回到最新 ↓");
