// The day's summary (web/docs/workstation.md「新想法」), from the runs alone: how many agents worked,
// how many walks between nodes, files written, commands run, how long someone waited on you, and the
// node with the most work — from `from` to `to` (the playhead in a replay). Shown by ./DaySummary.tsx.
// Pure.
import type { Ctx } from "./place";
import type { WorkRun } from "./runs/types";
import { dwell, trail } from "./trail";

export type DaySum = {
  /** Agents that worked in the window, and how many of them are sub-agents. */
  agents: number;
  subs: number;
  /** Walks from one node to another (a glance is not one). */
  steps: number;
  /** Distinct files written. */
  files: number;
  commands: number;
  /** How long someone waited on you (two waiting at once count once), ms. */
  waited: number;
  /** The node where workers stood working longest (null: nobody worked on the diagram). */
  busiest: { place: string; ms: number } | null;
};

export function summarize(runs: readonly WorkRun[], ctx: Ctx, from: number, to: number): DaySum {
  // began by the end of the window, still going after its start
  const within = (a: number, b: number) => a <= to && b > from;
  let agents = 0;
  let subs = 0;
  let steps = 0;
  let commands = 0;
  const files = new Set<string>();
  const waits: [number, number][] = [];
  for (const r of runs) {
    const worked = r.segs.some((g) => within(g.start, g.end)) || (r.spawnAt != null && within(r.spawnAt, r.doneAt ?? Infinity));
    if (!worked) continue;
    agents++;
    if (r.parentId) subs++;
    for (const g of r.segs) {
      if (!within(g.start, g.end)) continue;
      if (g.kind === "write" && g.path) files.add(g.path);
      else if (g.kind === "exec") commands++;
      else if (g.kind === "wait") waits.push([Math.max(g.start, from), Math.min(g.end, to)]);
    }
    for (const m of trail(r, ctx).moves) if (m.t >= from && m.t <= to) steps++;
  }
  let waited = 0;
  let reach = -Infinity;
  for (const [a, b] of waits.sort((x, y) => x[0] - y[0])) {
    waited += Math.max(0, b - Math.max(a, reach));
    reach = Math.max(reach, b);
  }
  let busiest: DaySum["busiest"] = null;
  for (const [place, v] of dwell(runs, ctx, from, to)) if (!busiest || v.stood > busiest.ms) busiest = { place, ms: v.stood };
  return { agents, subs, steps, files: files.size, commands, waited: Math.round(waited), busiest: busiest && { place: busiest.place, ms: Math.round(busiest.ms) } };
}
