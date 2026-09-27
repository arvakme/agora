// Agent sessions on the page: each Agora session is one native Pi / Claude Code / Codex
// session (server/canvas/sessions.py). This store holds what the server pushes over
// /api/agent/events — the binding (agent, model, effort, native id; fixed once chosen),
// the transcript read from the CLI's own log, and live status — and sends messages.
// Canvas bridge requests from `agora canvas …` are executed by ./agentBridge.ts.
import { useSyncExternalStore } from "react";

export type AgentKind = "pi" | "claude" | "codex";
export const AGENT_NAMES: Record<AgentKind, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" };
export const AGENT_KINDS: AgentKind[] = ["pi", "claude", "codex"];

export type Binding = { agent: AgentKind; model: string; effort: string; nativeId: string | null; createdAt: number };
export type Item = {
  id: string;
  kind: "user" | "assistant" | "tool";
  text?: string;
  at: number;
  source?: "agora" | "terminal";
  tool?: { name?: string; input?: string; output?: string; isError?: boolean };
};
export type Status = {
  running: boolean;
  busy: boolean;
  queued: number;
  held: string | null;
  activity: string | null;
  error: string | null;
  terminal: { alive: boolean; attach: string; clients: number };
};
export type Catalog = Record<AgentKind, { kind: AgentKind; name: string; installed: boolean; default: string; models: string[]; featured: string[]; efforts: string[]; defaultEffort: string }>;
/** A message Agora sent that has not finished yet (comment hand-offs wait on it). */
export type Inflight = { sendId: string; sessionId: string; canvasId: string; threadId?: string; threadN?: number; anchor?: string; turnIds: string[] };

type State = {
  connected: boolean;
  bindings: Record<string, Binding>;
  items: Record<string, Item[]>;
  status: Record<string, Status>;
  /** Last time something happened in a session (picks the canvas's session for comments). */
  activeAt: Record<string, number>;
  inflight: Record<string, Inflight>;
};

let state: State = { connected: false, bindings: {}, items: {}, status: {}, activeAt: {}, inflight: {} };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

type DoneEvent = { sessionId: string; sendId: string; text: string; error?: string | null; route: string };
const doneWaiters = new Map<string, (e: DoneEvent) => void>();

function upsert(sessionId: string, incoming: Item[], reset: boolean) {
  const cur = reset ? [] : [...(state.items[sessionId] ?? [])];
  const index = new Map(cur.map((it, i) => [it.id, i]));
  for (const it of incoming) {
    const i = index.get(it.id);
    if (i === undefined) {
      index.set(it.id, cur.length);
      cur.push(it);
    } else cur[i] = { ...cur[i], ...it, tool: { ...cur[i].tool, ...it.tool } };
  }
  const last = incoming.reduce((m, it) => Math.max(m, it.at), state.activeAt[sessionId] ?? 0);
  set({ items: { ...state.items, [sessionId]: cur }, activeAt: { ...state.activeAt, [sessionId]: last } });
}

export type BridgeHandler = (req: { rid: string; kind: string } & Record<string, unknown>) => Promise<unknown>;
let bridgeHandler: BridgeHandler | null = null;
export const setBridgeHandler = (h: BridgeHandler) => void (bridgeHandler = h);

/** Apply one server event (exported for tests). */
export async function handleEvent(e: Record<string, unknown> & { t: string }) {
  if (e.t === "hello") return set({ connected: true });
  if (e.t === "transcript") return upsert(e.sessionId as string, e.items as Item[], !!e.reset);
  if (e.t === "status") {
    const { binding, sessionId, t: _t, ...status } = e as unknown as { binding: Binding | Record<string, never>; sessionId: string; t: string } & Status;
    set({
      status: { ...state.status, [sessionId]: status },
      bindings: binding && "agent" in binding ? { ...state.bindings, [sessionId]: binding as Binding } : state.bindings,
    });
    return;
  }
  if (e.t === "done") {
    const d = e as unknown as DoneEvent;
    set({ activeAt: { ...state.activeAt, [d.sessionId]: Date.now() } });
    doneWaiters.get(d.sendId)?.(d);
    doneWaiters.delete(d.sendId);
    return;
  }
  if (e.t === "bridge" && bridgeHandler) {
    const { rid } = e as unknown as { rid: string };
    let result: unknown;
    try {
      result = await bridgeHandler(e as unknown as Parameters<BridgeHandler>[0]);
    } catch (err) {
      result = { status: "error", error: String(err) };
    }
    await fetch(`/api/agent/bridge/${rid}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result ?? {}) }).catch(() => {});
  }
}

let source: EventSource | null = null;
/** Subscribe to the project's agent events; this page executes canvas bridge requests. */
export function connectAgents() {
  if (source) return;
  source = new EventSource("/api/agent/events?executor=1");
  source.onmessage = (m) => {
    try {
      void handleEvent(JSON.parse(m.data));
    } catch {
      /* keepalive or garbage */
    }
  };
  source.onerror = () => set({ connected: false });
}

const json = async (r: Response) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string; detail?: string }).error ?? (body as { detail?: string }).detail ?? r.statusText);
  return body;
};

let catalogP: Promise<Catalog> | null = null;
export const agents = {
  get: () => state,
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  hydrateBindings: (b: Record<string, Binding>) => set({ bindings: { ...state.bindings, ...b } }),
  catalog: () => (catalogP ??= fetch("/api/agent/catalog").then(json) as Promise<Catalog>),

  /** Fix the session's agent, model and effort (once; the server refuses a different choice). */
  async bind(sessionId: string, agent: AgentKind, model: string, effort: string, nativeId?: string | null): Promise<Binding> {
    const b = (await json(
      await fetch(`/api/agent/sessions/${sessionId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, model, effort, nativeId: nativeId ?? null }) }),
    )) as Binding;
    set({ bindings: { ...state.bindings, [sessionId]: b }, activeAt: { ...state.activeAt, [sessionId]: Date.now() } });
    return b;
  },

  /** Send a message into the native session (terminal pane if one holds it, else a headless turn). */
  async send(sessionId: string, text: string, opts: { canvasId?: string; context?: string; thread?: Omit<Inflight, "sendId" | "sessionId" | "turnIds" | "canvasId"> } = {}) {
    const r = (await json(
      await fetch(`/api/agent/sessions/${sessionId}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, canvasId: opts.canvasId, context: opts.context ?? "" }) }),
    )) as { sendId: string; route: "terminal" | "headless" };
    const inflight: Inflight = { sendId: r.sendId, sessionId, canvasId: opts.canvasId ?? "", turnIds: [], ...opts.thread };
    set({ inflight: { ...state.inflight, [sessionId]: inflight }, activeAt: { ...state.activeAt, [sessionId]: Date.now() } });
    const done = new Promise<DoneEvent>((ok) => doneWaiters.set(r.sendId, ok)).then((d) => {
      if (state.inflight[sessionId]?.sendId === r.sendId) {
        const { [sessionId]: _, ...rest } = state.inflight;
        set({ inflight: rest });
      }
      return { ...d, turnIds: inflight.turnIds };
    });
    return { ...r, done };
  },
  /** Apply turns created while a send is in flight belong to it (a comment's undo, its reply link). */
  noteTurn(sessionId: string, turnId: string) {
    const f = state.inflight[sessionId];
    if (f) f.turnIds.push(turnId);
  },

  async openTerminal(sessionId: string, canvasId: string, launch = true) {
    return (await json(
      await fetch(`/api/agent/sessions/${sessionId}/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ launch, canvasId }) }),
    )) as { attach: string; launched: "kitty" | "terminal" | null; created: boolean };
  },
  closeTerminal: (sessionId: string) => fetch(`/api/agent/sessions/${sessionId}/terminal`, { method: "DELETE" }),
  interrupt: (sessionId: string) => fetch(`/api/agent/sessions/${sessionId}/interrupt`, { method: "POST" }),

  /** The session a canvas's comments go to: the most recently active agent session on it. */
  forCanvas(sessionIds: string[]): string | undefined {
    const bound = sessionIds.filter((id) => state.bindings[id]);
    return bound.sort((a, b) => (state.activeAt[b] ?? state.bindings[b].createdAt) - (state.activeAt[a] ?? state.bindings[a].createdAt))[0];
  },
};

export const useAgents = () => useSyncExternalStore(agents.subscribe, agents.get);
