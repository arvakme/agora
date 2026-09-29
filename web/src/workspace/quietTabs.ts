// Canvases opened only for an agent (`ui.ensureCanvas`, app/App.tsx): their tab joins quietly (./model.ts `placeQuiet`) and goes again when nothing needs it.
// What "nothing needs it" means, in one place: no call is using it (a lease is held from before the call opens it to after it is done — an edit waiting for an
// asset for a minute keeps its canvas), it has been idle for QUIET_MS since the last lease was let go, and the person has not taken it (opened, focused, brought
// to the front: `own`, at that moment — not looked for later). Pure but for the map it holds.

/** A canvas opened only for an agent is closed again after this long unused. */
export const QUIET_MS = 8000;

type Entry = { leases: number; quiet: boolean; idleAt: number };

export function createQuietTabs(ms = QUIET_MS) {
  const m = new Map<string, Entry>();
  const entry = (id: string, now: number): Entry => m.get(id) ?? (m.set(id, { leases: 0, quiet: false, idleAt: now }), m.get(id)!);
  return {
    /** A call is going to use this canvas: it is not closed until the returned function is called (once; more calls can overlap). */
    hold(id: string, now: () => number): () => void {
      entry(id, now()).leases++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const e = m.get(id);
        if (!e) return;
        e.leases = Math.max(0, e.leases - 1);
        if (!e.leases) e.idleAt = now();
        if (!e.leases && !e.quiet) m.delete(id);
      };
    },
    /** The executor opened it (no tab of the person's): from now it is ours to close. */
    opened(id: string, now: number) {
      const e = entry(id, now);
      e.quiet = true;
      e.idleAt = now;
    },
    /** The person took it (opened it, focused it, it came to the front): it is theirs, for good. */
    own(id: string) {
      const e = m.get(id);
      if (!e) return;
      e.quiet = false;
      if (!e.leases) m.delete(id);
    },
    isQuiet: (id: string) => !!m.get(id)?.quiet,
    /** The canvases whose tabs are ours (not to be saved into the person's layout). */
    quiet: (): Set<string> => new Set([...m].filter(([, e]) => e.quiet).map(([id]) => id)),
    /** The canvases to close now: ours, no call using them, idle for `ms`. */
    due(now: number): string[] {
      const out: string[] = [];
      for (const [id, e] of m) if (e.quiet && !e.leases && now - e.idleAt >= ms) out.push(id);
      for (const id of out) m.delete(id);
      return out;
    },
  };
}
