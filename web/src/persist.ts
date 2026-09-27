// Persistence goes to the project's `.agora/` through its server (`agora up`; format in
// docs/project-storage.md). The app keeps saving by key, as before:
//   "workspace"    → .agora/workspace.json         (canvas and session docs incl. closed, tabs, split layout)
//   "canvas:<id>"  → .agora/canvases/<id>.excalidraw + .agora/threads/<id>.json
//   "sessions"     → .agora/sessions/<sessionId>.jsonl (only new or changed records are appended)
// The browser keeps no project data; the one exception is the one-time import of the old
// IndexedDB workspace into an empty project (project/legacy.ts). `?eval` and `?fresh` runs
// neither read nor write.
import { createClient } from "./project/client";
import { foldSessions, sessionRecords, threadsFromFile, threadsToFile, type Logged, type Person, type SessionsState, type ThreadsFile } from "./project/format";
import { markImported, readLegacy } from "./project/legacy";
import type { ThreadSnapshot } from "./comments/threads";
import type { El } from "./canvas/scene";

export const PERSIST = !new URLSearchParams(location.search).has("eval") && !new URLSearchParams(location.search).has("fresh");

export const project = createClient();

export type ProjectInfo = { id: string; name: string; root: string; me: Person };
type Versioned<T> = { data: T; version: string };
type Snapshot = ProjectInfo & {
  empty: boolean;
  workspace: Versioned<unknown> | null;
  canvases: Record<string, { scene: { elements: El[] }; version: string; threads: Versioned<ThreadsFile> | null }>;
  sessions: Parameters<typeof foldSessions>[0] & Record<string, { version: string }>;
};
export type Loaded = {
  project: ProjectInfo;
  workspace?: unknown;
  canvases: Record<string, { elements: El[]; threads?: ThreadSnapshot }>;
  sessions: SessionsState;
  imported: boolean;
};

/** Last body written (or loaded) per slot: unchanged saves send nothing. */
const written = new Map<string, string>();
/** Per session: what its log already holds. */
const logged = new Map<string, Logged>();
let latestSessions: SessionsState = { sessions: {}, turns: {}, batches: {} };

/** Load the project (importing this browser's old workspace into an empty project once). */
export async function connect(): Promise<Loaded> {
  let snap = await project.get<Snapshot>("/snapshot");
  let imported = false;
  if (snap.empty) {
    const legacy = await readLegacy();
    if (legacy && (legacy.workspace.v === 2 || legacy.workspace.docs.some((d) => d.kind === "session"))) {
      const me = snap.me;
      const withAuthor = (t: ThreadSnapshot): ThreadSnapshot => ({
        ...t,
        threads: t.threads.map((th) => ({ ...th, messages: th.messages.map((m) => (m.author === "you" && !m.by ? { ...m, by: me } : m)) })),
      });
      const st = (legacy.sessions ?? { sessions: {}, turns: {}, batches: {} }) as SessionsState;
      snap = await project.post<Snapshot>("/import", {
        workspace: legacy.workspace,
        canvases: Object.fromEntries(
          Object.entries(legacy.canvases).map(([id, c]) => [id, { scene: { elements: c.elements }, threads: c.threads ? threadsToFile(withAuthor(c.threads as ThreadSnapshot)) : null }]),
        ),
        sessions: Object.fromEntries(Object.values(st.sessions).map((s) => [s.id, sessionRecords(undefined, s, st).records])),
      });
      markImported(snap);
      imported = true;
    }
  }

  project.seen("workspace", snap.workspace?.version ?? null);
  if (snap.workspace) written.set("workspace", JSON.stringify(snap.workspace.data));
  const canvases: Loaded["canvases"] = {};
  for (const [id, c] of Object.entries(snap.canvases)) {
    project.seen(`canvas:${id}`, c.version);
    project.seen(`threads:${id}`, c.threads?.version ?? null);
    const threads = threadsFromFile(c.threads?.data);
    canvases[id] = { elements: c.scene.elements ?? [], threads };
    written.set(`canvas:${id}`, JSON.stringify(canvases[id].elements));
    if (threads) written.set(`threads:${id}`, JSON.stringify(threadsToFile(threads)));
  }
  for (const [id, s] of Object.entries(snap.sessions)) project.seen(`session:${id}`, s.version);
  const folded = foldSessions(snap.sessions);
  folded.logged.forEach((l, id) => logged.set(id, l));
  latestSessions = folded.state;
  return {
    project: { id: snap.id, name: snap.name, root: snap.root, me: snap.me },
    workspace: snap.workspace?.data,
    canvases,
    sessions: folded.state,
    imported,
  };
}

function putIfChanged(slot: string, path: string, data: unknown, compare: string = JSON.stringify(data)) {
  if (written.get(slot) === compare) return;
  written.set(slot, compare);
  void project.write(slot, { op: { kind: "put", path, data } });
}

function syncSessions(st: SessionsState) {
  latestSessions = st;
  for (const id of [...logged.keys()])
    if (!st.sessions[id]) {
      logged.delete(id);
      void project.write(`session:${id}`, { op: { kind: "delete", path: `/sessions/${id}` } });
    }
  for (const s of Object.values(st.sessions)) {
    const prev = logged.get(s.id);
    const { records, next } = sessionRecords(prev, s, st);
    logged.set(s.id, next);
    if (!records.length) continue;
    const full = () => {
      const cur = latestSessions.sessions[s.id] ?? s;
      return { kind: "replace" as const, path: `/sessions/${s.id}`, records: sessionRecords(undefined, cur, latestSessions).records };
    };
    void project.write(`session:${s.id}`, {
      op: prev ? { kind: "append", path: `/sessions/${s.id}/append`, records } : { kind: "replace", path: `/sessions/${s.id}`, records },
      overwrite: full,
    });
  }
}

function write(key: string, v: unknown) {
  if (key === "workspace") return putIfChanged("workspace", "/workspace", v);
  if (key === "sessions") return syncSessions(v as SessionsState);
  if (key.startsWith("canvas:")) {
    const id = key.slice("canvas:".length);
    const { elements, threads } = v as { elements: El[]; threads?: ThreadSnapshot };
    putIfChanged(`canvas:${id}`, `/canvases/${id}`, { elements }, JSON.stringify(elements));
    // No comments and no file yet: don't create an empty threads file.
    if (threads && (threads.threads.length || project.version(`threads:${id}`) != null))
      putIfChanged(`threads:${id}`, `/threads/${id}`, threadsToFile(threads));
    return;
  }
  console.warn("persist: unknown key", key);
}

/** Debounced writes per key; the latest value wins. */
const timers = new Map<string, number>();
const pending = new Map<string, () => unknown>();
export function save(key: string, value: () => unknown, ms = 400) {
  pending.set(key, value);
  clearTimeout(timers.get(key));
  timers.set(key, window.setTimeout(() => flush(key), ms));
}
function flush(key: string) {
  const v = pending.get(key);
  pending.delete(key);
  timers.delete(key);
  if (v) write(key, v());
}
/** Drop a pending write and the stored files (a deleted canvas must not be written back by a late save). */
export function discard(key: string) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  pending.delete(key);
  if (!key.startsWith("canvas:")) return Promise.resolve();
  const id = key.slice("canvas:".length);
  written.delete(`canvas:${id}`);
  written.delete(`threads:${id}`);
  return project.write(`canvas:${id}`, { op: { kind: "delete", path: `/canvases/${id}` } }).then(() => project.seen(`threads:${id}`, null));
}

/** A conflicted slot → the file it names, for the banner. */
export const slotFile = (slot: string) => {
  const [kind, id] = slot.split(":");
  return kind === "workspace" ? "workspace.json" : kind === "canvas" ? `canvases/${id}.excalidraw` : kind === "threads" ? `threads/${id}.json` : `sessions/${id}.jsonl`;
};

let reloading = false;
/** Take the disk version: reload without flushing this page's unsaved edits. */
export function reloadFromDisk() {
  reloading = true;
  timers.forEach((t) => clearTimeout(t));
  pending.clear();
  location.reload();
}

// Don't lose the last edit on reload.
addEventListener("pagehide", () => {
  if (reloading || !PERSIST) return;
  project.setKeepalive(true);
  [...pending.keys()].forEach(flush);
});
