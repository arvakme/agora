// Runs for the 工位视图, pure: top-level runs from the transcripts already on the page (the CLI's own
// logs, followed live by the server), and their sub-agents from the server's run tree (`fromTree`).
import type { Item, RunTree } from "../../session/agents";
import { buildLane, type Seg } from "../lanes";
import type { Receipt, RunSeg, WorkRun } from "./types";

const base = (p: string) => p.split("/").pop() || p;

/** A lane segment as a run segment (labels in the words the canvas uses). */
export function toRunSeg(s: Seg): RunSeg {
  const out: RunSeg = { kind: s.kind, start: s.start, end: s.end, turn: s.turn, label: s.label };
  if (s.itemId) out.itemId = s.itemId;
  if (s.path) out.path = s.path;
  if (s.durationKnown === false) out.durationKnown = false;
  if (s.comment) out.comment = s.comment;
  if (s.kind === "exec" && s.input) out.cmd = s.input;
  if (s.kind === "wait" && s.input && !s.input.startsWith("{")) out.question = s.input;
  if (s.kind === "delegate" && s.input) out.label = `派 ${s.input.length > 24 ? `${s.input.slice(0, 24)}…` : s.input}`;
  if (s.kind === "write" || s.kind === "read") out.label = `${s.kind === "write" ? "写" : "读"} ${s.path ? base(s.path) : ""}`.trim();
  if (s.kind === "exec") out.label = `跑 ${(s.input ?? "").split(" ")[0] || "命令"}`;
  if (s.kind === "wait") out.label = "等你回复";
  return out;
}

export function runFromTranscript(o: { sessionId: string; agent: string; name: string; items: readonly Item[]; running: boolean; now: number; root?: string; activeAt?: number }): WorkRun {
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

const FINAL_STATES = new Set(["done", "failed", "blocked", "exited", "idle_no_reply", "interrupted"]);
const LIVE_STATES = new Set(["running", "waiting", "dispatched", "acknowledged"]);

/**
 * The server's run tree (`GET /api/agent/runs?session=&items=1`, web/docs/cli-adapters.md §5) as
 * the sub-agents under a session's top-level run. The top-level run itself keeps coming from the
 * page's transcript (`runFromTranscript`); `dispatches` maps the parent's tool calls (item ids)
 * to the runs they dispatched, so its 派 segments can name the child.
 */
export function fromTree(tree: RunTree, sessionId: string, o: { now: number; root?: string; name?: (kind: string) => string }): { children: WorkRun[]; dispatches: Map<string, string> } {
  const byId = new Map(tree.runs.map((r) => [r.id, r]));
  const idOf = (id: string) => (id === tree.root ? sessionId : id);
  const moment = (childId: string, kind: "dispatch" | "handoff") => {
    const c = byId.get(childId);
    const p = c?.parent ? byId.get(c.parent.runId) : undefined;
    return p?.timeline.moments.find((m) => m.kind === kind && m.childRunId === childId);
  };
  const dispatches = new Map<string, string>();
  const out = new Map<string, WorkRun>();
  for (const r of tree.runs) {
    if (r.id === tree.root || !r.parent) continue;
    const segs = r.items?.length ? buildLane(r.id, r.items, { live: LIVE_STATES.has(r.state), now: o.now, root: o.root }).segs.map(toRunSeg) : r.timeline.segments.map((s) => ({ kind: s.kind, start: s.start, end: s.end, turn: s.turn, itemId: s.itemId, label: s.label, ...(s.path ? { path: s.path } : {}) }) as RunSeg);
    const d = moment(r.id, "dispatch");
    const h = moment(r.id, "handoff");
    if (d?.toolCallId && r.parent.runId === tree.root) dispatches.set(d.toolCallId, r.id);
    const spawnAt = d?.at ?? r.startedAt ?? segs[0]?.start ?? undefined;
    const final = FINAL_STATES.has(r.state);
    const doneAt = h?.at ?? (final ? (r.endedAt ?? r.lastAt ?? undefined) : undefined);
    const receipts: Receipt[] = [];
    if (spawnAt != null) receipts.push({ at: spawnAt, state: "dispatched" });
    if (r.startedAt != null) receipts.push({ at: Math.max(r.startedAt, spawnAt ?? 0), state: "running" });
    if (final && doneAt != null) receipts.push({ at: doneAt, state: r.state });
    else if (!final && r.state !== "running") receipts.push({ at: r.lastAt ?? o.now, state: r.state });
    receipts.sort((a, b) => a.at - b.at);
    const spawnSeg = r.parent.toolCallId ? byId.get(r.parent.runId)?.items?.find((it) => it.id === r.parent!.toolCallId) : undefined;
    out.set(r.id, {
      id: r.id,
      agent: r.kind,
      name: r.label || o.name?.(r.kind) || r.kind,
      parentId: idOf(r.parent.runId),
      via: r.parent.via === "dispatch" ? "dispatch" : "native",
      ...(r.dispatchSession ? { dispatchSession: r.dispatchSession } : {}),
      evidence: r.parent.via,
      ...(r.role || spawnSeg?.tool?.input ? { task: r.role || spawnSeg?.tool?.input } : {}),
      segs,
      receipts,
      ...(spawnAt != null ? { spawnAt } : {}),
      ...(doneAt != null ? { doneAt } : {}),
      running: LIVE_STATES.has(r.state),
      lastAt: Math.max(r.lastAt ?? 0, ...segs.map((s) => s.end), ...receipts.map((x) => x.at)),
      children: [],
    });
  }
  const children: WorkRun[] = [];
  for (const r of out.values()) {
    const p = r.parentId === sessionId ? null : out.get(r.parentId!);
    if (p) p.children.push(r);
    else if (r.parentId === sessionId) children.push(r);
  }
  const sort = (xs: WorkRun[]) => (xs.sort((a, b) => (a.spawnAt ?? 0) - (b.spawnAt ?? 0)), xs.forEach((x) => sort(x.children)));
  sort(children);
  return { children, dispatches };
}
