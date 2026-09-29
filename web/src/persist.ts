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
import { createSaveQueue } from "./saveQueue";
import { layoutSaves } from "./layoutSaves";
import { trash, type Restored } from "./workspace/trash";
import { threadStores, type ThreadSnapshot } from "./comments/threads";
import type { El } from "./canvas/scene";
import type { Binding } from "./session/agents";

export const PERSIST = !new URLSearchParams(location.search).has("eval") && !new URLSearchParams(location.search).has("fresh");

let onRefusedEmpty: (canvasId: string) => void = () => {};
/** The shell's answer to "the server refused this page's empty scene": load the server's canvas again. */
export const onCanvasRefused = (f: (canvasId: string) => void) => void (onRefusedEmpty = f);

export const project = createClient({ onRefusedEmpty: (slot) => slot.startsWith("canvas:") && onRefusedEmpty(slot.slice("canvas:".length)) });

export type ProjectInfo = { id: string; name: string; root: string; me: Person };
type Versioned<T> = { data: T; version: string };
/** A project file the server could not read (server/canvas/project.py `file_error`, `_read_checked`). */
export type FileError = { file: string; error: "merge-conflict" | "invalid-json" | "unreadable"; line?: number | null; detail?: string; kind?: string; id?: string | null };
/** What changed about this copy of the project since the page last looked (server/canvas/local.py `reconcile`). */
export type LocalChange = {
  kind: "fresh" | "reattached" | "moved" | "copied";
  from?: string;
  at: number;
  migrated?: { sessionId: string; nativeId: string; path: string }[];
  failed?: { sessionId: string; nativeId: string; error: string; fallback?: string }[];
  sessions?: string[];
};
/**
 * A listed session that cannot simply be resumed here (server/canvas/local.py `session_origins`):
 * `copy` came along with `cp -r` (read-only until forked), `recoverable` has its binding in this
 * machine's registry, `other-copy` belongs to another copy on this machine, `foreign` was made elsewhere.
 */
export type Origin = {
  state: "copy" | "recoverable" | "other-copy" | "foreign";
  agent?: string;
  model?: string;
  effort?: string;
  nativeId?: string | null;
  started?: boolean;
  canvasId?: string;
  topic?: string;
  root?: string;
  from?: string;
  log?: string | null;
};
type Snapshot = ProjectInfo & {
  /** Nothing in the project yet (no workspace.json, no canvas file): the first run may write the sample. */
  empty: boolean;
  errors?: FileError[];
  workspace: Versioned<unknown> | null;
  canvases: Record<string, { scene: { elements: El[] }; version: string; threads: Versioned<ThreadsFile> | null }>;
  sessions: Parameters<typeof foldSessions>[0] & Record<string, { version: string }>;
  /** Agent bindings (sessions/<id>.agent.json), written by the server only. */
  bindings?: Record<string, Binding>;
  local?: { instanceId: string; change: LocalChange | null };
  origins?: Record<string, Origin>;
};
export type Loaded = {
  project: ProjectInfo;
  empty: boolean;
  errors: FileError[];
  workspace?: unknown;
  canvases: Record<string, { elements: El[]; threads?: ThreadSnapshot }>;
  sessions: SessionsState;
  bindings: Record<string, Binding>;
  imported: boolean;
  change: LocalChange | null;
  origins: Record<string, Origin>;
};

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

  // Unreadable files (a merge conflict, invalid JSON) are left out of the snapshot; this page must
  // not write over them: their slots are blocked until the file is fixed and the page reloaded.
  const errors = snap.errors ?? [];
  for (const e of errors) {
    const slot = slotOfFile(e.file);
    if (slot) project.block(slot, describeFileError(e));
  }
  project.seen("workspace", snap.workspace?.version ?? null);
  if (snap.workspace) project.remember("workspace", JSON.stringify(snap.workspace.data));
  const canvases: Loaded["canvases"] = {};
  for (const [id, c] of Object.entries(snap.canvases)) {
    project.seen(`canvas:${id}`, c.version);
    project.seen(`threads:${id}`, c.threads?.version ?? null);
    const threads = threadsFromFile(c.threads?.data);
    canvases[id] = { elements: c.scene.elements ?? [], threads };
    project.remember(`canvas:${id}`, JSON.stringify(canvases[id].elements));
    if (threads) project.remember(`threads:${id}`, JSON.stringify(threadsToFile(threads)));
  }
  for (const [id, s] of Object.entries(snap.sessions)) project.seen(`session:${id}`, s.version);
  const folded = foldSessions(snap.sessions);
  folded.logged.forEach((l, id) => logged.set(id, l));
  latestSessions = folded.state;
  return {
    project: { id: snap.id, name: snap.name, root: snap.root, me: snap.me },
    empty: snap.empty,
    errors,
    workspace: snap.workspace?.data,
    canvases,
    sessions: folded.state,
    bindings: snap.bindings ?? {},
    imported,
    change: snap.local?.change ?? null,
    origins: snap.origins ?? {},
  };
}

/**
 * A canvas as the server holds it now. Every mount of the shell loads this before it may save the
 * canvas: it is the scene the editor shows and the version (`base`) the next save carries.
 * Null: the server has no file for it (yet).
 */
export async function loadCanvas(id: string): Promise<{ elements: El[]; version: string } | null> {
  const r = await fetch(`/api/project/canvases/${encodeURIComponent(id)}`);
  if (r.status === 404) {
    project.seen(`canvas:${id}`, null);
    return null;
  }
  if (!r.ok) throw new Error(`GET /canvases/${id}: ${r.status}`);
  const c = (await r.json()) as { scene: { elements?: El[] }; version: string };
  const elements = c.scene.elements ?? [];
  project.seen(`canvas:${id}`, c.version);
  project.remember(`canvas:${id}`, JSON.stringify(elements));
  return { elements, version: c.version };
}

/** The move / copy / clone notice was shown: the server forgets it. */
export const ackChange = () => project.post("/local/ack", {}).catch(() => undefined);

const putIfChanged = (slot: string, path: string, data: unknown, compare: string = JSON.stringify(data), clear = false) =>
  void project.writeIfChanged(slot, compare, { kind: "put", path, data, ...(clear ? { clear } : {}) });
/** Threads are merged on the server, not overwritten: share guests write the same file. */
const mergeIfChanged = (slot: string, path: string, data: unknown) => void project.writeIfChanged(slot, JSON.stringify(data), { kind: "merge", path, data });

/** Someone else's comments (share guests) arrive from the server as the merged file. */
export function followProject(onShares?: () => void) {
  if (!PERSIST) return () => {};
  const es = new EventSource("/api/project/events");
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data) as { t: string; canvasId?: string; data?: ThreadsFile; version?: string };
    if (ev.t === "shares") return onShares?.();
    if (ev.t === "trash") return void trash.refresh();
    if (ev.t !== "threads" || !ev.canvasId || !ev.data) return;
    const store = threadStores.get(ev.canvasId);
    const snap = threadsFromFile(ev.data);
    if (!store || !snap) return;
    if (store.merge(snap)) project.remember(`threads:${ev.canvasId}`, JSON.stringify(threadsToFile(store.snapshot())));
    if (ev.version) project.seen(`threads:${ev.canvasId}`, ev.version);
  };
  return () => es.close();
}

function syncSessions(st: SessionsState) {
  latestSessions = st;
  // A session gone from the page went to the trash (the server moved its files): nothing to write.
  for (const id of [...logged.keys()])
    if (!st.sessions[id]) {
      logged.delete(id);
      project.forget(`session:${id}`);
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
    if (!v) return; // this mount has not loaded the canvas: nothing to save
    const id = key.slice("canvas:".length);
    const { elements, threads, clear } = v as { elements: El[]; threads?: ThreadSnapshot; clear?: boolean };
    putIfChanged(`canvas:${id}`, `/canvases/${id}`, { elements }, JSON.stringify(elements), clear);
    // No comments and no file yet: don't create an empty threads file.
    if (threads && (threads.threads.length || project.version(`threads:${id}`) != null))
      mergeIfChanged(`threads:${id}`, `/threads/${id}/merge`, threadsToFile(threads));
    return;
  }
  console.warn("persist: unknown key", key);
}

/** Debounced writes per key; the latest value wins (./saveQueue.ts). */
const queue = createSaveQueue(write);
export const save = queue.save;
/** Send every debounced save now and wait until all writes are through (before moving files to the trash). */
export async function flushSaves() {
  queue.flushAll();
  await project.idle();
}
/** The workspace layout is not saved while a PR replay plays (its camera's canvas switches are its own temporary view); what was pending goes first. */
export const pauseLayoutSaves = (on: boolean) => (on ? queue.pause("workspace") : queue.resume("workspace"));
layoutSaves.register(pauseLayoutSaves);

/**
 * A canvas went to the trash: no late save may write it back, and its files are gone from `canvases/`.
 * Returns how to undo that if the server did not move it after all (the versions this page had seen).
 */
export function dropCanvas(id: string): () => void {
  queue.drop(`canvas:${id}`);
  const slots = [`canvas:${id}`, `threads:${id}`];
  const had = slots.map((slot) => project.version(slot) ?? null);
  for (const slot of slots) {
    project.forget(slot);
    project.seen(slot, null);
  }
  return () => slots.forEach((slot, i) => project.seen(slot, had[i]));
}

/** A canvas came back from the trash: this page knows its files again (the next save is not a conflict). */
export function adoptCanvas(id: string, c: NonNullable<Restored["canvas"]>): { elements: El[]; threads?: ThreadSnapshot } {
  const elements = (c.scene.elements ?? []) as El[];
  const threads = threadsFromFile(c.threads?.data as ThreadsFile | undefined);
  project.seen(`canvas:${id}`, c.version);
  project.seen(`threads:${id}`, c.threads?.version ?? null);
  project.remember(`canvas:${id}`, JSON.stringify(elements));
  if (threads) project.remember(`threads:${id}`, JSON.stringify(threadsToFile(threads)));
  return { elements, threads };
}

/** A session came back from the trash: its record as the page's session state, and what its log holds. */
export function adoptSession(id: string, s: NonNullable<Restored["session"]>): SessionsState {
  const folded = foldSessions({ [id]: s } as Parameters<typeof foldSessions>[0]);
  const l = folded.logged.get(id);
  if (l) logged.set(id, l);
  project.seen(`session:${id}`, s.version);
  return folded.state;
}

/** A file under .agora/ → the slot that writes it (undefined: not one this page writes). */
export function slotOfFile(file: string): string | undefined {
  if (file === "workspace.json") return "workspace";
  const m = /^(canvases|threads|sessions)\/(.+)\.(excalidraw|json|jsonl)$/.exec(file);
  if (!m) return undefined;
  return `${m[1] === "canvases" ? "canvas" : m[1] === "threads" ? "threads" : "session"}:${m[2]}`;
}

/** One line for the banner: which file, what is wrong, where. */
export function describeFileError(e: FileError): string {
  const where = e.line ? `第 ${e.line} 行` : "";
  if (e.error === "unreadable") return `.agora/${e.file} 读不了（${e.detail ?? "没有权限"}）`;
  return e.error === "merge-conflict" ? `.agora/${e.file} 有合并冲突（${where || "冲突标记"}）` : `.agora/${e.file} 不是有效的 JSON${where ? `（${where}）` : ""}`;
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
  queue.clear();
  location.reload();
}

// Don't lose the last edit on reload.
addEventListener("pagehide", () => {
  if (reloading || !PERSIST) return;
  project.setKeepalive(true);
  queue.flushAll();
});
