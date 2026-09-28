// Agent runs (the CLI-adapter layer's unified "运行", docs/agora-cli-adapters.md §5): a top-level
// Agora session and, below it, the sub-agents it dispatched — native (Claude Task / Agent tool,
// Codex spawn), through Seedmux (smx-team workers), and theirs, to any depth. The 工位视图 draws
// every run the same way; this is the one shape it reads.
//
// The adapter branch serves run trees at GET /api/agent/runs?session=<id> (./client.ts). Until it
// is merged, top-level runs come from the transcripts on the page (./derive.ts), and the sub-agent
// UI is exercised by fixtures (./fixtures.ts, also the `?mock=runs` dev mock).

/** What a worker is doing in one stretch of time. `delegate` = handing work to a sub-agent. */
export type SegKind = "read" | "write" | "exec" | "think" | "wait" | "delegate";

export type RunSeg = {
  kind: SegKind;
  start: number;
  end: number;
  /** Turn number of the owning session (1-based), when known. */
  turn?: number;
  /** The transcript item behind it (tool calls). */
  itemId?: string;
  /** Project-relative file read or written. */
  path?: string;
  /** Command line (exec). */
  cmd?: string;
  /** What it asked the person (wait). */
  question?: string;
  /** The run it dispatched (delegate). */
  child?: string;
  /** A verification step on a sub-agent's work (验收). */
  verifies?: string;
  label: string;
};

/**
 * Unified receipt / lifecycle states (adapter doc §5.3). `claimed` = the worker says it is done
 * (Seedmux replied:done — not the same as accepted); `accepted` = the dispatcher verified it.
 */
export type ReceiptState =
  | "dispatched"
  | "acknowledged"
  | "running"
  | "waiting"
  | "idle_no_reply"
  | "claimed"
  | "accepted"
  | "returned"
  | "failed"
  | "blocked"
  | "exited"
  | "unknown";

export const RECEIPT_NAMES: Record<ReceiptState, string> = {
  dispatched: "已派发",
  acknowledged: "已读",
  running: "运行中",
  waiting: "等回复",
  idle_no_reply: "空闲未回",
  claimed: "声明完成",
  accepted: "验收通过",
  returned: "已返回结果",
  failed: "失败",
  blocked: "受阻",
  exited: "无回复退出",
  unknown: "状态不明",
};
/** Receipts that end a run. */
export const FINAL: ReadonlySet<ReceiptState> = new Set(["claimed", "accepted", "returned", "failed", "blocked", "exited"]);
/** Receipts the tree's 出问题 filter shows. */
export const TROUBLE: ReadonlySet<ReceiptState> = new Set(["failed", "blocked", "exited", "unknown", "idle_no_reply"]);

export type Receipt = { at: number; state: ReceiptState };

/** How a sub-agent was dispatched, and how sure the parent link is (adapter doc §5.2). */
export type Via = "task" | "native" | "seedmux";
export type Evidence = "native" | "seedmux" | "inferred";

export type AgentRun = {
  /** `kind:nativeId`, `smx:T-xx`, or the Agora session id for a derived top-level run. */
  id: string;
  /** Agent kind: pi, claude, codex, or any other CLI's kind ("worker" when only receipts are known). */
  agent: string;
  name: string;
  /** The Agora session (top-level runs only). */
  sessionId?: string;
  parentId?: string;
  via?: Via;
  evidence?: Evidence;
  /** What it was asked to do (sub-agents). */
  task?: string;
  /** Known only by its receipts (T3): no tool calls, so it never walks. */
  coarse?: boolean;
  segs: RunSeg[];
  receipts: Receipt[];
  /** When it was dispatched (sub-agents). */
  spawnAt?: number;
  /** When it reported back (claimed / returned / exited …). */
  doneAt?: number;
  running: boolean;
  /** Last thing that happened (for the 1-minute presence window). */
  lastAt: number;
  children: AgentRun[];
};

/** A run with its place in the tree, as the lanes and the agent tree list them. */
export type FlatRun = { run: AgentRun; depth: number; parent: AgentRun | null; root: AgentRun };

export function flatten(roots: readonly AgentRun[]): FlatRun[] {
  const out: FlatRun[] = [];
  const walk = (r: AgentRun, depth: number, parent: AgentRun | null, root: AgentRun) => {
    out.push({ run: r, depth, parent, root });
    for (const c of r.children) walk(c, depth + 1, r, root);
  };
  for (const r of roots) walk(r, 0, null, r);
  return out;
}

/** The receipt in force at t. */
export function receiptAt(run: AgentRun, t: number): ReceiptState | null {
  let s: ReceiptState | null = null;
  for (const r of run.receipts) if (r.at <= t) s = r.state;
  return s;
}
