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
import { isWorking, newSpell, pickFollow, spellStep, type Pick, type Spell } from "./liveCamera";
import { canvasWhere } from "./place";
import { beforePlay, plays } from "./replayMode";
import { quiet } from "./replayQuiet";
import { ctxFor, createCamera } from "./replayView";
import { figureMoving, LOOKAHEAD_MS } from "./director";
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

/** When the page opened: a turn that was going already is followed only when it does something new (./liveCamera.ts `spellStep`). */
const OPENED_AT = Date.now();
/** What the camera has seen of the followed run's turns, whom it belongs to and whether the person chose them. */
let spell: { run: string | null; s: Spell } = { run: null, s: newSpell() };
/** Once per tick: the camera has a turn to follow — from the person's message to the end of the turn, whatever the agent does meanwhile. */
function updateSpell() {
  const r = runOf();
  if (spell.run !== (r?.id ?? null)) ((spell = { run: r?.id ?? null, s: newSpell() }), (wasFollowing = moving = false));
  if (!r) return void (moving = false);
  const now = Date.now();
  let last: number | null = null;
  for (const g of r.segs) if (g.start <= now) last = Math.max(last ?? 0, g.start);
  spell.s = spellStep(spell.s, { working: isWorking(r, now), lastWorkStart: last, openedAt: OPENED_AT, now, chosen: state.why === "chosen" });
  // the turn is over but the figure is still on its way (the drawn figure is LOOKAHEAD_MS behind, and a long walk takes many seconds): the camera stays with it,
  // and the way home waits until it stands (HOME_AFTER_MS counts from then)
  const ctx = ctxFor(camera.shown() ?? currentCanvas() ?? "");
  const held = wasFollowing && !spell.s.followed && !!ctx && figureMoving(r, ctx, now, LOOKAHEAD_MS);
  wasFollowing = spell.s.followed || held;
  moving = held;
}
let wasFollowing = false;
let moving = false;

const camera = createCamera(() => null, runOf, () => (state.run ? NOW : null), {
  setManual: (on) => set({ paused: on }),
  live: {
    current: currentCanvas,
    working: () => spell.s.followed || moving,
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
    updateSpell();
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
