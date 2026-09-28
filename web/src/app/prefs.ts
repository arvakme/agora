// Per-browser view preferences behind the top bar's ⋯ menu (web/docs/workbench-focus.md):
//   showResolved — resolved comment threads drawn on the canvas as quiet pins (off by default);
//   hints        — Excalidraw's hint line under the toolbar outside first run / empty canvases.
// A convenience kept in localStorage (the page works without it); shared by the owner's page and
// share guests.
import { useSyncExternalStore } from "react";

export type Prefs = { showResolved: boolean; hints: boolean };
const KEY = "agora.view";
function read(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return { showResolved: !!v.showResolved, hints: !!v.hints };
  } catch {
    return { showResolved: false, hints: false };
  }
}
let state = read();
const ls = new Set<() => void>();
export const prefs = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  set(p: Partial<Prefs>) {
    state = { ...state, ...p };
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private window: this page only */
    }
    ls.forEach((l) => l());
  },
};
export const usePrefs = () => useSyncExternalStore(prefs.subscribe, prefs.get);
