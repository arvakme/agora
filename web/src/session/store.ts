// Sessions: Agora's record of each session — the canvas it belongs to, and the canvas
// changes made in it (turns: steps plus the undo batch). The conversation itself lives in
// the native agent's own log (agents.ts); a turn here is one `agora canvas apply`/`anim`
// by that agent, or one eval planning turn (runTurn.ts).
import { useSyncExternalStore } from "react";
import type { Batch } from "../ops/apply";
import type { El } from "../canvas/scene";

export type StepKind = "read" | "engine" | "think" | "tool" | "plan" | "check" | "apply" | "dispatch" | "error";
export type Step = {
  id: string;
  kind: StepKind;
  title: string;
  detail?: string;
  /** Epoch ms, recorded when the event happened (server-stamped for model events). */
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "error" | "skipped";
  /** Canvas elements this step touched or referenced (hover highlights them). */
  elements?: string[];
  ops?: { op: string; target: string }[];
  candidates?: { id: string; name: string; library: string }[];
};
export type Origin =
  | { kind: "chat" }
  /** A change the session's agent made through the agora-canvas skill. */
  | { kind: "agent" }
  | { kind: "comment"; threadId: string; threadN: number; anchor: string };
export type TurnStatus = "running" | "applied" | "empty" | "invalid" | "stale" | "error";
export type Turn = {
  id: string;
  n: number;
  sessionId: string;
  canvasId: string;
  origin: Origin;
  request: string;
  /** `#` references to canvas elements, as picked in the composer. */
  refs: { id: string; label: string }[];
  startedAt: number;
  endedAt?: number;
  status: TurnStatus;
  steps: Step[];
  reply?: { text: string; tone?: "error" | "warn"; changes?: string[]; batchId?: string; undone?: boolean; undoError?: string };
  costUsd?: number | null;
  /** Per backend call (plan turns: one; animations: one per generation attempt). Not rendered yet. */
  usage?: Usage[];
};
/** One backend call's accounting, same shape for every execution backend (server/canvas/runner.py). */
export type Usage = {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  durationMs: number | null;
  costUsd: number | null;
};
export type Session = { id: string; canvasId: string; createdAt: number; turnIds: string[] };
export type SerialBatch = { before: [string, El | null][]; after: [string, number][] };
type State = { sessions: Record<string, Session>; turns: Record<string, Turn>; batches: Record<string, SerialBatch> };

let state: State = { sessions: {}, turns: {}, batches: {} };
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  listeners.forEach((l) => l());
};
const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;
const patchTurn = (id: string, f: (t: Turn) => Turn) => state.turns[id] && set({ ...state, turns: { ...state.turns, [id]: f(state.turns[id]) } });

export const sessions = {
  get: () => state,
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  snapshot: () => state,
  hydrate: (s: State) => set(s),
  reset: () => set({ sessions: {}, turns: {}, batches: {} }),

  create(canvasId: string, id = uid("s")): Session {
    const s: Session = { id, canvasId, createdAt: Date.now(), turnIds: [] };
    set({ ...state, sessions: { ...state.sessions, [id]: s } });
    return s;
  },
  relink: (id: string, canvasId: string) => set({ ...state, sessions: { ...state.sessions, [id]: { ...state.sessions[id], canvasId } } }),
  /** The session a canvas's comments report into for eval runs (the first one linked to it; created on demand). */
  forCanvas(canvasId: string): Session {
    return Object.values(state.sessions).find((s) => s.canvasId === canvasId) ?? sessions.create(canvasId);
  },
  onCanvas: (canvasId: string) => Object.values(state.sessions).filter((s) => s.canvasId === canvasId),

  startTurn(sessionId: string, t: Omit<Turn, "id" | "n" | "sessionId" | "steps" | "startedAt" | "status">): Turn {
    const s = state.sessions[sessionId];
    const turn: Turn = { ...t, id: uid("t"), n: s.turnIds.length + 1, sessionId, steps: [], startedAt: Date.now(), status: "running" };
    set({ ...state, turns: { ...state.turns, [turn.id]: turn }, sessions: { ...state.sessions, [sessionId]: { ...s, turnIds: [...s.turnIds, turn.id] } } });
    return turn;
  },
  patchTurn,
  /** Opens a step; returns its id. */
  step(turnId: string, s: Omit<Step, "id" | "status" | "startedAt"> & { startedAt?: number; status?: Step["status"] }) {
    const id = uid("st");
    patchTurn(turnId, (t) => ({ ...t, steps: [...t.steps, { status: "running", startedAt: Date.now(), ...s, id }] }));
    return id;
  },
  patchStep: (turnId: string, stepId: string, p: Partial<Step>) =>
    patchTurn(turnId, (t) => ({ ...t, steps: t.steps.map((s) => (s.id === stepId ? { ...s, ...p } : s)) })),
  endStep: (turnId: string, stepId: string, p: Partial<Step> = {}) =>
    patchTurn(turnId, (t) => ({ ...t, steps: t.steps.map((s) => (s.id === stepId ? { ...s, status: "done", endedAt: Date.now(), ...p } : s)) })),

  saveBatch(batch: Batch): string {
    const id = uid("b");
    set({ ...state, batches: { ...state.batches, [id]: { before: [...batch.before], after: [...batch.after] } } });
    return id;
  },
  batch(id: string): Batch | undefined {
    const b = state.batches[id];
    return b && { before: new Map(b.before), after: new Map(b.after) };
  },
};

export const useSessions = () => useSyncExternalStore(sessions.subscribe, sessions.get);
export const useTurn = (id: string | undefined) => useSyncExternalStore(sessions.subscribe, () => (id ? state.turns[id] : undefined));
