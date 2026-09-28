// Several agent sessions working in one project at once (web/docs/multi-agent.md): one progress
// pointer per active session, grouped per node so they sit side by side, and the writes two
// sessions made to the same file or node within a short window (a possible conflict). Pure.
import { place, type Link, type Placed, type PointerState } from "../pointer/codeLinks";
import type { FileTouch } from "../session/trajectoryModel";

export type SessionWrites = { sessionId: string; files: FileTouch[] };

/** A session counts as active while it runs, or for this long after its last event. */
export const ACTIVE_MS = 30 * 60_000;
/** Two sessions writing the same file / node this close together is a possible conflict. */
export const CONFLICT_WINDOW_MS = 10 * 60_000;
/** A conflict stays on screen this long after its later write. */
export const CONFLICT_SHOW_MS = 60 * 60_000;

/** Which sessions get a pointer: running, recently active, or the one the person follows. */
export function activeSessions(ids: string[], info: (id: string) => { lastAt: number; running: boolean }, now: number, followed?: string | null): string[] {
  return ids.filter((id) => id === followed || info(id).running || now - info(id).lastAt <= ACTIVE_MS);
}

/** Only what happened up to `at` (replay); everything when `at` is null. */
export const until = (files: FileTouch[], at: number | null) => (at == null ? files : files.filter((f) => f.at <= at));

export type SessionPointer = { sessionId: string; state: PointerState };
/** Pointer state per session, against the same links (the canvas's effective links). */
export function sessionPointers(sessions: SessionWrites[], links: Link[], at: number | null = null): SessionPointer[] {
  return sessions.map((s) => ({ sessionId: s.sessionId, state: place(until(s.files, at), links) }));
}

export type NodeStack = { element: string; pointers: { sessionId: string; current: Placed }[] };
/**
 * Pointers that land on the same node share one ring; their labels are laid side by side in a
 * stable order (the followed session first, then by who wrote there most recently).
 */
export function stacks(pointers: SessionPointer[], followed?: string | null): NodeStack[] {
  const by = new Map<string, NodeStack>();
  for (const p of pointers) {
    const cur = p.state.current;
    if (!cur?.element) continue;
    const s = by.get(cur.element) ?? { element: cur.element, pointers: [] };
    s.pointers.push({ sessionId: p.sessionId, current: cur });
    by.set(cur.element, s);
  }
  const rank = (x: { sessionId: string; current: Placed }) => (x.sessionId === followed ? Infinity : x.current.at);
  for (const s of by.values()) s.pointers.sort((a, b) => rank(b) - rank(a) || a.sessionId.localeCompare(b.sessionId));
  return [...by.values()].sort((a, b) => rank(b.pointers[0]) - rank(a.pointers[0]));
}

export type Conflict = {
  kind: "file" | "node";
  /** The file both wrote (kind "file"), or the node both wrote into through different files. */
  path?: string;
  element?: string;
  /** The two sessions, earlier writer first. */
  sessions: [string, string];
  /** The two writes. */
  writes: [FileTouch & { sessionId: string }, FileTouch & { sessionId: string }];
  at: number;
};

/**
 * Pairs of writes by different sessions within `window` of each other, to the same file, or to
 * the same node through different files. One entry per (kind, target, session pair), the latest.
 * Nothing is blocked: this only tells the person.
 */
export function conflicts(sessions: SessionWrites[], links: Link[], opts: { window?: number; now?: number; show?: number; at?: number | null } = {}): Conflict[] {
  const window = opts.window ?? CONFLICT_WINDOW_MS;
  const at = opts.at ?? null;
  const now = at ?? opts.now ?? Infinity;
  const show = opts.show ?? CONFLICT_SHOW_MS;
  const all = sessions
    .flatMap((s) => until(s.files, at).map((f) => ({ ...f, sessionId: s.sessionId })))
    .sort((a, b) => a.at - b.at);
  const elementOf = new Map<string, string | null>();
  const el = (path: string) => {
    if (!elementOf.has(path)) elementOf.set(path, place([{ path, op: "edit", at: 0, toolId: "", turn: 0 }], links).placed[0].element);
    return elementOf.get(path)!;
  };
  const out = new Map<string, Conflict>();
  for (let j = 0; j < all.length; j++)
    for (let i = j - 1; i >= 0 && all[j].at - all[i].at <= window; i--) {
      const a = all[i];
      const b = all[j];
      if (a.sessionId === b.sessionId) continue;
      let c: Omit<Conflict, "sessions" | "writes" | "at"> | null = null;
      if (a.path === b.path) c = { kind: "file", path: a.path, ...(el(a.path) ? { element: el(a.path)! } : {}) };
      else if (el(a.path) && el(a.path) === el(b.path)) c = { kind: "node", element: el(a.path)! };
      if (!c) continue;
      const key = `${c.kind}|${c.path ?? c.element}|${[a.sessionId, b.sessionId].sort().join("|")}`;
      out.set(key, { ...c, sessions: [a.sessionId, b.sessionId], writes: [a, b], at: b.at });
    }
  return [...out.values()].filter((c) => now - c.at <= show).sort((x, y) => y.at - x.at);
}

/** Conflicts one session is part of. */
export const conflictsOf = (all: Conflict[], sessionId: string) => all.filter((c) => c.sessions.includes(sessionId));
