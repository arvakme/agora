// Our own comment layer state (not Excalidraw's). One store per canvas, so each
// canvas has independent threads; UI, agent runner and eval share it.
import { useSyncExternalStore } from "react";

export type Anchor = {
  /** Stable element ids; the first one carries the pin. */
  ids: string[];
  /** Pin position relative to the primary element's bounding box (0..1). */
  rel: { x: number; y: number };
  /** Scene position at creation; the pin layer keeps it current while the anchor lives. */
  last: { x: number; y: number };
};

export type Message = {
  id: string;
  author: "you" | "agent" | "system";
  text: string;
  at: number;
  tone?: "error" | "warn";
  meta?: string;
  /** Agent replies point at their session turn — the single record both views render. */
  turnId?: string;
  /** Agent replies from a native session: the session that answered (text is the agent's own reply;
   * turnId, if any, is its last canvas change there — for undo). */
  sessionId?: string;
  /** Who wrote a human ("you") message. Several people can take part in one thread. */
  by?: Person;
};
/** A person commenting: this machine's user by default (git user.name), later also share guests. */
export type Person = { id: string; name: string };

export type Thread = {
  id: string;
  n: number;
  anchor: Anchor;
  resolved: boolean;
  agent: "idle" | "running";
  messages: Message[];
  createdAt: number;
  createdBy?: Person;
};

type State = { threads: Thread[]; activeId: string | null };
/** Where new human comments go besides this page (share guests post each one to the server). */
export type Remote = {
  create?: (t: Thread) => void;
  reply?: (threadId: string, m: Message) => void;
};
export type ThreadSnapshot = { threads: Thread[]; seq: number };
export type ThreadStore = ReturnType<typeof createThreadStore>;

const uid = () => Math.random().toString(36).slice(2, 10);

/** The person new human messages are attributed to (set once the project says who we are). */
let me: Person | undefined;
export const setIdentity = (p: Person | undefined) => void (me = p);
export const identity = () => me;

/** The live store per canvas, so server pushes (someone else's comments) reach the page. */
export const threadStores = new Map<string, ThreadStore>();

export function createThreadStore(canvasId: string, initial?: ThreadSnapshot, remote: Remote = {}) {
  let state: State = { threads: initial?.threads.map((t) => ({ ...t, agent: "idle" as const })) ?? [], activeId: null };
  let seq = initial?.seq ?? 0;
  const listeners = new Set<() => void>();
  const set = (next: State) => {
    state = next;
    listeners.forEach((l) => l());
  };
  const patch = (id: string, f: (t: Thread) => Thread) =>
    set({ ...state, threads: state.threads.map((t) => (t.id === id ? f(t) : t)) });

  return {
    canvasId,
    snapshot: (): ThreadSnapshot => ({ threads: state.threads, seq }),
    get: () => state,
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    thread: (id: string) => state.threads.find((t) => t.id === id),
    reset() {
      seq = 0;
      set({ threads: [], activeId: null });
    },
    create(anchor: Anchor, text: string): Thread {
      const t: Thread = {
        id: uid(),
        n: ++seq,
        anchor,
        resolved: false,
        agent: "idle",
        createdAt: Date.now(),
        ...(me && { createdBy: me }),
        messages: [{ id: uid(), author: "you", text, at: Date.now(), ...(me && { by: me }) }],
      };
      set({ threads: [...state.threads, t], activeId: t.id });
      remote.create?.(t);
      return t;
    },
    reply(id: string, msg: Omit<Message, "id" | "at">) {
      const m: Message = { ...(msg.author === "you" && me && { by: me }), ...msg, id: uid(), at: Date.now() };
      patch(id, (t) => ({ ...t, messages: [...t.messages, m] }));
      if (m.author === "you") remote.reply?.(id, m);
      return m;
    },
    /** Take in the file as the server has it now: threads and messages this page doesn't have yet
     * (another person's) and the server's numbering. Nothing this page holds is dropped. Returns whether anything changed. */
    merge(snap: ThreadSnapshot): boolean {
      let changed = false;
      const mine = new Map(state.threads.map((t) => [t.id, t]));
      const threads = state.threads.map((t) => {
        const s = snap.threads.find((x) => x.id === t.id);
        if (!s) return t;
        const have = new Set(t.messages.map((m) => m.id));
        const extra = s.messages.filter((m) => !have.has(m.id));
        if (!extra.length && s.n === t.n) return t;
        changed = true;
        const messages = extra.length ? [...t.messages, ...extra].sort((a, b) => a.at - b.at) : t.messages;
        return { ...t, n: s.n, messages };
      });
      for (const s of snap.threads)
        if (!mine.has(s.id)) {
          threads.push({ ...s, agent: "idle" });
          changed = true;
        }
      if (snap.seq > seq) {
        seq = snap.seq;
        changed = true;
      }
      if (changed) set({ ...state, threads });
      return changed;
    },
    updateMessage: (id: string, msgId: string, f: (m: Message) => Message) =>
      patch(id, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === msgId ? f(m) : m)) })),
    /** Resolving also closes the thread card; reopening leaves it open. */
    setResolved: (id: string, resolved: boolean) =>
      set({
        threads: state.threads.map((t) => (t.id === id ? { ...t, resolved } : t)),
        activeId: resolved && state.activeId === id ? null : state.activeId,
      }),
    setAgent: (id: string, agent: Thread["agent"]) => patch(id, (t) => ({ ...t, agent })),
    /** Opens a thread (idempotent — never toggles). */
    open: (id: string) => state.activeId !== id && set({ ...state, activeId: id }),
    close: () => state.activeId !== null && set({ ...state, activeId: null }),
  };
}

export const isGuestId = (id: string | undefined) => !!id?.startsWith("guest:");

export const useThreads = (store: ThreadStore) => useSyncExternalStore(store.subscribe, store.get);
