// Top-level runs from the transcripts already on the page (the CLI's own logs, followed live by the
// server): one run per bound session. Used until the adapter layer serves run trees, and for any
// session it does not know. Pure.
import type { Item } from "../../session/agents";
import { buildLane, type Seg } from "../lanes";
import type { AgentRun, RunSeg } from "./types";

const base = (p: string) => p.split("/").pop() || p;

/** A lane segment as a run segment (labels in the words the canvas uses). */
export function toRunSeg(s: Seg): RunSeg {
  const out: RunSeg = { kind: s.kind, start: s.start, end: s.end, turn: s.turn, label: s.label };
  if (s.itemId) out.itemId = s.itemId;
  if (s.path) out.path = s.path;
  if (s.kind === "exec" && s.input) out.cmd = s.input;
  if (s.kind === "wait" && s.input && !s.input.startsWith("{")) out.question = s.input;
  if (s.kind === "delegate" && s.input) out.label = `派 ${s.input.length > 24 ? `${s.input.slice(0, 24)}…` : s.input}`;
  if (s.kind === "write" || s.kind === "read") out.label = `${s.kind === "write" ? "写" : "读"} ${s.path ? base(s.path) : ""}`.trim();
  if (s.kind === "exec") out.label = `跑 ${(s.input ?? "").split(" ")[0] || "命令"}`;
  if (s.kind === "wait") out.label = "等你回复";
  return out;
}

export function runFromTranscript(o: { sessionId: string; agent: string; name: string; items: readonly Item[]; running: boolean; now: number; root?: string; activeAt?: number }): AgentRun {
  // A running turn reaches a little past "now", so the worker is never idle between refreshes.
  const lane = buildLane(o.sessionId, o.items, { live: o.running, now: o.now, root: o.root });
  const segs = lane.segs.map(toRunSeg);
  const lastSeg = segs.length ? segs[segs.length - 1].end : 0;
  return {
    id: o.sessionId,
    agent: o.agent,
    name: o.name,
    sessionId: o.sessionId,
    segs,
    receipts: [],
    running: o.running,
    lastAt: Math.max(lastSeg, o.running ? o.now : 0),
    children: [],
  };
}
