// Someone just talked to a figure (web/docs/workstation.md「新想法」: ./TalkBubble.tsx sent a message to
// its session): the figure that got it turns to the person and nods. `at` is wall-clock ms; the
// frame loop compares it with its own time, so nothing here renders anything per frame.
import { useSyncExternalStore } from "react";

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
