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
