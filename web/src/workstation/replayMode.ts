// Playing a turn (web/docs/workstation.md §11 按轮追踪): ▶ on a turn of a session in the conversation plays
// that turn again on the diagram. It is the person asking for it, so here the camera moves — it follows the
// traced agent close up, into and out of sub-diagrams (./replayView.ts) — while the everyday canvas stays
// still. The run played is the real one, over the turn's window on the timeline (the timeline's own replay:
// its play / speed buttons work); this state says which turn, for the bar, the node marks and the camera.
// It ends at the turn's end plus the summary (or on Esc, ✕): the canvas and view it was started from come
// back. No layout is saved and no history entry made meanwhile.
import { useSyncExternalStore } from "react";
import { nested } from "../nested/store";
import { clock, replayTime } from "./clock";
import { canvasWhere } from "./place";
import { summaryOf, type Window } from "./playCounts";
import { startAt, type StartOpts } from "./replayStart";
import { quiet } from "./replayQuiet";
import { createCamera } from "./replayView";
import { runs } from "./runs/store";
import type { WorkRun } from "./runs/types";
import { subviewCtx } from "./subview";

export type Play = {
  /** The traced agent's run (the session's), and the turn played: its number, and the session's name for the bar. */
  runId: string;
  n: number;
  name: string;
  win: Window;
  /** The canvas the person is on (the session's), where the camera starts from and comes back to. */
  canvasId?: string;
};
export type PlayState = {
  play: Play | null;
  /** The summary, said by the bar when the badge over the node has no clear place. */
  barNote: string | null;
  /** The person has taken the camera (panned or zoomed): it does not follow until 「跟随小人」. Only for this play. */
  manual: boolean;
  /** ▶ was pressed and the live camera is still coming home: Esc cancels (the bar says so). */
  starting: boolean;
};

/** Then it lets go by itself after this long. */
const HOLD_MS = 3500;

let state: PlayState = { play: null, barNote: null, manual: false, starting: false };
let startToken = 0;
const ls = new Set<() => void>();
const set = (p: Partial<PlayState>) => {
  const was = !!state.play;
  state = { ...state, ...p };
  // the layout is not saved while the camera moves the view around, and there is no 「在子图里」 hint over the menu: from the start until the canvas and the view are back (what was pending is written first)
  if (!was && state.play) quiet.hold("play", true);
  ls.forEach((l) => l());
};
let main: string | null = null;
let until = 0;
let doneAt = 0;

const mainCanvas = () => (main ??= state.play?.canvasId ?? [...canvasWhere.keys()][0] ?? null);
const run = (): WorkRun | null => (state.play ? (runs.get().byId.get(state.play.runId) ?? null) : null);
/** The camera: the main view follows the traced agent (./replayView.ts). */
const camera = createCamera(() => (state.play ? mainCanvas() : null), run, () => state.play?.win ?? null, { setManual: (on) => state.manual !== on && set({ manual: on }) });

/** Something to do before a play starts (the live camera comes home first: ./replayLive.ts). */
export const beforePlay = { run: async (): Promise<void> => {} };

export const plays = {
  get: () => state,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  active: () => !!state.play,
  run,
  /** Play a turn. The caller has traced it (`focus.trace`); the clock starts a moment before it (or at the step `o.from`, paused there when `o.paused`) and ends after it (the summary). */
  async start(p: Play, o: StartOpts = {}) {
    const token = ++startToken;
    set({ starting: true });
    try {
      await beforePlay.run();
      if (token !== startToken) return; // cancelled (Esc) while the live camera was coming home
      const now = Date.now();
      main = p.canvasId ?? null;
      doneAt = 0;
      const go = startAt(p.win, now, o);
      until = go.until;
      set({ play: p, barNote: null, manual: false });
      if (go.paused) clock.seek(go.at, until, clock.get()?.gaps);
      else clock.play(go.at, until, 1, clock.get()?.gaps);
    } finally {
      if (token === startToken) set({ starting: false });
    }
  },
  /** Esc while ▶ waits for the live camera to come home: no play starts. */
  cancelStart() {
    if (!state.starting) return false;
    startToken++;
    set({ starting: false });
    return true;
  },
  /** How much the turn changed, for the summary (nodes are the deepest ones, as the follow view counts them). */
  summary(): { nodes: number; files: number } | null {
    const r = run();
    const id = mainCanvas();
    if (!r || !state.play || !id) return null;
    const st = nested.get();
    const sub = subviewCtx(id, st.scenes, st.titles, () => undefined);
    return summaryOf(r, state.play.win, (p) => {
      const k = sub.place(p);
      return k && !k.startsWith("\u0000") ? k : null;
    });
  },
  resumeFollow: () => camera.resume(),
  setBarNote: (note: string | null) => void (state.barNote !== note && set({ barNote: note })),
  /** Let go: the canvas and the view it was started from come back, and the timeline goes back to now. */
  exit() {
    if (plays.cancelStart()) return;
    if (!state.play) return;
    set({ play: null, barNote: null, manual: false });
    clock.live();
    // …and saving comes back once the canvas and the view are back (the layout is as it was: nothing to save)
    // whatever happens to the camera's way home, saving and the hint come back
    void camera.exit().finally(() => ((main = null), state.play || quiet.hold("play", false)));
  },
};

export const usePlay = () => useSyncExternalStore(plays.subscribe, plays.get);

if (typeof window !== "undefined") {
  // the end: after the summary it lets go by itself
  window.setInterval(() => {
    if (!state.play) return void (doneAt = 0);
    const c = clock.get();
    if (!c || !c.playing) return;
    if (replayTime(c, Date.now()) >= until - 1) {
      if (!doneAt) doneAt = Date.now();
      else if (Date.now() - doneAt > HOLD_MS) plays.exit();
    }
  }, 400);
  window.setInterval(() => camera.tick(), 200);
  let lastFrame = 0;
  const loop = (n: number) => {
    if (state.play) camera.frame(lastFrame ? n - lastFrame : 16);
    lastFrame = n;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  // Esc lets go (before the app's own Esc: trace, follow, selection)
  addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !(state.play || state.starting)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.stopPropagation();
      plays.exit();
    },
    true,
  );
}
