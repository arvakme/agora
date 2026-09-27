// Cross-pane wiring between sessions and canvases, without sessions importing the app shell:
// a registry of live canvases and a few UI actions the shell provides, plus the
// "highlight these elements on that canvas" signal used by step hover.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useSyncExternalStore } from "react";
import type { ThreadStore } from "../comments/threads";

export type CanvasEntry = { api: ExcalidrawImperativeAPI; store: ThreadStore; title: string };
export const canvases = new Map<string, CanvasEntry>();

/** Filled in by the app shell. */
export const ui = {
  /** Bring a pane (canvas or session tab) to the front and focus it. */
  focusPane: (_id: string) => {},
  /** Focus a canvas, pan to a thread's pin and open it. */
  openThread: (_canvasId: string, _threadId: string) => {},
  /** Show a session tab for this session (open one if none). */
  openSession: (_sessionId: string, _turnId?: string) => {},
  /** A closed canvas has no live API: reopen its tab (without moving focus) and resolve once it is mounted. */
  ensureCanvas: async (id: string): Promise<CanvasEntry | undefined> => canvases.get(id),
};

type Highlight = { canvasId: string; ids: string[] } | null;
let hl: Highlight = null;
const ls = new Set<() => void>();
export const highlight = {
  set(h: Highlight) {
    hl = h;
    ls.forEach((l) => l());
  },
  get: () => hl,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
};
export const useHighlight = () => useSyncExternalStore(highlight.subscribe, highlight.get);
