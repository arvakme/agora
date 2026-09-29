// The live camera (web/docs/workstation.md §10 默认跟随): the "▶ 放一轮" camera, generalised to live mode. It follows the
// main agent by default. Pure decisions live here: whom to follow, when the person's own doing pauses it, and
// whether the follow tab should still open for an agent the camera is already taking us to.

export type Top = {
  id: string;
  sessionId: string | null;
  working: boolean;
  /** Wall time (ms) of the last work seen on this run; 0 when none. */
  lastWorkAt: number;
};

export type Pick = { run: string; why: "play" | "trace" | "main" };

export type PickIn = {
  /** The per-browser switch "镜头跟随主 agent". */
  on: boolean;
  /** The run of the turn being played (放一轮), if any. */
  playing: string | null;
  /** The traced agent's run (any agent: a sub-agent too), if tracing and it is there. */
  traced: string | null;
  /** The session the person is conversing with, if any. */
  focusedSession: string | null;
  /** Top-level runs on the page. */
  tops: Top[];
};

/** Priority: a played turn > the traced agent > the main agent. The switch only turns off the last two: a played turn is asked for. */
export function pickFollow(i: PickIn): Pick | null {
  if (i.playing) return { run: i.playing, why: "play" };
  if (!i.on) return null;
  if (i.traced) return { run: i.traced, why: "trace" };
  const focused = i.focusedSession ? i.tops.find((t) => t.sessionId === i.focusedSession) : undefined;
  if (focused) return { run: focused.id, why: "main" };
  let best: Top | undefined;
  for (const t of i.tops) {
    if (!best || (t.working ? 1 : 0) - (best.working ? 1 : 0) > 0 || (t.working === best.working && t.lastWorkAt > best.lastWorkAt)) best = t;
  }
  return best ? { run: best.id, why: "main" } : null;
}

export type PauseEvent = "pan" | "zoom" | "select" | "edit" | "comment" | "escape" | "agent-moves" | "resume";

/** Pausing is the person's doing; only the button resumes. A pause is not a switch: it lives in memory, a refresh starts unpaused. */
export function nextPaused(paused: boolean, ev: PauseEvent): boolean {
  if (ev === "resume") return false;
  if (ev === "agent-moves") return paused;
  return true;
}

/** The follow tab opens for the main agent only when the camera is not already taking us there. */
export function mayOpenFollowTab(run: string, isTop: boolean, cam: { on: boolean; paused: boolean; run: string | null }): boolean {
  return !(isTop && cam.on && !cam.paused && cam.run === run);
}

// ── only work on the diagram is followed; done, it goes home ──

export type Where = "node" | "route" | "tray" | "think" | "idle";

/**
 * Where the followed run is, for the camera: on a node working on a file (`seg.path`), on the way (a trip in
 * progress), through a door of a sub-diagram, in the tray outside the diagram, thinking (no file in hand: nothing
 * on the diagram changes), or not at work.
 */
export function whereOf(st: { present: boolean; at: string; trip: unknown; w: number; seg?: { path?: string } | null; portalPhase?: string }, outside: string, running: boolean): Where {
  if (!running) return "idle";
  if (st.portalPhase) return "node"; // through a door of a sub-diagram
  if (st.at === outside) return "tray";
  if (st.trip && st.w < 1) return "route";
  return st.seg?.path ? "node" : "think";
}
/** The camera pushes in on the diagram's work only: not on the tray, not on an idle run. */
export const followsWhere = (w: Where) => w === "node" || w === "route";

/** After the turn has ended (the run is not at work) this long, the camera goes back to the view it started from. */
export const HOME_AFTER_MS = 3000;
/** A different canvas (into a sub-diagram, or back out) is only gone to after the agent has been wanted there this long without a break. */
export const ENTER_MS = 3000;
/** After the camera switched canvas, it is not taken for the person's doing that the canvas is still mounting for this long. */
export const MOUNT_GRACE_MS = 6000;

/** One standard for 「at work」, shared by the strip (idle or not) and the camera (awake or not): the turn is running, or a call is in progress. */
export function isWorking(run: { running: boolean; segs: readonly { start: number; end: number }[] }, now: number): boolean {
  return run.running || run.segs.some((s) => s.start <= now && now < s.end);
}
/** When the run's latest call began (≤ now), or null. */
export function lastWorkStart(run: { segs: readonly { start: number }[] }, now: number): number | null {
  let last: number | null = null;
  for (const s of run.segs) if (s.start <= now) last = Math.max(last ?? 0, s.start);
  return last;
}

// ── the live camera's decisions, as a state machine fed one tick at a time ──
export type LiveMachine = { endedAt: number | null; want: { canvas: string; since: number } | null; mismatch: number; lastGoAt: number };
export const newLiveMachine = (): LiveMachine => ({ endedAt: null, want: null, mismatch: 0, lastGoAt: -Infinity });
export type LiveIn = {
  now: number;
  /** `isWorking` of the followed run: the turn is running. Thinking counts: it is not a reason to go home or to go in. */
  working: boolean;
  lastWorkStart: number | null;
  /** When the page opened: only work that begins after it is followed. */
  openedAt: number;
  /** The canvas the agent's door path wants shown (`cameraCanvas`), the canvas shown, the person's canvas (home), the canvas in front of them (null while it mounts). */
  want: string;
  shown: string;
  home: string;
  cur: string | null;
  /** A switch is in progress. */
  busy: boolean;
  /** The person took the camera (paused). */
  manual: boolean;
  /** The view is away from what the person had (another canvas, or moved on it). */
  displaced: boolean;
};
export type LiveAct = { type: "none" } | { type: "go"; to: string } | { type: "home" } | { type: "user-moved"; to: string };

/** One tick: mutates `m`, returns what the camera does. */
export function liveStep(m: LiveMachine, i: LiveIn): LiveAct {
  if (i.busy) return { type: "none" };
  // the person went to another canvas themself (not a canvas that is still mounting after the camera's own switch)
  if (i.cur && i.cur !== i.shown && i.now - m.lastGoAt > MOUNT_GRACE_MS) {
    if (++m.mismatch >= 2) {
      m.mismatch = 0;
      return { type: "user-moved", to: i.cur };
    }
    return { type: "none" };
  }
  m.mismatch = 0;
  if (i.manual) {
    m.want = null;
    m.endedAt = null;
    return { type: "none" };
  }
  if (!i.working) {
    // the turn is over: about 3 s on, back to the view it started from — never in the middle of a turn
    m.want = null;
    m.endedAt ??= i.now;
    if (i.displaced && i.now - m.endedAt >= HOME_AFTER_MS) {
      m.endedAt = null;
      m.lastGoAt = i.now;
      return { type: "home" };
    }
    return { type: "none" };
  }
  m.endedAt = null;
  if (i.lastWorkStart == null || i.lastWorkStart < i.openedAt) return { type: "none" }; // work from before the page opened is not followed
  if (i.want === i.shown) {
    m.want = null;
    return { type: "none" };
  }
  if (m.want?.canvas !== i.want) m.want = { canvas: i.want, since: i.now };
  if (i.now - m.want.since >= ENTER_MS) {
    m.want = null;
    m.lastGoAt = i.now;
    return { type: "go", to: i.want };
  }
  return { type: "none" };
}

/**
 * 「继续跟随 <agent>」: only while there is something to follow. The camera has been taken by the person, the followed
 * turn is at work (`isWorking`, the camera's own standard) and its figure is on this canvas (or in its tray). An idle or
 * departed agent has nowhere to be followed to; when it starts working again the button comes back if still paused.
 */
export function showResume(o: { paused: boolean; run: { running: boolean; segs: readonly { start: number; end: number }[] } | null; now: number; drawn: boolean }): boolean {
  return o.paused && o.drawn && !!o.run && isWorking(o.run, o.now);
}
