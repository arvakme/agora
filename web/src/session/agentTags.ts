// The agent tags at the top right (web/docs/workstation.md §3): one per top-level session — who, and what it is doing
// (干活中 / 在想 / 等你 / 空闲), how many sub-agents it has. Which are shown and in what order. Pure.
import { isWorking } from "../workstation/liveCamera";
import type { WorkRun } from "../workstation/runs/types";

export type TagState = "working" | "waiting" | "thinking" | "idle";
export const TAG_STATE_NAME: Record<TagState, string> = { working: "干活中", waiting: "等你", thinking: "在想", idle: "空闲" };
export type AgentTag = { runId: string; sessionId?: string; agent: string; name: string; state: TagState; kids: number; lastAt: number };

/** 「At work」 is `isWorking` (the camera's standard too); at work, a question asked of the person is 等你, thinking or between calls is 在想. */
export function tagState(run: Pick<WorkRun, "running" | "segs">, now: number): TagState {
  if (!isWorking(run, now)) return "idle";
  const seg = run.segs.find((s) => s.start <= now && now < s.end);
  if (seg?.kind === "wait") return "waiting";
  return !seg || seg.kind === "think" ? "thinking" : "working";
}

const RANK: Record<TagState, number> = { working: 0, waiting: 1, thinking: 2, idle: 3 };
const count = (r: WorkRun): number => r.children.reduce((n, c) => n + 1 + count(c), 0);

/** The tags of the top-level runs: working, waiting, thinking, then the most recently idle. */
export function agentTags(tops: readonly WorkRun[], now: number): AgentTag[] {
  return tops
    .map((r) => ({ runId: r.id, sessionId: r.sessionId, agent: r.agent, name: r.name, state: tagState(r, now), kids: count(r), lastAt: r.lastAt }))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.lastAt - a.lastAt);
}

/** As many tags as fit (`max`), the rest as 「+N」; the tag being looked at is never the one folded away — it takes the last place. */
export function fitTags(tags: readonly AgentTag[], max: number, keep?: string): { shown: AgentTag[]; more: AgentTag[] } {
  if (tags.length <= max) return { shown: [...tags], more: [] };
  const room = Math.max(0, max - 1); // one place goes to 「+N」
  let shown = tags.slice(0, room);
  const kept = keep ? tags.find((t) => t.runId === keep) : undefined;
  if (kept && room > 0 && !shown.includes(kept)) shown = [...shown.slice(0, room - 1), kept];
  return { shown, more: tags.filter((t) => !shown.includes(t)) };
}
