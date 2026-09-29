// Whether the build replay is open, for which canvas and at which step (the ⋯ menu, a guest's 「看搭建过程」 button and a comment's
// moment open it; `?buildreplay=<canvas>` opens it on load), and where a comment made while watching goes.
import { useSyncExternalStore } from "react";

type Open = { canvas: string; step: number | null } | null;
let cur: Open = null;
const listeners = new Set<() => void>();
const set = (o: Open) => {
  if (o?.canvas === cur?.canvas && o?.step === cur?.step) return;
  cur = o;
  listeners.forEach((l) => l());
};

/** A comment on the whole canvas made at a moment of the replay (`step`: the step being watched). Set by the page that owns the comments. */
export type Commenter = (text: string, step: number) => void;
let commenter: Commenter | null = null;

export const buildReplay = {
  get: () => cur?.canvas ?? null,
  /** The step a comment sent us to (null: from the start). */
  step: () => cur?.step ?? null,
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  open: (canvas: string, step: number | null = null) => set({ canvas, step }),
  close: () => set(null),
  setCommenter: (c: Commenter | null) => void (commenter = c),
  comment: (text: string, step: number) => commenter?.(text, step),
  canComment: () => commenter !== null,
};
export const useBuildReplay = () => useSyncExternalStore(buildReplay.subscribe, buildReplay.get);
