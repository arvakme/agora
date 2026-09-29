// Debounced saves, one pending value per key, the latest wins (persist.ts writes them to the project).
// A key can be paused: nothing is written for it meanwhile, and what was pending is written at the moment
// it is paused (as the value then is). A PR replay pauses the workspace's layout this way: its camera
// switches canvas by itself, and that temporary view must not become the project's layout.
export type SaveQueue = {
  save: (key: string, value: () => unknown, ms?: number) => void;
  flush: (key: string) => void;
  flushAll: () => void;
  /** Forget a pending save (a canvas that went to the trash). */
  drop: (key: string) => void;
  /** Forget all pending saves. */
  clear: () => void;
  keys: () => string[];
  pause: (key: string) => void;
  resume: (key: string) => void;
};

export function createSaveQueue(write: (key: string, v: unknown) => void): SaveQueue {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, () => unknown>();
  const paused = new Set<string>();
  const flush = (key: string) => {
    const v = pending.get(key);
    pending.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (v) write(key, v());
  };
  const drop = (key: string) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    pending.delete(key);
  };
  return {
    save(key, value, ms = 400) {
      if (paused.has(key)) return;
      pending.set(key, value);
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => flush(key), ms));
    },
    flush,
    flushAll: () => [...pending.keys()].forEach(flush),
    drop,
    clear() {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      pending.clear();
    },
    keys: () => [...pending.keys()],
    pause(key) {
      flush(key);
      paused.add(key);
    },
    resume: (key) => void paused.delete(key),
  };
}
