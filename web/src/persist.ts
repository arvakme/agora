// Local persistence in IndexedDB (one object store, a few keys):
//   "workspace"      → every canvas and session doc (open or closed, with names), layout tree, focus, v: 2
//   "canvas:<id>"    → that canvas's scene elements + its comment threads
//   "sessions"       → sessions, turns (with steps) and undo batches
// Why IndexedDB rather than a JSON file on the dev server: the data is per browser
// profile (a test browser can't overwrite the user's workspace), scenes are large
// structured objects IndexedDB stores without stringifying, and the prototype keeps
// working without the dev server's filesystem. `?eval` runs never read or write it.
const DB = "agora", STORE = "kv";

let dbp: Promise<IDBDatabase> | null = null;
const db = () =>
  (dbp ??= new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  }));

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((ok, fail) => {
    const req = f(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

export const load = <T>(key: string) => tx<T | undefined>("readonly", (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined);
export const remove = (key: string) => tx("readwrite", (s) => s.delete(key)).catch(() => undefined);

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
  if (v) void tx("readwrite", (s) => s.put(v(), key)).catch((e) => console.warn("persist", key, e));
}
/** Drop a pending write and the stored value (a deleted canvas must not be written back by a late save). */
export function discard(key: string) {
  clearTimeout(timers.get(key));
  timers.delete(key);
  pending.delete(key);
  return remove(key);
}
// Don't lose the last edit on reload.
addEventListener("pagehide", () => [...pending.keys()].forEach(flush));

export const PERSIST = !new URLSearchParams(location.search).has("eval") && !new URLSearchParams(location.search).has("fresh");
