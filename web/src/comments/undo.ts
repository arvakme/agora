// One undo for the last comment deletion, offered in a toast on the canvas it happened on.
// A new deletion replaces the offer; it lapses after a few seconds or once used.
import { useSyncExternalStore } from "react";
import type { Undo } from "./threads";

const LIFETIME_MS = 6000;
let current: (Undo & { key: number }) | null = null;
let timer = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function offerUndo(u: Undo | null) {
  if (!u) return;
  clearTimeout(timer);
  current = { ...u, key: Date.now() };
  timer = window.setTimeout(dismissUndo, LIFETIME_MS);
  emit();
}

export function dismissUndo() {
  clearTimeout(timer);
  if (!current) return;
  current = null;
  emit();
}

export function runUndo() {
  const u = current;
  dismissUndo();
  u?.run();
}

export const useUndo = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => current,
  );
