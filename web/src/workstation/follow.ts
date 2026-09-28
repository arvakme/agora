// Following one agent (web/docs/workstation.md §10 子视图跟随): a read-only pane keeps it in view,
// going in and out of sub-diagrams with it, while the person's own canvas never moves. The pane
// (./FollowPane.tsx) opens by itself when an agent comes into a sub-view (`auto`: it then moves on
// to whoever comes in next and closes once they have all left), or when the person asks (F, 跟随).
// `ended`: the agent has finished — or, followed by itself, has left the sub-views — so the pane
// stays where it last was, says so, and closes after a moment unless it is pinned.
import { useSyncExternalStore } from "react";

export type Follow = { run: string | null; ended: boolean; auto: boolean; pinned: boolean };
let state: Follow = { run: null, ended: false, auto: false, pinned: false };
const ls = new Set<() => void>();
const set = (next: Follow) => {
  if (next.run === state.run && next.ended === state.ended && next.auto === state.auto && next.pinned === state.pinned) return;
  state = next;
  ls.forEach((l) => l());
};

export const follow = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  /** Follow `run` — the person's choice unless `auto`. An open pane keeps its pin. */
  start: (run: string, o: { auto?: boolean } = {}) => set({ run, ended: false, auto: !!o.auto, pinned: !!state.run && state.pinned }),
  end: () => void (state.run && set({ ...state, ended: true })),
  stop: () => set({ run: null, ended: false, auto: false, pinned: false }),
  /** 钉住: the pane stays open when its agent leaves or finishes. */
  pin: (on: boolean) => void (state.run && set({ ...state, pinned: on })),
};
export const useFollow = () => useSyncExternalStore(follow.subscribe, follow.get);

/** The id the pane's picture of a canvas goes by (its own viewport and figure positions; the canvas
 * itself may be on screen too), and back. */
export const paneView = (canvasId: string) => `follow:${canvasId}`;
export const canvasOfView = (viewId: string) => (viewId.startsWith("follow:") ? viewId.slice(7) : viewId);
