// The one clock the 工位视图 and the timeline share: live (now), or a replay position the person
// dragged the timeline to (optionally playing at a speed). Replay time is always computed from the
// wall clock — `advance(at, (now - since) × speed, gaps)` — never accumulated per frame, so a tab
// that was in the background (no animation frames) shows the right moment when it returns, and
// playback skips the collapsed idle stretches.
//
// React never re-renders per frame from here: drawing reads `clock.time()` inside the one frame
// loop (./frame.ts); components that show a time use `useTick` (a coarse timer).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { advance } from "./axis";

export type Replay = { at: number; playing: boolean; speed: number; since: number; until: number; gaps?: readonly { a: number; b: number }[] };

let replay: Replay | null = null;
/** Bumped on every real jump in time (seek, scrub, play from a point, back to live): the figures'
 * springs reset only then, so live updates blend and a paused frame is exact. */
let gen = 0;
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());

/** Replay time at wall-clock `now` (clamped to the end of the recording). */
export const replayTime = (r: Replay, now: number) => (r.playing ? Math.min(r.until, advance(r.at, (now - r.since) * r.speed, r.gaps ?? [])) : r.at);

const WS_KEY = "agora.workstation.v2";
function readOn(): boolean {
  try {
    return localStorage.getItem(WS_KEY) !== "off";
  } catch {
    return true;
  }
}
let on = readOn();

export const clock = {
  get: () => replay,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  /** The time to draw: the replay position, or now. */
  time: (now = Date.now()) => (replay ? replayTime(replay, now) : now),
  /** Changes on every jump in time (see `gen`). */
  gen: () => gen,
  /** How fast the figures' own motion runs against the wall clock: a replay slower than 1× slows
   * everything (springs, breathing, gestures) like a slow-motion film; live and faster replays move
   * at a person's pace, so a 4× replay does not make hands flicker. */
  motionScale: () => (replay?.playing ? Math.min(1, replay.speed) : 1),
  /** Jump to a moment (pauses). */
  seek(at: number, until: number, gaps?: Replay["gaps"]) {
    replay = { at, playing: false, speed: replay?.speed ?? 1, since: Date.now(), until, gaps: gaps ?? replay?.gaps };
    gen++;
    emit();
  },
  play(from: number, until: number, speed = replay?.speed ?? 1, gaps?: Replay["gaps"]) {
    const cur = replay ? replayTime(replay, Date.now()) : null;
    replay = { at: from, playing: true, speed, since: Date.now(), until, gaps: gaps ?? replay?.gaps };
    if (cur == null || Math.abs(cur - from) > 50) gen++;
    emit();
  },
  pause() {
    if (!replay) return;
    replay = { ...replay, at: replayTime(replay, Date.now()), playing: false, since: Date.now() };
    emit();
  },
  speed(speed: number) {
    if (!replay) return;
    const now = Date.now();
    replay = { ...replay, at: replayTime(replay, now), since: now, speed };
    emit();
  },
  /** Back to live. */
  live() {
    if (!replay) return;
    replay = null;
    gen++;
    emit();
  },
  /** 工位视图 on / off (per browser; on by default). Off: a compact presence chip per agent instead of figures. */
  enabled: (_canvasId?: string) => on,
  setEnabled(v: boolean) {
    on = v;
    try {
      localStorage.setItem(WS_KEY, v ? "on" : "off");
    } catch {
      /* private mode: this page only */
    }
    if (!v) replay = null;
    emit();
  },
  toggle(_canvasId?: string) {
    clock.setEnabled(!on);
  },
};

/**
 * The replay state for React, at most 4 updates a second (a scrub moves the clock on every pointer
 * move; what React shows from it — the banner, the lanes' state, the trajectory's grey — does not
 * need more; the playhead and the figures read the clock in the frame loop). Entering or leaving a
 * replay shows at once.
 */
export function useReplay(): Replay | null {
  const [r, setR] = useState(replay);
  const cur = useRef(replay);
  useEffect(() => {
    let last = 0;
    let timer = 0;
    const push = () => {
      timer = 0;
      last = performance.now();
      cur.current = replay;
      setR(replay);
    };
    const on = () => {
      const edge = (replay == null) !== (cur.current == null);
      const wait = 250 - (performance.now() - last);
      if (edge || wait <= 0) {
        clearTimeout(timer);
        push();
      } else if (!timer) timer = window.setTimeout(push, wait);
    };
    on();
    const off = clock.subscribe(on);
    return () => (off(), clearTimeout(timer));
  }, []);
  return r;
}
export const useWorkstation = (_canvasId?: string) => useSyncExternalStore(clock.subscribe, () => on);

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export { reduced as prefersReducedMotion };

/**
 * A coarse "now" for React: re-renders every `ms` while `active` and the page is visible (a
 * background tab gets one update when it comes back). Never per frame.
 */
export function useTick(ms: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer = 0;
    const start = () => {
      clearInterval(timer);
      setNow(Date.now());
      if (document.visibilityState === "visible") timer = window.setInterval(() => setNow(Date.now()), ms);
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => (clearInterval(timer), document.removeEventListener("visibilitychange", start));
  }, [ms, active]);
  return now;
}

/** The time the canvas shows, for React consumers (re-rendered at 4 Hz while a replay plays): replay position, or null for live. */
export function useReplayAt(): number | null {
  const r = useReplay();
  const now = useTick(250, !!r?.playing);
  return r ? replayTime(r, now) : null;
}

// ── going into a replay is explicit ──
/** Which gestures go into a replay: dragging the playhead, ▶ on the strip, 「回放到这里」 on a segment's card. A click only selects. */
export type ReplayGesture = "click" | "click-track" | "drag" | "play" | "replay-here" | "locate";
export const entersReplay = (g: ReplayGesture) => g === "drag" || g === "play" || g === "replay-here";
/** The follow tab opens by itself only when the person turned that on (⋯, off by default) and live; during a replay only one the person opened stays. */
export const autoFollowTabAllowed = (replaying: boolean, pref: boolean) => pref && !replaying;
/** What moves the session panel between 对话 and 轨迹: its own toggle, a link to a turn, a link to the trajectory, a stop clicked on the canvas. Nothing else — entering a replay does not. */
export type PanelEvent = "toggle" | "turn" | "trajectory" | "step";
export type PanelView = "chat" | "trajectory";
export const panelView = (view: PanelView, ev: PanelEvent | ReplayGesture): PanelView => {
  switch (ev) {
    case "toggle": return view === "trajectory" ? "chat" : "trajectory";
    case "turn": return "chat";
    case "trajectory":
    case "step": return "trajectory";
    default: return view;
  }
};
