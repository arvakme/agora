// 回收站 on the page: what the server's `.agora/trash/` holds (server/canvas/trash.py). Deleting a
// canvas or a session moves its files there; restoring moves them back, after a reload too, for
// 30 days. This store lists the items and talks to /api/project/trash; the shell (App.tsx) puts
// restored items back into the workspace.
import { useSyncExternalStore } from "react";
import { deleteCommandOf, type Binding } from "../session/agents";
import type { Doc } from "./model";

export type TrashItem = {
  trashId: string;
  kind: "canvas" | "session";
  id: string;
  at: number;
  title: string;
  /** The workspace.json entry and where its tab was, as the page sent them. */
  entry: Doc | null;
  /** Its place in the list (`docIndex`), and its tab's group and position if it had a tab. */
  place: { groupId?: string; index?: number; docIndex?: number } | null;
  files: { rel: string; name: string }[];
  /** canvas: sessions linked to it (they stay in the workspace); shares ended when it was deleted. */
  linked?: string[];
  sharesEnded?: string[];
  /** session: where its native conversation is (never deleted by Agora). */
  native?: { agent?: string; nativeId?: string; logPath?: string } | null;
  terminalClosed?: boolean;
  expiresAt: number;
  daysLeft: number;
};
export type Restored = {
  item: TrashItem & { originalId: string };
  id: string;
  canvas?: { scene: { elements: unknown[] }; version: string | null; threads: { data: unknown; version: string } | null };
  session?: { state: unknown; version: string } | null;
  binding?: Binding | null;
};

const PERSIST = typeof location !== "undefined" && !new URLSearchParams(location.search).has("eval") && !new URLSearchParams(location.search).has("fresh");
let items: TrashItem[] = [];
const listeners = new Set<() => void>();
const set = (next: TrashItem[]) => {
  items = next;
  listeners.forEach((l) => l());
};

const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`/api/project/trash${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string; detail?: string }).error ?? (j as { detail?: string }).detail ?? `${method} ${path}: ${r.status}`);
  return j as T;
};

export const trash = {
  get: () => items,
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  async refresh() {
    if (!PERSIST) return;
    try {
      set((await call<{ items: TrashItem[] }>("GET", "")).items);
    } catch {
      /* offline: the list is refreshed on the next change */
    }
  },
  /** Move a canvas (with its comments) or a session (with its binding and records) to the trash. */
  async put(kind: TrashItem["kind"], id: string, body: { entry: Doc; place: TrashItem["place"]; title: string }) {
    const m = await call<TrashItem>("POST", `/${kind}/${id}`, body);
    set([m, ...items.filter((x) => x.trashId !== m.trashId)]);
    return m;
  },
  async restore(trashId: string) {
    const r = await call<Restored>("POST", `/${trashId}/restore`);
    set(items.filter((x) => x.trashId !== trashId));
    return r;
  },
  async purge(trashId: string) {
    const r = await call<{ ok: true; native?: TrashItem["native"] }>("DELETE", `/${trashId}`);
    set(items.filter((x) => x.trashId !== trashId));
    return r;
  },
  /** The newest trashed item for a session / canvas id. */
  find: (kind: TrashItem["kind"], id: string) => items.find((x) => x.kind === kind && x.id === id),
};

export const useTrash = () => useSyncExternalStore(trash.subscribe, trash.get);

/** How to remove a session's native conversation yourself (Agora never does). */
export function nativeRemoval(native: TrashItem["native"]): string | null {
  if (!native?.nativeId) return null;
  const cmd = deleteCommandOf(native.agent);
  if (cmd) return cmd.replace("{id}", native.nativeId);
  return native.logPath ? `rm ${native.logPath}` : null;
}
