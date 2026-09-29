// The live camera (web/docs/workstation.md §10 默认跟随): the follow camera of a played turn (./replayView.ts), in everyday use.
// By default the main view follows the main agent — the top-level run of the session the person is
// conversing with, else the one most recently at work — close up, into and out of sub-diagrams, and
// stands still while it is idle. The person's own doing pauses it (a button 「跟随 <agent>」 hands it back);
// the switch 「镜头跟随主 agent」 in ⋯ (app/prefs.ts) turns it off. A played turn (./replayMode.ts) has the
// camera before it, and a traced agent before the main agent (./liveCamera.ts). Where the camera takes the
// canvas by itself nothing is saved and no history is made (./replayQuiet.ts, ./replayHistory.ts).
import { useSyncExternalStore } from "react";
import { prefs } from "../app/prefs";
import { pointerFollow } from "../pointer/follow";
import { openSessions } from "../session/ui";
import { clock } from "./clock";
import { focus } from "./focus";
import { pickFollow, type Pick } from "./liveCamera";
import { canvasWhere } from "./place";
import { beforePlay, plays } from "./replayMode";
import { quiet } from "./replayQuiet";
import { createCamera } from "./replayView";
import { runs } from "./runs/store";
import type { WorkRun } from "./runs/types";

export type Live = {
  /** The run the camera follows now (null: switched off, replaying, or nobody). */
  run: string | null;
  name: string;
  why: Pick["why"] | null;
  /** The person has taken the camera: it does not follow until 「跟随 <agent>」. Not kept over a refresh. */
  paused: boolean;
};

let state: Live = { run: null, name: "", why: null, paused: false };
const ls = new Set<() => void>();
const set = (p: Partial<Live>) => {
  const next = { ...state, ...p };
  if ((Object.keys(p) as (keyof Live)[]).every((k) => next[k] === state[k])) return;
  state = next;
  ls.forEach((l) => l());
};

/** The live camera has no window: it is "now". */
const NOW = { start: 0, end: null };
const runOf = (): WorkRun | null => (state.run ? (runs.get().byId.get(state.run) ?? null) : null);
/** The canvas the person has in front of them: the first visible canvas pane (panes stay mounted when hidden; a follow tab's is not one). */
const currentCanvas = () => {
  for (const el of document.querySelectorAll<HTMLElement>('[data-pane]:not([data-hidden="true"])')) {
    const id = el.dataset.pane;
    if (id && canvasWhere.has(id)) return id;
  }
  return null;
};

const camera = createCamera(() => null, runOf, () => (state.run ? NOW : null), {
  setManual: (on) => set({ paused: on }),
  live: {
    current: currentCanvas,
    awake: () => !!runOf()?.running,
    away: (on) => quiet.hold("live", on),
  },
});

/** Whom the camera follows this moment (a played turn has its own camera: nobody here then). */
function pick(): Pick | null {
  if (!clock.enabled() || clock.get()) return null;
  const r = runs.get();
  const traced = focus.get().traced;
  const focused = pointerFollow.get();
  const p = pickFollow({
    on: prefs.get().followCamera,
    playing: plays.get().play?.runId ?? null,
    traced: traced && r.byId.has(traced) ? traced : null,
    focusedSession: focused && openSessions.get().has(focused) ? focused : null,
    tops: r.roots.map((x) => ({ id: x.id, sessionId: x.sessionId ?? null, working: x.running, lastWorkAt: x.lastAt })),
  });
  return p?.why === "play" ? null : p;
}

export const liveFollow = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  /** 「跟随 <agent>」: the camera is handed back. */
  resume: () => camera.resume(),
  /** Follows an agent now and the person has not taken it. */
  following: () => !!state.run && !state.paused,
};
export const useLiveFollow = () => useSyncExternalStore(liveFollow.subscribe, liveFollow.get);

// a played turn takes the camera from here: it comes home first (the play starts from the person's canvas)
beforePlay.run = () => camera.exit();

if (typeof window !== "undefined") {
  Object.assign(window, { __wsLiveFollow: liveFollow });
  const tick = () => {
    const p = pick();
    const r = p ? runs.get().byId.get(p.run) : undefined;
    set({ run: p && r ? p.run : null, name: r?.name ?? "", why: p && r ? p.why : null });
    camera.tick();
  };
  window.setInterval(tick, 200);
  let last = 0;
  const loop = (n: number) => {
    camera.frame(last ? n - last : 16);
    last = n;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
