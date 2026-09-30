// Debounced saves, one pending value per key, the latest wins (persist.ts writes them to the project).
// A key can be paused: nothing is written for it meanwhile, and what was pending is written at the moment
// it is paused (as the value then is). What is saved while it is paused is deferred, not dropped: on resume
// it is written once, as the value is then (a played turn pauses the workspace's layout this way: its camera
// switches canvas by itself, and that temporary view must not become the project's layout — but a tab the person
// opened meanwhile must still be saved, with the layout the camera has come back to).
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
  /** Paused keys; the value is the latest save made while paused (null: none yet, nothing to write on resume). */
  const paused = new Map<string, (() => unknown) | null>();
  const flush = (key: string) => {
    const v = pending.get(key);
    pending.delete(key);
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (v) write(key, v());
  };
  const drop = (key: string) => {
    if (paused.has(key)) paused.set(key, null);
    clearTimeout(timers.get(key));
    timers.delete(key);
    pending.delete(key);
  };
  return {
    save(key, value, ms = 400) {
      if (paused.has(key)) return void paused.set(key, value);
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
      paused.forEach((_, key) => paused.set(key, null));
    },
    keys: () => [...pending.keys()],
    pause(key) {
      flush(key);
      if (!paused.has(key)) paused.set(key, null);
    },
    resume(key) {
      const v = paused.get(key);
      paused.delete(key);
      if (v) write(key, v());
    },
  };
}
