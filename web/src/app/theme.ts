// Light / dark: follow the OS by default; the person can force one (design-system.md §10.7).
// The choice is a per-browser convenience in localStorage; it becomes `<html data-theme>`, which
// tokens.css reads. `resolved` is what is on screen, for things that cannot read CSS (Excalidraw's
// `theme` prop and its scene background).
import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "agora.theme";
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let pref: ThemePref = readPref();
let snapshot = { pref, resolved: resolve() };
const listeners = new Set<() => void>();

function resolve(): "light" | "dark" {
  return pref === "system" ? (media?.matches ? "dark" : "light") : pref;
}
function apply() {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  snapshot = { pref, resolved: resolve() };
  // What is on screen, for the few rules that must differ by theme beyond the tokens.
  root.dataset.resolved = snapshot.resolved;
  listeners.forEach((l) => l());
}

export const theme = {
  get: () => snapshot,
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  set(next: ThemePref) {
    pref = next;
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice lasts for this page */
    }
    apply();
  },
  /** system → light → dark → system */
  cycle: () => theme.set(pref === "system" ? "light" : pref === "light" ? "dark" : "system"),
};

if (typeof document !== "undefined") {
  apply();
  media?.addEventListener("change", () => pref === "system" && apply());
}

export const useTheme = () => useSyncExternalStore(theme.subscribe, theme.get);
export const THEME_LABEL: Record<ThemePref, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
