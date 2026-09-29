// Following one agent (web/docs/workstation.md §10 跟随): there is one camera, on the main canvas, and it follows one agent.
// By default that is the agent of the session the person is talking to; the person can choose another (「跟随」 in a
// figure's bubble, the avatar on a sub-diagram's entrance), and a new choice replaces the old. A choice belongs to the
// conversation it was made in: turning to another session, or the run going away, ends it. Pure.
export type Choice = { run: string | null; session: string | null };
export const NONE: Choice = { run: null, session: null };

/** Follow `run`; `focusedSession` is the conversation the person is in as they choose. */
export const choose = (_c: Choice, run: string, focusedSession: string | null): Choice => ({ run, session: focusedSession });

/** The run the person chose, while the choice still holds. */
export const chosenRun = (c: Choice, o: { focusedSession: string | null; exists: (run: string) => boolean }): string | null =>
  c.run && c.session === o.focusedSession && o.exists(c.run) ? c.run : null;

export type FollowStatus = { text: string; resume: boolean };

/**
 * The one status above the canvas: 「跟着 <name>」; after the person moved the canvas 「跟着 <name> · 已暂停」 with 「继续」.
 * Nothing while the agent is idle or gone, or not to be seen on this canvas — there is nothing to follow then.
 */
export function followStatus(o: { name: string; paused: boolean; working: boolean; drawn: boolean }): FollowStatus | null {
  if (!o.working || !o.drawn) return null;
  return o.paused ? { text: `跟着 ${o.name} · 已暂停`, resume: true } : { text: `跟着 ${o.name}`, resume: false };
}
