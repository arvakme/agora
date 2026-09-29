// What the 工位视图 draws: a top-level Agora session and, below it, the sub-agents it dispatched —
// native (Claude Agent / Task, Codex spawn), sessions it gave a task to (`agora dispatch`), and theirs. This is a view model:
// the one wire shape is the server's `RunTree` / `AgentRun` (session/agents.ts, `fetchRuns`,
// web/docs/cli-adapters.md §5), converted once in ./derive.ts (`fromTree`). The receipt states are
// the server's unified `RunState`; what the page says for them (已返回结果 vs 验收通过)
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
  /** When this page first had the call (wall clock, ms). A live call reaches the page a moment after it began (the log, the server, the stream): a move for
   * it starts then, not at `start`, which is already past — otherwise its cut or its first steps would be over before they could be drawn (./place.ts `startOf`). */
  seen?: number;
  /** Project-relative file read or written. */
  path?: string;
  /** The call reported no real length (a Codex command with the same start and end): `end` is a padded minimum, so it is not a short read. */
  durationKnown?: false;
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
  /** What the bubble says for this stretch, in words (the build replay, ../../buildreplay/plan.ts: there is no file or command to name). */
  say?: string;
  label: string;
};

/**
 * What the page shows for a receipt. `claimed` = a worker says it is done (never green, not the
 * same as accepted); `returned` = a native sub-agent handed its result back; `accepted` = the
 * dispatcher verified it (`receipt.accepted`). The rest are the server's states.
 */
export type ReceiptState =
  | "dispatched"
  | "acknowledged"
  | "running"
  | "waiting"
  | "idle_no_reply"
  | "interrupted"
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
  idle_no_reply: "停了，没交回执",
  interrupted: "已中断",
  claimed: "声明完成",
  accepted: "验收通过",
  returned: "已返回结果",
  failed: "失败",
  blocked: "受阻",
  exited: "无回复退出",
  unknown: "状态不明",
};
/**
 * The words for a receipt on a sub-agent: sent but not yet taken says who has to take it (no tick, no
 * "idle": nothing has been done yet); the rest are `RECEIPT_NAMES`.
 */
export const receiptText = (run: Pick<WorkRun, "name" | "parentId">, r: ReceiptState): string => (r === "dispatched" && run.parentId ? `等 ${run.name} 接手` : RECEIPT_NAMES[r]);

/** One point of a run's lifecycle: the server's unified state, and whether the work was verified. */
export type Receipt = { at: number; state: RunState; accepted?: boolean };

/** How a sub-agent was dispatched, and how sure the parent link is (adapter doc §5.2). */
export type Via = "task" | "native" | "dispatch";
export type Evidence = "native" | "dispatch" | "inferred";

export type WorkRun = {
  /** `kind:nativeId`, or the Agora session id for a derived top-level run. */
  id: string;
  /** Agent kind: pi, claude, codex, or any other CLI's kind. */
  agent: string;
  name: string;
  /** The Agora session (top-level runs only). */
  sessionId?: string;
  parentId?: string;
  /** A run a dispatch gave to an Agora session: which session (that session is not drawn a second time as a top-level run). */
  dispatchSession?: string;
  via?: Via;
  evidence?: Evidence;
  /** What it was asked to do (sub-agents). */
  task?: string;
  /** Known only by its receipts: no tool calls, so it never walks. */
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
      return "returned";
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
