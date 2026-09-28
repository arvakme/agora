// Every bound session's file writes, folded once per transcript change and shared by the progress
// pointers, conflict notices, stale child canvases and the 工位视图 (docs/multi-agent.md).
import { useSyncExternalStore } from "react";
import { agents, type Item } from "../session/agents";
import { buildTurns, filesOf, type TrajTurn } from "../session/trajectoryModel";
import type { SessionWrites } from "./pointers";

export type SessionFold = { sessionId: string; turns: TrajTurn[]; files: SessionWrites["files"]; running: boolean; lastAt: number };

const cache = new WeakMap<readonly Item[], { running: boolean; fold: SessionFold }>();
let last: { key: unknown; value: SessionFold[] } = { key: null, value: [] };

function fold(): SessionFold[] {
  const st = agents.get();
  if (last.key === st) return last.value;
  const out: SessionFold[] = [];
  for (const [sid, b] of Object.entries(st.bindings)) {
    const items = st.items[sid] ?? [];
    const running = !!(st.status[sid]?.running || st.status[sid]?.busy);
    let hit = cache.get(items);
    if (!hit || hit.running !== running) {
      const turns = buildTurns(items, { model: b.model, effort: b.effort }, running);
      hit = { running, fold: { sessionId: sid, turns, files: filesOf(turns), running, lastAt: 0 } };
      cache.set(items, hit);
    }
    out.push({ ...hit.fold, running, lastAt: st.activeAt[sid] ?? b.createdAt });
  }
  last = { key: st, value: out };
  return out;
}

/** All bound sessions, folded (stable identity while nothing changed). */
export const useSessionFolds = () => useSyncExternalStore(agents.subscribe, fold);
export const sessionFolds = fold;

/** Display names of sessions (the workspace's session titles, set by the app shell). */
let names: Record<string, string> = {};
const nameLs = new Set<() => void>();
export const sessionNames = {
  get: () => names,
  subscribe: (l: () => void) => (nameLs.add(l), () => void nameLs.delete(l)),
  set(next: Record<string, string>) {
    if (JSON.stringify(next) === JSON.stringify(names)) return;
    names = next;
    nameLs.forEach((l) => l());
  },
};
export const useSessionNames = () => useSyncExternalStore(sessionNames.subscribe, sessionNames.get);
