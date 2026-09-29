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

/** Where in the build replay (web/docs/share-build-replay.md) a comment was made: the step being watched. */
export type Moment = { step: number };

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
  /** A system message that offers a next step: `switch-session` = 换一个会话 (a hand-off failed; the button opens the chooser and sends again). */
  action?: "switch-session";
  /** Who wrote a human ("you") message. Several people can take part in one thread. */
  by?: Person;
  /** Set when the author changed the text after posting (shown as 已编辑). */
  editedAt?: number;
  /** Last change after posting (edit, delete, restore): the later copy wins when two writers merge. */
  updatedAt?: number;
  /** Tombstone: the text is gone; kept so merges with older copies don't bring it back. */
  deleted?: boolean;
};
/** A person commenting: this machine's user by default (git user.name), later also share guests. */
export type Person = { id: string; name: string };

export type Thread = {
  id: string;
  n: number;
  /** What it is pinned to; null = a comment on the whole canvas (no pin: the list and the corner button show it). */
  anchor: Anchor | null;
  /** The moment of the build replay it was made at (optional; a click on it goes back there). */
  moment?: Moment;
  resolved: boolean;
  agent: "idle" | "running";
  messages: Message[];
  createdAt: number;
  createdBy?: Person;
  /** Last change of the thread itself (resolve, delete, restore, re-pin). */
  updatedAt?: number;
  /** Who resolved it and when (shown on the quiet resolved pin). */
  resolvedAt?: number;
  resolvedBy?: Person;
  /** Tombstone: the owner deleted the whole thread; its number is not reused. */
  deleted?: boolean;
  /**
   * The conversation this thread is bound to: replies go there, without another @, until 「结束交接」 (null).
   * The server writes it when the hand-off is sent (dispatch.py); this file is where it lives.
   */
  handoff?: { sessionId: string; agent: string; name: string } | null;
};

type State = { threads: Thread[]; activeId: string | null };
/** Where new human comments go besides this page (share guests post each one to the server). */
export type Remote = {
  create?: (t: Thread) => void;
  reply?: (threadId: string, m: Message) => void;
  edit?: (threadId: string, m: Message) => void;
  remove?: (threadId: string, msgId: string) => void;
  restore?: (threadId: string, m: Message) => void;
};
/** What a delete can put back, once (the page's undo toast). */
export type Undo = { canvasId: string; label: string; run: () => void };
export type ThreadSnapshot = { threads: Thread[]; seq: number };
export type ThreadStore = ReturnType<typeof createThreadStore>;

const uid = () => Math.random().toString(36).slice(2, 10);

/** The person new human messages are attributed to (set once the project says who we are). */
let me: Person | undefined;
export const setIdentity = (p: Person | undefined) => void (me = p);
export const identity = () => me;
/** The owner's page (not a share guest). The owner may delete anyone's message and whole threads. */
export const isOwner = () => !isGuestId(me?.id);
/** Human messages are editable and deletable by whoever wrote them (legacy ones without `by` are the owner's). */
export const isMine = (m: Message) => m.author === "you" && (m.by ? m.by.id === me?.id : isOwner());
export const canEdit = (m: Message) => !m.deleted && isMine(m);
export const canDelete = (m: Message) => !m.deleted && (isMine(m) || isOwner());

const stamp = (x: { updatedAt?: number }) => x.updatedAt ?? 0;
/** What the UI shows: no deleted threads or messages, no threads left without a message. */
function visible(all: Thread[]): Thread[] {
  const out: Thread[] = [];
  for (const t of all) {
    if (t.deleted) continue;
    const messages = t.messages.some((m) => m.deleted) ? t.messages.filter((m) => !m.deleted) : t.messages;
    if (!messages.length) continue;
    out.push(messages === t.messages ? t : { ...t, messages });
  }
  return out;
}
const tombstone = (m: Message, at: number): Message => ({ id: m.id, author: m.author, at: m.at, ...(m.by && { by: m.by }), text: "", deleted: true, updatedAt: at });

/** The live store per canvas, so server pushes (someone else's comments) reach the page. */
export const threadStores = new Map<string, ThreadStore>();

export function createThreadStore(canvasId: string, initial?: ThreadSnapshot, remote: Remote = {}) {
  // `all` is the file as this page knows it (tombstones included, for saving and merging);
  // `state.threads` is what the UI renders.
  let all: Thread[] = initial?.threads.map((t) => ({ ...t, agent: "idle" as const })) ?? [];
  let state: State = { threads: visible(all), activeId: null };
  let seq = initial?.seq ?? 0;
  const listeners = new Set<() => void>();
  const commit = (next: Thread[], activeId = state.activeId) => {
    all = next;
    const threads = visible(all);
    state = { threads, activeId: activeId && threads.some((t) => t.id === activeId) ? activeId : null };
    listeners.forEach((l) => l());
  };
  const patch = (id: string, f: (t: Thread) => Thread) => commit(all.map((t) => (t.id === id ? f(t) : t)));
  const find = (id: string) => all.find((t) => t.id === id);
  const setMsg = (id: string, msgId: string, f: (m: Message) => Message) =>
    patch(id, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === msgId ? f(m) : m)) }));

  return {
    canvasId,
    snapshot: (): ThreadSnapshot => ({ threads: all, seq }),
    get: () => state,
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    thread: (id: string) => state.threads.find((t) => t.id === id),
    reset() {
      seq = 0;
      commit([], null);
    },
    create(anchor: Anchor | null, text: string, moment?: Moment): Thread {
      const t: Thread = {
        id: uid(),
        n: ++seq,
        anchor,
        ...(moment && { moment }),
        resolved: false,
        agent: "idle",
        createdAt: Date.now(),
        ...(me && { createdBy: me }),
        messages: [{ id: uid(), author: "you", text, at: Date.now(), ...(me && { by: me }) }],
      };
      commit([...all, t], t.id);
      remote.create?.(t);
      return t;
    },
    /** Add a message. A person replying to a resolved thread reopens it. */
    reply(id: string, msg: Omit<Message, "id" | "at">) {
      const m: Message = { ...(msg.author === "you" && me && { by: me }), ...msg, id: uid(), at: Date.now() };
      patch(id, (t) => {
        const next = { ...t, messages: [...t.messages, m] };
        if (!(t.resolved && m.author === "you")) return next;
        const { resolvedAt: _a, resolvedBy: _b, ...rest } = next;
        return { ...rest, resolved: false, updatedAt: m.at };
      });
      if (m.author === "you") remote.reply?.(id, m);
      return m;
    },
    /** Change the text of one's own message. Returns whether it changed. */
    edit(id: string, msgId: string, text: string): boolean {
      const m = find(id)?.messages.find((x) => x.id === msgId);
      const next = text.trim();
      if (!m || !canEdit(m) || !next || next === m.text) return false;
      const now = Date.now();
      const edited: Message = { ...m, text: next, editedAt: now, updatedAt: now };
      setMsg(id, msgId, () => edited);
      remote.edit?.(id, edited);
      return true;
    },
    /** Delete one message (one's own; the owner any). Returns the undo, or null if not allowed. */
    removeMessage(id: string, msgId: string): Undo | null {
      const m = find(id)?.messages.find((x) => x.id === msgId);
      if (!m || !canDelete(m)) return null;
      // Deleting a thread's last visible message hides the thread, which closes its card; the
      // undo brings the card back open, as it was.
      const wasOpen = state.activeId === id;
      setMsg(id, msgId, (x) => tombstone(x, Date.now()));
      remote.remove?.(id, msgId);
      return {
        canvasId,
        label: "已删除一条评论",
        run: () => {
          const back: Message = { ...m, updatedAt: Date.now() };
          commit(all.map((t) => (t.id === id ? { ...t, messages: t.messages.map((x) => (x.id === msgId ? back : x)) } : t)), wasOpen ? id : state.activeId);
          remote.restore?.(id, back);
        },
      };
    },
    /** The owner deletes a whole thread (also one whose anchor is gone). Returns the undo. */
    removeThread(id: string): Undo | null {
      const t = find(id);
      if (!t || t.deleted || !isOwner()) return null;
      const now = Date.now();
      const wasOpen = state.activeId === id;
      commit(all.map((x) => (x.id === id ? { id: t.id, n: t.n, createdAt: t.createdAt, ...(t.createdBy && { createdBy: t.createdBy }), anchor: t.anchor, ...(t.moment && { moment: t.moment }), agent: "idle", resolved: true, deleted: true, updatedAt: now, messages: [] } : x)));
      return {
        canvasId,
        label: `已删除线程 #${t.n}`,
        run: () => commit(all.map((x) => (x.id === id ? { ...t, agent: "idle" as const, updatedAt: Date.now() } : x)), wasOpen ? id : state.activeId),
      };
    },
    /** Take in the file as the server has it now: threads and messages this page doesn't have yet
     * (another person's), later edits and deletions (by `updatedAt`), and the server's numbering.
     * Returns whether anything changed. */
    merge(snap: ThreadSnapshot): boolean {
      let changed = false;
      const mine = new Set(all.map((t) => t.id));
      const next = all.map((t) => {
        const s = snap.threads.find((x) => x.id === t.id);
        if (!s) return t;
        if (stamp(s) > stamp(t) && s.deleted) {
          changed = true;
          return { ...s, anchor: s.anchor ?? t.anchor, agent: "idle" as const };
        }
        if (t.deleted && stamp(s) <= stamp(t)) return t; // an older copy doesn't bring a deleted thread back
        const base = stamp(s) > stamp(t) ? { ...t, resolved: s.resolved, deleted: s.deleted, updatedAt: s.updatedAt, anchor: s.anchor ?? t.anchor, resolvedAt: s.resolvedAt, resolvedBy: s.resolvedBy, handoff: s.handoff } : t;
        const theirs = new Map(s.messages.map((m) => [m.id, m]));
        let msgChanged = false;
        const messages = t.messages.map((m) => {
          const o = theirs.get(m.id);
          if (!o || stamp(o) <= stamp(m)) return m;
          msgChanged = true;
          return o;
        });
        const have = new Set(t.messages.map((m) => m.id));
        const extra = s.messages.filter((m) => !have.has(m.id));
        if (!extra.length && !msgChanged && s.n === t.n && base === t) return t;
        changed = true;
        return { ...base, n: s.n, messages: extra.length ? [...messages, ...extra].sort((a, b) => a.at - b.at) : messages };
      });
      for (const s of snap.threads)
        if (!mine.has(s.id)) {
          next.push({ ...s, agent: "idle" });
          changed = true;
        }
      if (snap.seq > seq) {
        seq = snap.seq;
        changed = true;
      }
      if (changed) commit(next);
      return changed;
    },
    updateMessage: (id: string, msgId: string, f: (m: Message) => Message) => setMsg(id, msgId, f),
    /** Resolving also closes the thread card; reopening leaves it open. */
    setResolved: (id: string, resolved: boolean) => {
      const now = Date.now();
      commit(
        all.map((t) => {
          if (t.id !== id) return t;
          if (resolved) return { ...t, resolved, updatedAt: now, resolvedAt: now, ...(me && { resolvedBy: me }) };
          const { resolvedAt: _a, resolvedBy: _b, ...rest } = t;
          return { ...rest, resolved, updatedAt: now };
        }),
        resolved && state.activeId === id ? null : state.activeId,
      );
    },
    /** Pin a thread whose element is gone to another element (「重新钉到…」). */
    reanchor: (id: string, anchor: Anchor) => patch(id, (t) => ({ ...t, anchor, updatedAt: Date.now() })),
    setAgent: (id: string, agent: Thread["agent"]) => patch(id, (t) => ({ ...t, agent })),
    /** 「结束交接」: replies are ordinary comments again (null is kept, so the unbinding survives a merge with an older copy). */
    endHandoff: (id: string) => patch(id, (t) => ({ ...t, handoff: null, updatedAt: Date.now() })),
    /** Point a message at the session turn that made its change (the server posted the answer; this page knows the turn). */
    linkTurn: (id: string, msgId: string, turnId: string) => setMsg(id, msgId, (m) => ({ ...m, turnId, updatedAt: Date.now() })),
    /** Opens a thread (idempotent — never toggles). */
    open: (id: string) => state.activeId !== id && commit(all, id),
    close: () => state.activeId !== null && commit(all, null),
  };
}

export const isGuestId = (id: string | undefined) => !!id?.startsWith("guest:");

export const useThreads = (store: ThreadStore) => useSyncExternalStore(store.subscribe, store.get);
