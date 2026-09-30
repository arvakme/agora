// Which session a canvas comment goes to (ops/agent.ts `handToSession`). In order:
//   1. a session the person has open in the window manager and is looking at (the one whose pane was
//      focused last — `pointerFollow`) that is linked to this canvas;
//   2. any other open session linked to it, the most recently active first;
//   3. the most recently active linked session;
// and none at all → the person is asked to choose. A session that cannot take a message is never picked.
import type { Binding, Status } from "./agents";

/**
 * Whether the server would accept a message for this session — its own rules (server/canvas/sessions.py
 * `send`), read off the status it pushes: a binding; not a copy brought along by `cp -r` (read-only until
 * forked); and, unless a live terminal already holds the native session, a usable native log (`native`
 * problem: missing / ambiguous / elsewhere block; duplicates only informs). No status yet counts as fine —
 * the server still checks, and a refusal is handled where the send happens.
 */
export function sendable(b: Binding | undefined, s: Status | undefined): boolean {
  if (!b) return false;
  if (s?.copy) return false;
  if (s?.native?.blocking && !s.terminal?.alive) return false;
  return true;
}

export type PickInput = {
  /** The sessions linked to the canvas. */
  ids: string[];
  bindings: Record<string, Binding>;
  status: Record<string, Status | undefined>;
  activeAt: Record<string, number>;
  /** Sessions with an open tab. */
  open: ReadonlySet<string>;
  /** The session pane focused last. */
  focused?: string | null;
  /** Already tried (a send to it failed). */
  skip?: string[];
};

export function pickSession(o: PickInput): { sid?: string; live: string[] } {
  const recent = (id: string) => o.activeAt[id] ?? o.bindings[id]?.createdAt ?? 0;
  const live = o.ids.filter((id) => !o.skip?.includes(id) && sendable(o.bindings[id], o.status[id])).sort((a, b) => recent(b) - recent(a));
  const watched = o.focused && o.open.has(o.focused) && live.includes(o.focused) ? o.focused : undefined;
  return { sid: watched ?? live.find((id) => o.open.has(id)) ?? live[0], live };
}
