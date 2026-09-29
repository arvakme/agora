// What the timeline strip and a lane's name show (web/docs/workstation.md §3 时间线, §11 追踪). Pure.
import { fitView, type Box, type Fit, type Occupied } from "./replayFit";

/**
 * The strip is always there while the 工位视图 is on. With no run at all it says 「还没有 agent 在干活」 (`text`); with
 * every agent idle it keeps its own words (`text` null: 都空闲了 N 分 …). Both offer 「新建会话」 (`newSession`).
 */
export function idleStrip(o: { runs: number; busy: number; waiting: number }): { text: string | null; newSession: boolean } {
  if (o.runs === 0) return { text: "还没有 agent 在干活", newSession: true };
  return { text: null, newSession: o.busy === 0 && o.waiting === 0 };
}

/** A lane's name shows its name and one state mark; the actions come with hover or focus (or the ⋯). */
export type LaneAct = "session" | "trace" | "untrace" | "follow";
export function laneLabel(o: { traced: boolean; hasSession: boolean; sub: boolean; hover: boolean; focus: boolean }): { mark: "trace" | null; acts: LaneAct[]; showActs: boolean } {
  const acts: LaneAct[] = [];
  if (o.hasSession && !o.sub) acts.push("session");
  acts.push(o.traced ? "untrace" : "trace", "follow");
  return { mark: o.traced ? "trace" : null, acts, showActs: o.hover || o.focus };
}

/**
 * The strip opened and took height from the canvas: when the diagram's lower part now lies under the zoom bar
 * or the mode bar, the view that fits it in what is left (never zoomed in); else null — the view is left alone.
 */
export function yieldView(o: { view: { zoom: number; scrollX: number; scrollY: number }; pane: { w: number; h: number }; occupied: Occupied; bounds: Box }): Fit | null {
  const bottom = (o.bounds.y + o.bounds.h + o.view.scrollY) * o.view.zoom;
  if (bottom <= o.pane.h - o.occupied.bottom - 8) return null;
  return fitView({ pane: o.pane, occupied: o.occupied, margin: 28, above: 0, maxZoom: o.view.zoom, bounds: o.bounds });
}

/** The short name on the 「跟随 …」 button: the agent, not its task (the full name is the tooltip). */
export const shortAgentName = (name: string) => name.split(" · ")[0];
