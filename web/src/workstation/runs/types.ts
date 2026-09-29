// What the 工位视图 draws: a top-level Agora session and, below it, the sub-agents it dispatched —
// native (Claude Agent / Task, Codex spawn), Seedmux workers, and theirs. This is a view model:
// the one wire shape is the server's `RunTree` / `AgentRun` (session/agents.ts, `fetchRuns`,
// web/docs/cli-adapters.md §5), converted once in ./derive.ts (`fromTree`). The receipt states are
// the server's unified `RunState`; what the page says for them (声明完成 vs 已返回结果 vs 验收通过)
// is `receiptView`.
import type { RunState } from "../../session/agents";

/** What a worker is doing in one stretch of time. `delegate` = handing work to a sub-agent. */
export type SegKind = "read" | "write" | "exec" | "think" | "wait" | "delegate";

/**
 * The canvas comment a turn works on (「交给 Agent」): its thread number and the elements it is pinned
 * to (the first one carries the pin), read off the turn's first message (../lanes.ts `commentOf`).
 * `open`: the turn is still going — not answered yet.
 */
export type TurnComment = { n: number; anchor: string[]; open?: true };

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
  /** Its turn works on a canvas comment (every segment of that turn carries it). */
  comment?: TurnComment;
  /** The words a think segment says instead of 「思考」 (a PR replay: the commit's title). */
  note?: string;
  /** The files a write covers when it is one write for several (a PR replay: those of a commit that land on one node). */
  files?: { path: string; op: "add" | "edit" | "delete" | "rename"; additions?: number; deletions?: number }[];
  label: string;
};

/**
 * What the page shows for a receipt. `claimed` = a Seedmux worker says it is done (replied:done —
 * never green, not the same as accepted); `returned` = a native sub-agent handed its result back;
 * `accepted` = the dispatcher verified it (`receipt.accept`). The rest are the server's states.
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

/** One point of a run's lifecycle: the server's unified state, and whether the work was verified. */
export type Receipt = { at: number; state: RunState; accepted?: boolean };

/** How a sub-agent was dispatched, and how sure the parent link is (adapter doc §5.2). */
export type Via = "task" | "native" | "seedmux";
export type Evidence = "native" | "seedmux" | "inferred";

export type WorkRun = {
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
  children: WorkRun[];
};

/** A run with its place in the tree, as the lanes and the agent tree list them. */
export type FlatRun = { run: WorkRun; depth: number; parent: WorkRun | null; root: WorkRun };

export function flatten(roots: readonly WorkRun[]): FlatRun[] {
  const out: FlatRun[] = [];
  const walk = (r: WorkRun, depth: number, parent: WorkRun | null, root: WorkRun) => {
    out.push({ run: r, depth, parent, root });
    for (const c of r.children) walk(c, depth + 1, r, root);
  };
  for (const r of roots) walk(r, 0, null, r);
  return out;
}

/** How the page names a receipt of this run (see ReceiptState). */
export function receiptView(run: Pick<WorkRun, "via">, r: Receipt): ReceiptState {
  if (r.accepted) return "accepted";
  switch (r.state) {
    case "done":
      return run.via === "seedmux" ? "claimed" : "returned";
    case "session_changed":
    case "idle":
      return "unknown";
    default:
      return r.state;
  }
}

/** The receipt in force at t, as the page names it. */
export function receiptAt(run: WorkRun, t: number): ReceiptState | null {
  let s: ReceiptState | null = null;
  for (const r of run.receipts) if (r.at <= t) s = receiptView(run, r);
  return s;
}
