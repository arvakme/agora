// Per-browser view preferences behind the top bar's ⋯ menu (web/docs/workbench-focus.md):
//   showResolved — resolved comment threads drawn on the canvas as quiet pins (off by default);
//   hints        — Excalidraw's hint line under the toolbar outside first run / empty canvases;
//   footprints   — 工位视图: faint footprints where workers stood and wrote (on by default; trial,
//                  web/docs/workstation.md「新想法」);
//   followCamera — 工位视图: the canvas's camera follows the main agent (on by default; the person's own
//                  pausing of it is not kept, web/docs/workstation.md §10 默认跟随);
//   autoFollowTab — 工位视图: the follow tab opens by itself when an agent goes into a sub-diagram (off by default:
//                  the page pops nothing up but what waits for you; 「跟随」 opens it on request);
//   notifyWait   — a system notification when an agent starts waiting on you while the page is
//                  hidden (off by default; turning it on asks the browser; trial, same section).
// A convenience kept in localStorage (the page works without it); shared by the owner's page and
// share guests.
import { useSyncExternalStore } from "react";

export type Prefs = { showResolved: boolean; hints: boolean; footprints: boolean; followCamera: boolean; autoFollowTab: boolean; notifyWait: boolean };
const KEY = "agora.view";
function read(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return { showResolved: !!v.showResolved, hints: !!v.hints, footprints: v.footprints !== false, followCamera: v.followCamera !== false, autoFollowTab: v.autoFollowTab === true, notifyWait: !!v.notifyWait };
  } catch {
    return { showResolved: false, hints: false, footprints: true, followCamera: true, autoFollowTab: false, notifyWait: false };
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
