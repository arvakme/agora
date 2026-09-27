// How the app's in-memory state maps onto the project's `.agora/` files
// (web/docs/project-storage.md). Pure functions: the client sends what these produce, the
// server formats and stores it.
import type { Message, Thread, ThreadSnapshot } from "../comments/threads";
import type { SerialBatch, Session, Turn } from "../session/store";

export type Person = { id: string; name: string };
export type SessionsState = { sessions: Record<string, Session>; turns: Record<string, Turn>; batches: Record<string, SerialBatch> };

// ——— threads/<canvasId>.json ———
// On disk a human message is `author: "human"` plus `by` (who). In memory the UI still says
// "you" for any human message; `by` tells people apart once more than one person comments.
export type FileMessage = Omit<Message, "author"> & { author: "human" | "agent" | "system" };
export type FileThread = Omit<Thread, "agent" | "messages"> & { messages: FileMessage[]; participants: Person[] };
export type ThreadsFile = { seq: number; threads: FileThread[] };

export function participants(t: Pick<Thread, "messages" | "createdBy">): Person[] {
  const seen = new Map<string, Person>();
  for (const p of [t.createdBy, ...t.messages.map((m) => m.by)]) if (p && !seen.has(p.id)) seen.set(p.id, p);
  return [...seen.values()];
}

export function threadsToFile(s: ThreadSnapshot): ThreadsFile {
  return {
    seq: s.seq,
    threads: s.threads.map(({ agent: _running, ...t }) => ({
      ...t,
      participants: participants(t),
      messages: t.messages.map((m) => ({ ...m, author: m.author === "you" ? "human" : m.author })),
    })),
  };
}

export function threadsFromFile(f: ThreadsFile | null | undefined): ThreadSnapshot | undefined {
  if (!f) return undefined;
  return {
    seq: f.seq ?? 0,
    threads: (f.threads ?? []).map(({ participants: _derived, ...t }) => ({
      ...t,
      agent: "idle" as const,
      messages: t.messages.map((m) => ({ ...m, author: m.author === "human" ? "you" : m.author })),
    })),
  };
}

// ——— sessions/<id>.jsonl ———
// Append-only records; the last `session` header, the last record per turn and per batch win.
export type SessionRecord =
  | { t: "session"; session: Session }
  | { t: "turn"; turn: Turn }
  | { t: "batch"; id: string; batch: SerialBatch };
/** What has already been written for one session (so the next sync appends only changes). */
export type Logged = { header: string; turns: Map<string, string>; batches: Set<string> };

export function sessionRecords(prev: Logged | undefined, s: Session, st: SessionsState): { records: SessionRecord[]; next: Logged } {
  const records: SessionRecord[] = [];
  const next: Logged = { header: JSON.stringify(s), turns: new Map(prev?.turns), batches: new Set(prev?.batches) };
  if (next.header !== prev?.header) records.push({ t: "session", session: s });
  for (const id of s.turnIds) {
    const turn = st.turns[id];
    if (!turn) continue;
    const json = JSON.stringify(turn);
    if (next.turns.get(id) !== json) {
      records.push({ t: "turn", turn });
      next.turns.set(id, json);
    }
    const b = turn.reply?.batchId;
    if (b && st.batches[b] && !next.batches.has(b)) {
      records.push({ t: "batch", id: b, batch: st.batches[b] });
      next.batches.add(b);
    }
  }
  return { records, next };
}

/** Folded sessions from the server snapshot → one in-memory state (plus what counts as written). */
export function foldSessions(files: Record<string, { state: { session: Session | null; turns: Record<string, Turn>; batches: Record<string, SerialBatch> } }>) {
  const st: SessionsState = { sessions: {}, turns: {}, batches: {} };
  for (const f of Object.values(files)) {
    if (!f.state.session) continue;
    st.sessions[f.state.session.id] = f.state.session;
    Object.assign(st.turns, f.state.turns);
    Object.assign(st.batches, f.state.batches);
  }
  const logged = new Map<string, Logged>();
  for (const s of Object.values(st.sessions)) logged.set(s.id, sessionRecords(undefined, s, st).next);
  return { state: st, logged };
}
