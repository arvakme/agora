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
  /** No agent session on this canvas yet: open one and let the person pick its agent. Resolves with the bound session. */
  chooseAgent: async (_canvasId: string): Promise<string | undefined> => undefined,
  /** A fresh session from nothing: a draft with the agent picker, placed like a comment hand-off's (into the session column, else split off the canvas's right). */
  newSession: () => {},
  /** Move a session to the trash (the shell asks first, in 所有画布). */
  trashSession: (_sessionId: string) => {},
  /** Open 回收站, optionally at one item. */
  openTrash: (_trashId?: string) => {},
  /** Open 会话历史. */
  openHistory: () => {},
};

/** Sessions with an open tab (their pane is mounted): "the one the person is looking at" starts from these. */
let openNow: ReadonlySet<string> = new Set();
const openLs = new Set<() => void>();
const setOpen = (next: Set<string>) => ((openNow = next), openLs.forEach((l) => l()));
export const openSessions = {
  mount: (id: string) => !openNow.has(id) && setOpen(new Set([...openNow, id])),
  unmount: (id: string) => openNow.has(id) && setOpen(new Set([...openNow].filter((x) => x !== id))),
  get: () => openNow,
  subscribe: (l: () => void) => (openLs.add(l), () => void openLs.delete(l)),
};

/** Text to put in a session's composer when it opens (a summary to carry into a fresh native session). */
export const draftText = new Map<string, string>();

/** Sessions waiting for the person to pick an agent (a comment hand-off is parked on them). */
const choosing = new Map<string, (bound: string | undefined) => void>();
export const agentChoice = {
  wait: (sessionId: string) => new Promise<string | undefined>((ok) => choosing.set(sessionId, ok)),
  pending: (sessionId: string) => choosing.has(sessionId),
  resolve(sessionId: string, bound: string | undefined) {
    choosing.get(sessionId)?.(bound);
    choosing.delete(sessionId);
  },
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

/** Show a session's trajectory at one turn (the progress pointer links to turns). The session pane listens. */
export const openTrajectory = (sessionId: string, turn: number) => dispatchEvent(new CustomEvent("agora:trajectory", { detail: { sessionId, turn } }));
