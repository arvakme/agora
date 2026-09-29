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

/** After this long without work on the diagram the camera goes back to the view it started from (「✓ 这一轮做完了」 has come out by then). */
export const HOME_AFTER_MS = 3000;
/** `holdFor`: how long the camera has had nothing to follow (null: it has). Goes home once, if it moved, unless you took it over. */
export const goHomeDue = (o: { holdFor: number | null; paused: boolean; displaced: boolean }) => o.holdFor != null && o.holdFor >= HOME_AFTER_MS && !o.paused && o.displaced;
