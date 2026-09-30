// Which agent a new conversation is recommended to start with. The @ list (comments/mention.ts) and the new-session
// chooser (SessionPane.tsx `Chooser`) both ask here, so they always agree. In order:
//   1. the agent of the session that worked most recently on this canvas;
//   2. the agent most used in the project (a tie goes to the one that worked last);
//   3. Claude Code.
// Only an agent that can start a session (`kinds`) is ever recommended. Pure.
import type { Binding } from "./agents";

export const DEFAULT_KIND = "claude";

/** When a session last did anything. A session whose transcript is still empty reports 0: it counts from its creation. */
export const lastActive = (b: Binding, activeAt: number | undefined): number => Math.max(activeAt ?? 0, b.createdAt);

export function recommendAgent(o: {
  /** The session agents that can be started (`sessionKinds()`). */
  kinds: readonly string[];
  bindings: Record<string, Binding>;
  activeAt: Record<string, number>;
  /** The sessions on this canvas; unknown = go straight to the project's most used. */
  canvas?: readonly string[];
}): string {
  const last = (sid: string) => lastActive(o.bindings[sid], o.activeAt[sid]);
  const usable = (sid: string) => !!o.bindings[sid] && o.kinds.includes(o.bindings[sid].agent);
  const onCanvas = (o.canvas ?? []).filter(usable).sort((a, b) => last(b) - last(a))[0];
  if (onCanvas) return o.bindings[onCanvas].agent;

  const use = new Map<string, { n: number; at: number }>();
  for (const sid of Object.keys(o.bindings).filter(usable)) {
    const agent = o.bindings[sid].agent;
    const u = use.get(agent) ?? { n: 0, at: 0 };
    use.set(agent, { n: u.n + 1, at: Math.max(u.at, last(sid)) });
  }
  const most = [...use].sort(([, a], [, b]) => b.n - a.n || b.at - a.at)[0];
  if (most) return most[0];
  return o.kinds.includes(DEFAULT_KIND) ? DEFAULT_KIND : (o.kinds[0] ?? DEFAULT_KIND);
}

/** The chooser's selected agent: the recommended one until the person picks another. */
export const kindShown = (picked: string | null, recommended: string): string => picked ?? recommended;
