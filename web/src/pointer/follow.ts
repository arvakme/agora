// Which session the progress pointer follows: the session pane focused last. Before any session
// was focused, the most recently active bound session.
import { useSyncExternalStore } from "react";
import { agents } from "../session/agents";

let followed: string | null = null;
const ls = new Set<() => void>();
export const pointerFollow = {
  set(sessionId: string) {
    if (sessionId === followed) return;
    followed = sessionId;
    ls.forEach((l) => l());
  },
  get: () => followed,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
};

/** The followed session if it is bound, else the most recently active bound one. */
export function useFollowedSession(): string | null {
  const f = useSyncExternalStore(pointerFollow.subscribe, pointerFollow.get);
  const st = useSyncExternalStore(agents.subscribe, agents.get);
  if (f && st.bindings[f]) return f;
  const bound = Object.keys(st.bindings);
  if (!bound.length) return null;
  return bound.sort((a, b) => (st.activeAt[b] ?? st.bindings[b].createdAt) - (st.activeAt[a] ?? st.bindings[a].createdAt))[0];
}
