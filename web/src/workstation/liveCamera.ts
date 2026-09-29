// The live camera (web/docs/workstation.md §10 默认跟随): the "▶ 放一轮" camera, generalised to live mode. It follows the
// main agent by default. Pure decisions live here: whom to follow, whether there is a turn to follow, which canvas to show and when the
// person's own doing pauses it. Where the view goes is ./director.ts `cameraStep`.

export type Top = {
  id: string;
  sessionId: string | null;
  working: boolean;
  /** Wall time (ms) of the last work seen on this run; 0 when none. */
  lastWorkAt: number;
};

export type Pick = { run: string; why: "play" | "chosen" | "main" };

export type PickIn = {
  /** The per-browser switch "镜头跟随主 agent". */
  on: boolean;
  /** The run of the turn being played (放一轮), if any. */
  playing: string | null;
  /** The run the person chose to follow (any agent: a sub-agent too), while the choice holds (./followChoice.ts). */
  chosen: string | null;
  /** The session the person is conversing with, if any. */
  focusedSession: string | null;
  /** Top-level runs on the page. */
  tops: Top[];
};

/** Priority: a played turn > the person's choice > the main agent. The switch only turns off the last two: a played turn is asked for. */
export function pickFollow(i: PickIn): Pick | null {
  if (i.playing) return { run: i.playing, why: "play" };
  if (!i.on) return null;
  if (i.chosen) return { run: i.chosen, why: "chosen" };
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
// ── whether the camera has a turn to follow ──
/** A run first seen this long after the page opened is a new turn (its session had nothing on the page before); sooner, it may be one that was going already. */
export const SPELL_FIRST_SIGHT_MS = 8000;
/** What the camera has seen of the followed run's turns: `seen` a tick of it at all, `was` working the tick before, `followed` this turn is the camera's to follow. */
export type Spell = { seen: boolean; was: boolean; followed: boolean };
export const newSpell = (): Spell => ({ seen: false, was: false, followed: false });
/**
 * One tick. A turn is followed from the moment it begins — the person's message, before its first call — through thinking, the tray and
 * waiting, until it ends (the turn is what counts, not a call in hand). A turn that was already going when the page opened is not: it
 * is followed when it does something new. An agent the person chose is followed while it works.
 */
export function spellStep(s: Spell, i: { working: boolean; lastWorkStart: number | null; openedAt: number; now: number; chosen: boolean }): Spell {
  if (!i.working) return { seen: true, was: false, followed: false };
  const begun = s.seen ? !s.was : i.now - i.openedAt > SPELL_FIRST_SIGHT_MS;
  const fresh = (i.lastWorkStart ?? -1) >= i.openedAt;
  return { seen: true, was: true, followed: s.followed || begun || fresh || i.chosen };
}

// ── which canvas the camera shows: into a sub-diagram, home again, the person's own doing, fed one tick at a time ──
export type CanvasMachine = { endedAt: number | null; want: { canvas: string; since: number } | null; mismatch: number; lastGoAt: number };
export const newCanvasMachine = (): CanvasMachine => ({ endedAt: null, want: null, mismatch: 0, lastGoAt: -Infinity });
export type CanvasIn = {
  now: number;
  /** The camera has a turn to follow (`spellStep`). Thinking counts: it is not a reason to go home or to go in. */
  working: boolean;
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
export type CanvasAct = { type: "none" } | { type: "go"; to: string } | { type: "home" } | { type: "user-moved"; to: string };

/** One tick: mutates `m`, returns what the camera does about the canvas. */
export function canvasStep(m: CanvasMachine, i: CanvasIn): CanvasAct {
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
