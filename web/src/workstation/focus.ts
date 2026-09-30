// Which agent the person is looking at (web/docs/workstation.md §选中与定位):
//   selected — a figure / bubble clicked on the canvas (shows its action row);
//   hovered  — the lane or figure under the pointer;
//   traced   — the agent whose turn was played (§追踪): the others dim, its route shows (until 「关闭」 or Esc), the
//              timeline keeps only it and its sub-agents; only a played turn traces;
//   turn     — which turn of that agent the trace covers (§11 按轮追踪: stops, route and sub-agents are
//              that turn's only); null = its current or latest turn, worked out where the trace is drawn;
//   itemHover / pan — the trajectory row under the pointer (its node and stop light up on the canvas) and
//              a one-off request to glide the canvas to a row's node.
// A lane name "locates" its agent: the canvas the timeline belongs to pans smoothly to the figure,
// once. Following an agent is the camera's (./replayLive.ts); nothing else moves the person's own view.
import { useSyncExternalStore } from "react";
import type { TurnWindow } from "./trace";

/** A timeline segment: run id and index in its segs. */
export type SegRef = { run: string; i: number };
export type Pan = { key: number; item: string };
export type Focus = { selected: string | null; hovered: string | null; segSel: SegRef | null; segHover: SegRef | null; traced: string | null; turn: TurnWindow | null; itemHover: string | null; pan: Pan | null };
let state: Focus = { selected: null, hovered: null, segSel: null, segHover: null, traced: null, turn: null, itemHover: null, pan: null };
let panKey = 0;
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
  /** A lane segment picked (its detail card shows; the canvas rings its node) or under the pointer. */
  selectSeg: (s: SegRef | null) => set({ segSel: s }),
  hoverSeg: (s: SegRef | null) => set({ segHover: s }),
  /** Trace an agent: its current or latest turn, or `turn` (letting go of the trace forgets the turn). */
  trace: (id: string | null, turn: TurnWindow | null = null) => set({ traced: id, turn: id ? turn : null }),
  /** The trajectory row under the pointer (its transcript item id): its node and stop light up. */
  hoverItem: (id: string | null) => set({ itemHover: id }),
  /** A trajectory row clicked: glide the canvas to its node, once. */
  panToItem: (item: string) => set({ pan: { key: ++panKey, item } }),
  /** Esc: close the route first, then drop the selection. Returns whether it did something. */
  escape(): boolean {
    if (state.traced) {
      set({ traced: null, turn: null });
      return true;
    }
    if (!state.selected && !state.segSel) return false;
    set({ selected: null, segSel: null });
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
