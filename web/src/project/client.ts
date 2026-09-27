// Versioned writes to the project server (/api/project, server/canvas/project_router.py).
//
// Each file (a "slot": "workspace", "canvas:<id>", "threads:<id>", "session:<id>") has the
// version this page last saw. Writes to one slot run one at a time, each carrying that
// version as `base`; the server refuses a stale base with 409 (another tab, an editor or
// git changed the file). The slot is then held: later writes only replace the held one,
// and the UI asks the user to reload or keep this page's version (`resolve`).
// Network failures retry until the server is back.

export type Op =
  | { kind: "put"; path: string; data: unknown }
  | { kind: "append"; path: string; records: unknown[] }
  | { kind: "replace"; path: string; records: unknown[] }
  | { kind: "delete"; path: string };

export type Pending = {
  op: Op;
  /** What "keep mine" writes after a conflict (default: the same op, forced). */
  overwrite?: () => Op;
};

export type Status = { conflicts: string[]; offline: boolean; saving: number };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function createClient({ base = "/api/project", fetchImpl = (u, i) => fetch(u, i), retryMs = 2000 }: { base?: string; fetchImpl?: Fetch; retryMs?: number } = {}) {
  const versions = new Map<string, string | null>();
  const chains = new Map<string, Promise<void>>();
  const held = new Map<string, Pending>();
  let status: Status = { conflicts: [], offline: false, saving: 0 };
  let keepalive = false;
  const listeners = new Set<() => void>();
  const setStatus = (p: Partial<Status>) => {
    status = { ...status, ...p };
    listeners.forEach((l) => l());
  };

  async function send(slot: string, op: Op, force: boolean): Promise<"ok" | "conflict"> {
    const baseVersion = versions.get(slot) ?? null;
    const method = op.kind === "put" || op.kind === "replace" ? "PUT" : op.kind === "append" ? "POST" : "DELETE";
    const body =
      op.kind === "delete" ? undefined : JSON.stringify(op.kind === "put" ? { data: op.data, base: baseVersion, force } : { records: op.records, base: baseVersion, force });
    for (;;) {
      let r: Response;
      try {
        r = await fetchImpl(base + op.path, {
          method,
          body,
          headers: body ? { "content-type": "application/json" } : undefined,
          keepalive: keepalive && (body?.length ?? 0) < 60_000,
        });
      } catch {
        setStatus({ offline: true });
        await new Promise((ok) => setTimeout(ok, retryMs));
        continue;
      }
      if (status.offline) setStatus({ offline: false });
      if (r.status === 409) return "conflict";
      if (!r.ok) throw new Error(`${method} ${op.path}: ${r.status} ${await r.text()}`);
      const j = (await r.json()) as { version?: string };
      versions.set(slot, op.kind === "delete" ? null : (j.version ?? null));
      return "ok";
    }
  }

  function run(slot: string, p: Pending, force = false) {
    const prev = chains.get(slot) ?? Promise.resolve();
    setStatus({ saving: status.saving + 1 });
    const next = prev
      .then(async () => {
        if (!force && held.has(slot)) return void held.set(slot, p); // conflicted: wait for the user
        const res = await send(slot, force && p.overwrite ? p.overwrite() : p.op, force);
        if (res === "conflict") {
          held.set(slot, p);
          if (!status.conflicts.includes(slot)) setStatus({ conflicts: [...status.conflicts, slot] });
        }
      })
      .catch((e) => console.warn("project write", slot, e))
      .finally(() => setStatus({ saving: status.saving - 1 }));
    chains.set(slot, next);
    return next;
  }

  return {
    status: () => status,
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    /** Record the version a file was loaded at (null: known not to exist). */
    seen: (slot: string, version: string | null) => void versions.set(slot, version),
    version: (slot: string) => versions.get(slot),
    write: (slot: string, p: Pending) => run(slot, p),
    /** Settle a conflicted slot: "overwrite" writes this page's latest version over the file. */
    resolve(slot: string, how: "overwrite" | "drop") {
      const p = held.get(slot);
      held.delete(slot);
      setStatus({ conflicts: status.conflicts.filter((s) => s !== slot) });
      if (p && how === "overwrite") return run(slot, p, true);
      return Promise.resolve();
    },
    /** Unloading: let in-flight requests outlive the page where the browser allows. */
    setKeepalive: (on: boolean) => void (keepalive = on),
    idle: () => Promise.all([...chains.values()]).then(() => undefined),
    get: async <T>(path: string): Promise<T> => {
      const r = await fetchImpl(base + path, { method: "GET" });
      if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
      return (await r.json()) as T;
    },
    post: async <T>(path: string, body: unknown): Promise<T> => {
      const r = await fetchImpl(base + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as T;
    },
  };
}

export type ProjectClient = ReturnType<typeof createClient>;
