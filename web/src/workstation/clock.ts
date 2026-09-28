// The one clock the 工位视图 and the progress pointers share: live (now), or a replay position
// the person dragged the timeline to (optionally playing at a speed). Replay time is always
// computed from the wall clock — `at + (now - since) * speed` — never accumulated per frame, so
// a tab that was in the background (no animation frames) shows the right moment when it returns.
import { useEffect, useState, useSyncExternalStore } from "react";

export type Replay = { at: number; playing: boolean; speed: number; since: number; until: number };

let replay: Replay | null = null;
let enabled: Record<string, boolean> = readEnabled();
const ls = new Set<() => void>();
const emit = () => ls.forEach((l) => l());

function readEnabled(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("agora.workstation") ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Replay time at wall-clock `now` (clamped to the end of the recording). */
export const replayTime = (r: Replay, now: number) => (r.playing ? Math.min(r.until, r.at + (now - r.since) * r.speed) : r.at);

export const clock = {
  get: () => replay,
  subscribe: (l: () => void) => (ls.add(l), () => void ls.delete(l)),
  /** Jump to a moment (pauses). */
  seek(at: number, until: number) {
    replay = { at, playing: false, speed: replay?.speed ?? 1, since: Date.now(), until };
    emit();
  },
  play(from: number, until: number, speed = replay?.speed ?? 1) {
    replay = { at: from, playing: true, speed, since: Date.now(), until };
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
  /** 工位视图 on / off, per canvas (a per-viewer convenience, kept in this browser). */
  enabled: (canvasId: string) => !!enabled[canvasId],
  toggle(canvasId: string) {
    enabled = { ...enabled, [canvasId]: !enabled[canvasId] };
    try {
      localStorage.setItem("agora.workstation", JSON.stringify(enabled));
    } catch {
      /* private mode: this page only */
    }
    if (!Object.values(enabled).some(Boolean)) replay = null;
    emit();
  },
};

export const useReplay = () => useSyncExternalStore(clock.subscribe, clock.get);
export const useWorkstation = (canvasId: string) => useSyncExternalStore(clock.subscribe, () => clock.enabled(canvasId));

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The current time for drawing, ticking once per animation frame while `animate` and the page is
 * visible (1 s steps with reduced motion). Frames only repaint; the state is computed from the time.
 */
export function useNow(animate: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    let timer = 0;
    const slow = reduced();
    const tick = () => {
      setNow(Date.now());
      if (!slow && document.visibilityState === "visible") raf = requestAnimationFrame(tick);
    };
    // Frames stop in a background tab; a coarse timer keeps "now" roughly right there, and the
    // first visible frame jumps straight to the correct state.
    timer = window.setInterval(() => setNow(Date.now()), slow ? 1000 : 1000);
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    tick();
    return () => (cancelAnimationFrame(raf), clearInterval(timer), document.removeEventListener("visibilitychange", onVis));
  }, [animate]);
  return now;
}

/** The time the pointers and workers show: replay position, or null for live. */
export function useReplayAt(animate: boolean): number | null {
  const r = useReplay();
  const now = useNow(animate && !!r?.playing);
  return r ? replayTime(r, now) : null;
}
export { reduced as prefersReducedMotion };
