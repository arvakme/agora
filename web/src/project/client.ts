// Versioned writes to the project server (/api/project, server/canvas/project_router.py).
//
// Each file (a "slot": "workspace", "canvas:<id>", "threads:<id>", "session:<id>") has the
// version this page last saw. Writes to one slot run one at a time, each carrying that
// version as `base`; the server refuses a stale base with 409 (another tab, an editor or
// git changed the file). The slot is then held: later writes only replace the held one,
// and the UI asks the user to reload or keep this page's version (`resolve`).
// Network failures retry until the server is back. Any other refusal (disk full, no
// permission, the project directory moved away: 410) is not swallowed: the slot is held the
// same way, listed in `failed` with the server's reason, and `retry` sends the latest held
// write (as a full write, so appends lost with the failed request are not skipped).
// A slot can also be `block`ed (its file on disk is unreadable, e.g. a merge conflict):
// nothing is written to it until the page is reloaded.

export type Op =
  | { kind: "put"; path: string; data: unknown }
  | { kind: "append"; path: string; records: unknown[] }
  | { kind: "replace"; path: string; records: unknown[] }
  | { kind: "delete"; path: string }
  /** Server-side merge (threads: the owner's page and share guests write the same file). Never conflicts. */
  | { kind: "merge"; path: string; data: unknown };

export type Pending = {
  op: Op;
  /** What "keep mine" writes after a conflict (default: the same op, forced). */
  overwrite?: () => Op;
};

/** A write the server refused (not a conflict): why, and whether the project directory is gone (410). */
export type Failure = { slot: string; message: string; status: number; gone: boolean; file?: string };
/** A slot this page must not write (its file is unreadable), with the reason shown to the user. */
export type Blocked = { slot: string; reason: string };
export type Status = { conflicts: string[]; offline: boolean; saving: number; failed: Failure[]; blocked: Blocked[] };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function createClient({ base = "/api/project", fetchImpl = (u, i) => fetch(u, i), retryMs = 2000 }: { base?: string; fetchImpl?: Fetch; retryMs?: number } = {}) {
  const versions = new Map<string, string | null>();
  const chains = new Map<string, Promise<void>>();
  const held = new Map<string, Pending>();
  const blocked = new Map<string, string>();
  let status: Status = { conflicts: [], offline: false, saving: 0, failed: [], blocked: [] };
  let keepalive = false;
  const listeners = new Set<() => void>();
  const setStatus = (p: Partial<Status>) => {
    status = { ...status, ...p };
    listeners.forEach((l) => l());
  };

  async function send(slot: string, op: Op, force: boolean): Promise<"ok" | "conflict" | Failure> {
    const baseVersion = versions.get(slot) ?? null;
    const method = op.kind === "put" || op.kind === "replace" ? "PUT" : op.kind === "append" || op.kind === "merge" ? "POST" : "DELETE";
    const body =
      op.kind === "delete"
        ? undefined
        : JSON.stringify(op.kind === "merge" ? { data: op.data } : op.kind === "put" ? { data: op.data, base: baseVersion, force } : { records: op.records, base: baseVersion, force });
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
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        let body: { error?: string; detail?: string; file?: string } = {};
        try {
          body = JSON.parse(text);
        } catch {
          /* plain text */
        }
        const message = body.error ?? (typeof body.detail === "string" ? body.detail : "") ?? "";
        return { slot, status: r.status, gone: r.status === 410, file: body.file, message: message || `${method} ${op.path}: ${r.status} ${text.slice(0, 200)}` };
      }
      const j = (await r.json()) as { version?: string };
      versions.set(slot, op.kind === "delete" ? null : (j.version ?? null));
      return "ok";
    }
  }

  /** `force`: overwrite a conflicted file. `full`: send the full write (`overwrite`) without forcing (a retry). */
  function run(slot: string, p: Pending, force = false, full = force) {
    const prev = chains.get(slot) ?? Promise.resolve();
    setStatus({ saving: status.saving + 1 });
    const next = prev
      .then(async () => {
        if (blocked.has(slot)) return void held.set(slot, p); // unreadable on disk: never written from here
        if (!force && !full && held.has(slot)) return void held.set(slot, p); // conflicted or failed: wait for the user
        const res = await send(slot, full && p.overwrite ? p.overwrite() : p.op, force);
        if (res === "conflict") {
          held.set(slot, p);
          if (!status.conflicts.includes(slot)) setStatus({ conflicts: [...status.conflicts, slot] });
        } else if (res !== "ok") {
          held.set(slot, p);
          setStatus({ failed: [...status.failed.filter((f) => f.slot !== slot), res] });
        } else if (status.failed.some((f) => f.slot === slot)) setStatus({ failed: status.failed.filter((f) => f.slot !== slot) });
      })
      .catch((e) => {
        // Not the server's answer (a bug on this page): still keep the write and say so.
        held.set(slot, p);
        setStatus({ failed: [...status.failed.filter((f) => f.slot !== slot), { slot, status: 0, gone: false, message: String(e) }] });
      })
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
    /** Send the held write of every failed slot again (or only `slot`). */
    retry(slot?: string) {
      const slots = status.failed.map((f) => f.slot).filter((s) => !slot || s === slot);
      setStatus({ failed: status.failed.filter((f) => !slots.includes(f.slot)) });
      return Promise.all(
        slots.map((s) => {
          const p = held.get(s);
          held.delete(s);
          return p ? run(s, p, false, true) : Promise.resolve();
        }),
      ).then(() => undefined);
    },
    /** Never write this slot from this page (its file on disk is unreadable). */
    block(slot: string, reason: string) {
      blocked.set(slot, reason);
      setStatus({ blocked: [...status.blocked.filter((b) => b.slot !== slot), { slot, reason }] });
    },
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
