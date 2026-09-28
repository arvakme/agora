// The one clock the 工位视图 and the timeline share: live (now), or a replay position the person
// dragged the timeline to (optionally playing at a speed). Replay time is always computed from the
// wall clock — `advance(at, (now - since) × speed, gaps)` — never accumulated per frame, so a tab
// that was in the background (no animation frames) shows the right moment when it returns, and
// playback skips the collapsed idle stretches.
//
// React never re-renders per frame from here: drawing reads `clock.time()` inside the one frame
// loop (./frame.ts); components that show a time use `useTick` (a coarse timer).
import { useEffect, useState, useSyncExternalStore } from "react";
import { advance } from "./axis";

export type Replay = { at: number; playing: boolean; speed: number; since: number; until: number; gaps?: readonly { a: number; b: number }[] };

let replay: Replay | null = null;
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
  /** Jump to a moment (pauses). */
  seek(at: number, until: number, gaps?: Replay["gaps"]) {
    replay = { at, playing: false, speed: replay?.speed ?? 1, since: Date.now(), until, gaps: gaps ?? replay?.gaps };
    emit();
  },
  play(from: number, until: number, speed = replay?.speed ?? 1, gaps?: Replay["gaps"]) {
    replay = { at: from, playing: true, speed, since: Date.now(), until, gaps: gaps ?? replay?.gaps };
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

export const useReplay = () => useSyncExternalStore(clock.subscribe, clock.get);
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
