// Typed client for the adapter layer's run trees: GET /api/agent/runs?session=<id>.
//
// Contract this page reads (docs/agora-cli-adapters.md §5; the adapter branch owns the server side):
//   { runs: AgentRunWire[] }            the session's own run first, sub-agents nested in `children`
//   AgentRunWire = {
//     id, agent, name, parentId?, via?: "task"|"native"|"seedmux", evidence?: "native"|"seedmux"|"inferred",
//     task?, coarse?, running, lastAt, spawnAt?, doneAt?,
//     segments: { kind, start, end, turn?, itemId?, path?, cmd?, question?, child?, verifies?, label? }[],
//     receipts: { at, state }[],
//     children: AgentRunWire[]
//   }
// Times are epoch milliseconds (seconds are accepted and converted). Until the endpoint exists the
// server answers 404: the client remembers that for a minute and the page derives top-level runs
// from the transcripts instead (./derive.ts).
import type { AgentRun, Receipt, ReceiptState, RunSeg, SegKind } from "./types";

type Wire = Record<string, unknown>;
const KINDS: SegKind[] = ["read", "write", "exec", "think", "wait", "delegate"];
const STATES: ReceiptState[] = ["dispatched", "acknowledged", "running", "waiting", "idle_no_reply", "claimed", "accepted", "returned", "failed", "blocked", "exited", "unknown"];
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : undefined);

function seg(w: Wire): RunSeg | null {
  const kind = w.kind as SegKind;
  const start = num(w.start ?? w.startedAt);
  const end = num(w.end ?? w.endedAt);
  if (!KINDS.includes(kind) || start == null) return null;
  const out: RunSeg = { kind, start, end: Math.max(start, end ?? start), label: str(w.label) ?? kind };
  for (const k of ["itemId", "path", "cmd", "question", "child", "verifies"] as const) if (str(w[k])) out[k] = str(w[k]);
  if (typeof w.turn === "number") out.turn = w.turn;
  return out;
}

/** One wire run, normalised; null when it is not a run at all. */
export function normaliseRun(w: Wire, parentId?: string): AgentRun | null {
  const id = str(w.id);
  if (!id) return null;
  const segs = (Array.isArray(w.segments) ? w.segments : Array.isArray(w.segs) ? w.segs : []).map((x) => seg(x as Wire)).filter((x): x is RunSeg => !!x).sort((a, b) => a.start - b.start);
  const receipts: Receipt[] = (Array.isArray(w.receipts) ? w.receipts : [])
    .map((r) => ({ at: num((r as Wire).at), state: (r as Wire).state as ReceiptState }))
    .filter((r): r is Receipt => r.at != null && STATES.includes(r.state))
    .sort((a, b) => a.at - b.at);
  const run: AgentRun = {
    id,
    agent: str(w.agent) ?? "worker",
    name: str(w.name) ?? str(w.agent) ?? id,
    segs,
    receipts,
    running: !!w.running,
    lastAt: num(w.lastAt) ?? Math.max(0, ...segs.map((s) => s.end), ...receipts.map((r) => r.at)),
    children: [],
  };
  const p = str(w.parentId) ?? parentId;
  if (p) run.parentId = p;
  if (str(w.sessionId)) run.sessionId = str(w.sessionId);
  if (["task", "native", "seedmux"].includes(w.via as string)) run.via = w.via as AgentRun["via"];
  if (["native", "seedmux", "inferred"].includes(w.evidence as string)) run.evidence = w.evidence as AgentRun["evidence"];
  if (str(w.task)) run.task = str(w.task);
  if (w.coarse) run.coarse = true;
  const spawn = num(w.spawnAt) ?? receipts[0]?.at;
  if (spawn != null && p) run.spawnAt = spawn;
  if (num(w.doneAt) != null) run.doneAt = num(w.doneAt);
  run.children = (Array.isArray(w.children) ? w.children : []).map((c) => normaliseRun(c as Wire, id)).filter((x): x is AgentRun => !!x);
  return run;
}

let unsupportedUntil = 0;
/** The session's run tree, or null when the server does not serve run trees (yet) or the call failed. */
export async function fetchRunTree(sessionId: string, f: typeof fetch = fetch): Promise<AgentRun | null> {
  if (Date.now() < unsupportedUntil) return null;
  try {
    const r = await f(`/api/agent/runs?session=${encodeURIComponent(sessionId)}`);
    if (r.status === 404 || r.status === 405 || r.status === 501) {
      unsupportedUntil = Date.now() + 60_000;
      return null;
    }
    if (!r.ok) return null;
    const body = (await r.json()) as { runs?: Wire[] } | Wire[];
    const list = Array.isArray(body) ? body : (body.runs ?? []);
    const runs = list.map((w) => normaliseRun(w)).filter((x): x is AgentRun => !!x);
    return runs.find((x) => x.sessionId === sessionId || x.id === sessionId) ?? runs[0] ?? null;
  } catch {
    return null;
  }
}
export const resetRunClient = () => void (unsupportedUntil = 0);
