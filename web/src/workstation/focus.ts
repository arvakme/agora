// Which agent the person is looking at (web/docs/workstation.md §选中与定位):
//   selected — a figure / bubble clicked on the canvas (shows its action row);
//   hovered  — the lane or figure under the pointer.
// A lane name "locates" its agent: the canvas the timeline belongs to pans smoothly to the figure,
// once (it never keeps following, and nothing else moves the person's view). Following and
// tracing are v2 (docs/workstation.md §v2).
import { useSyncExternalStore } from "react";

export type Focus = { selected: string | null; hovered: string | null };
let state: Focus = { selected: null, hovered: null };
const ls = new Set<() => void>();
const set = (p: Partial<Focus>) => {
  const next = { ...state, ...p };
  if ((Object.keys(p) as (keyof Focus)[]).every((k) => next[k] === state[k])) return;
  state = next;
  ls.forEach((l) => l());
};

export const focus = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  select: (id: string | null) => set({ selected: id }),
  hover: (id: string | null) => set({ hovered: id }),
  /** Esc: drop the selection. Returns whether it did something. */
  escape(): boolean {
    if (!state.selected) return false;
    set({ selected: null });
    return true;
  },
};
export const useFocus = () => useSyncExternalStore(focus.subscribe, focus.get);

/** Where each canvas last drew each figure (scene coordinates), for "locate" (lane click). */
const positions = new Map<string, Map<string, { x: number; y: number }>>();
export const figurePositions = {
  of: (canvasId: string) => {
    let m = positions.get(canvasId);
    if (!m) positions.set(canvasId, (m = new Map()));
    return m;
  },
  get: (canvasId: string, runId: string) => positions.get(canvasId)?.get(runId),
  drop: (canvasId: string) => void positions.delete(canvasId),
};
