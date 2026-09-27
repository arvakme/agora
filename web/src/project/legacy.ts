// The browser-only store used before projects (IndexedDB "agora", v2 format; see git history
// of persist.ts). Read once to import into an empty project; never written again.
const DB = "agora", STORE = "kv";
const MARK = "agora.legacyImported";

export type LegacyData = {
  workspace: { v?: number; docs: { id: string; kind: string }[] } & Record<string, unknown>;
  canvases: Record<string, { elements: unknown[]; threads?: unknown }>;
  sessions?: unknown;
};

async function openExisting(): Promise<IDBDatabase | null> {
  // Don't create the database just to find it empty.
  if (typeof indexedDB === "undefined") return null;
  if (indexedDB.databases && !(await indexedDB.databases()).some((d) => d.name === DB)) return null;
  return new Promise((ok) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ok(null);
  });
}

function get<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((ok) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => ok(req.result as T | undefined);
      req.onerror = () => ok(undefined);
    } catch {
      ok(undefined);
    }
  });
}

/** The old workspace, if this browser has one and it hasn't been imported yet. */
export async function readLegacy(): Promise<LegacyData | null> {
  try {
    if (localStorage.getItem(MARK)) return null;
  } catch {}
  const db = await openExisting();
  if (!db) return null;
  try {
    const workspace = await get<LegacyData["workspace"]>(db, "workspace");
    if (!workspace?.docs?.length) return null;
    const canvases: LegacyData["canvases"] = {};
    for (const d of workspace.docs) {
      if (d.kind !== "canvas") continue;
      const c = await get<LegacyData["canvases"][string]>(db, `canvas:${d.id}`);
      if (c) canvases[d.id] = c;
    }
    return { workspace, canvases, sessions: await get(db, "sessions") };
  } finally {
    db.close();
  }
}

/** Remember that this browser's old data went into a project (the IndexedDB copy is left as is). */
export function markImported(project: { id: string; root: string }) {
  try {
    localStorage.setItem(MARK, JSON.stringify({ project: project.id, root: project.root, at: new Date().toISOString() }));
  } catch {}
}
