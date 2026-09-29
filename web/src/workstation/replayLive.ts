// The live camera (web/docs/workstation.md §10 默认跟随): the follow camera of a played turn (./replayView.ts), in everyday use.
// One canvas, one camera, one agent followed at a time. By default the main view follows the main agent — the
// top-level run of the session the person is conversing with, else the one most recently at work — close up, into
// and out of sub-diagrams, and stands still while it is idle. The person can choose another (`liveFollow.follow`:
// 「跟随」 in a figure's bubble, the avatar on a sub-diagram's entrance; ./followChoice.ts). The person's own doing
// pauses it (the status above the canvas has 「继续」); the switch 「镜头跟随主 agent」 in ⋯ (app/prefs.ts) turns it
// off. A played turn (./replayMode.ts) has the camera before everything (./liveCamera.ts). Where the camera takes
// the canvas by itself nothing is saved and no history is made (./replayQuiet.ts, ./replayHistory.ts).
import { useSyncExternalStore } from "react";
import { prefs } from "../app/prefs";
import { pointerFollow } from "../pointer/follow";
import { openSessions } from "../session/ui";
import { clock } from "./clock";
import { choose, chosenRun, NONE, type Choice } from "./followChoice";
import { followsWhere, isWorking, lastWorkStart, pickFollow, whereOf, type Pick } from "./liveCamera";
import { canvasWhere, OUTSIDE, stateAt } from "./place";
import { beforePlay, plays } from "./replayMode";
import { quiet } from "./replayQuiet";
import { createCamera, ctxFor } from "./replayView";
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

/** The person's choice of whom to follow (./followChoice.ts): replaced by the next one, ended by turning to another session. */
let choice: Choice = NONE;
/** The live camera has no window: it is "now". */
const NOW = { start: 0, end: null };
const runOf = (): WorkRun | null => (state.run ? (runs.get().byId.get(state.run) ?? null) : null);
/** The canvas the person has in front of them: the first visible canvas pane (panes stay mounted when hidden). */
const currentCanvas = () => {
  for (const el of document.querySelectorAll<HTMLElement>('[data-pane]:not([data-hidden="true"])')) {
    const id = el.dataset.pane;
    if (id && canvasWhere.has(id)) return id;
  }
  return null;
};

/** Work on the diagram to follow: on a node, on the way, through a door — not in the tray, not idle (./liveCamera.ts `whereOf`). */
function workOnDiagram(): boolean {
  const r = runOf();
  const c = camera.shown();
  const ctx = c ? ctxFor(c) : null;
  if (!r || !ctx) return false;
  const now = clock.time();
  // work that began before the page opened is not followed
  if ((lastWorkStart(r, now) ?? -1) < OPENED_AT) return false;
  return followsWhere(whereOf(stateAt(r, now, ctx), OUTSIDE, isWorking(r, now)));
}
/** When the page opened: only the work that begins after it is followed. */
const OPENED_AT = Date.now();

const camera = createCamera(() => null, runOf, () => (state.run ? NOW : null), {
  setManual: (on) => set({ paused: on }),
  live: {
    current: currentCanvas,
    awake: workOnDiagram,
    working: () => {
      const r = runOf();
      return !!r && isWorking(r, Date.now());
    },
    lastWorkStart: () => {
      const r = runOf();
      return r ? lastWorkStart(r, Date.now()) : null;
    },
    openedAt: OPENED_AT,
    away: (on) => quiet.hold("live", on),
  },
});

/** Whom the camera follows this moment (a played turn has its own camera: nobody here then). */
function pick(): Pick | null {
  if (!clock.enabled() || clock.get()) return null;
  const r = runs.get();
  const focused = pointerFollow.get();
  const focusedSession = focused && openSessions.get().has(focused) ? focused : null;
  const p = pickFollow({
    on: prefs.get().followCamera,
    playing: plays.get().play?.runId ?? null,
    chosen: chosenRun(choice, { focusedSession, exists: (id) => r.byId.has(id) }),
    focusedSession,
    tops: r.roots.map((x) => ({ id: x.id, sessionId: x.sessionId ?? null, working: x.running, lastWorkAt: x.lastAt })),
  });
  return p?.why === "play" ? null : p;
}

export const liveFollow = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  /** 「继续」: the camera is handed back. */
  resume: () => camera.resume(),
  /** Follow `run` now (and only it): the camera is handed back too. */
  follow(run: string) {
    const focused = pointerFollow.get();
    choice = choose(choice, run, focused && openSessions.get().has(focused) ? focused : null);
    camera.resume();
    const r = runs.get().byId.get(run);
    set({ run: r ? run : null, name: r?.name ?? "", why: r ? "chosen" : null });
  },
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
  const timer = window.setInterval(tick, 200);
  let last = 0;
  let raf = 0;
  const loop = (n: number) => {
    camera.frame(last ? n - last : 16);
    last = n;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  // a hot update must not leave two cameras running (they would fight over the canvas)
  import.meta.hot?.dispose(() => {
    clearInterval(timer);
    cancelAnimationFrame(raf);
    camera.stop();
  });
}
