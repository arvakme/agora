// Trajectory model: a native session's transcript items folded into turns → steps → records,
// plus the per-turn process summary and the timeline projection.
//
// Information structure follows DeepSeek Harness (github.com/deepseek-ai/deepseek-harness,
// MIT, commit 477b4f4), rewritten for Agora's transcript items:
//   - turns → "Message" / "Step N" groups → records, each group described as
//     "<wall span> <tool>×<count>"            packages/client/ui-trajectory/src/client/layout.ts
//                                             (deriveTrajectoryLayout, groupDescription)
//   - timeline: records projected to lanes (user / message / tool), either one slot per record
//     ("sequence") or recorded start + duration with idle gaps between records removed
//     ("duration")                            ui-trajectory/src/client/timeline.ts
//   - per-turn process summary: tool calls counted by activity, top three named
//     ("读取了文件，修改了文件并执行了命令等")    ui-chat/src/client/conversation-nodes/process-activity.ts,
//                                             ui-chat/src/client/chat/step-process.ts
// Only what the log recorded is shown: unknown durations, tokens or costs stay null.
import type { FileOp, Item, Usage } from "./agents";

export type RecordKind = "user" | "message" | "tool";
export type TrajRecord = {
  /** 1-based, across the whole session (DSH `#N`). */
  index: number;
  id: string;
  kind: RecordKind;
  text: string;
  at: number;
  durationMs: number | null;
  isError: boolean;
  running: boolean;
  item: Item;
};
export type TrajStep = { n: number; records: TrajRecord[]; startedAt: number; endedAt: number; description: string };
export type UsageSum = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; cost: number | null; requests: number };
export type FileTouch = { path: string; op: FileOp; at: number; toolId: string; turn: number };
export type Activity = "read" | "search" | "write" | "edit" | "commands" | "webSearch" | "webFetch" | "subagents" | "plan" | "questions" | "tools";
export type TrajTurn = {
  n: number;
  user?: Item;
  source?: "agora" | "terminal";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  running: boolean;
  error?: string;
  model: string | null;
  effort: string | null;
  usage: UsageSum;
  steps: TrajStep[];
  /** The final answer (shown outside the folded process in the conversation view). */
  reply?: Item;
  toolCount: number;
  messageCount: number;
  activity: { kind: Activity; count: number }[];
  files: FileTouch[];
  /** Lines the server adds to the conversation: an action auto mode blocked, a turn a restart ended. */
  notices?: Item[];
};

const emptyUsage = (): UsageSum => ({ input: null, output: null, cacheRead: null, cacheWrite: null, cost: null, requests: 0 });
const add = (a: number | null, b: number | null | undefined) => (b == null ? a : (a ?? 0) + b);
export function addUsage(sum: UsageSum, u: Partial<Usage> | undefined) {
  if (!u) return;
  sum.input = add(sum.input, u.inputTokens);
  sum.output = add(sum.output, u.outputTokens);
  sum.cacheRead = add(sum.cacheRead, u.cacheReadTokens);
  sum.cacheWrite = add(sum.cacheWrite, u.cacheWriteTokens);
  sum.cost = add(sum.cost, u.costUsd);
  sum.requests += 1;
}
export function sumUsage(turns: TrajTurn[]): UsageSum {
  const s = emptyUsage();
  for (const t of turns) {
    s.input = add(s.input, t.usage.input);
    s.output = add(s.output, t.usage.output);
    s.cacheRead = add(s.cacheRead, t.usage.cacheRead);
    s.cacheWrite = add(s.cacheWrite, t.usage.cacheWrite);
    s.cost = add(s.cost, t.usage.cost);
    s.requests += t.usage.requests;
  }
  return s;
}

const ACTIVITIES: ReadonlySet<string> = new Set(["read", "search", "write", "edit", "commands", "webFetch", "webSearch", "subagents", "plan", "questions", "tools"]);
/** A tool item's activity: the server's `tool.activity` (adapters know their CLI's names), else by name. */
export function toolActivity(it: Item): Activity {
  const a = it.tool?.activity;
  return a && ACTIVITIES.has(a) ? (a as Activity) : activityOf(it.tool?.name);
}

/** Fallback for items without `tool.activity` (older snapshots): tool name → activity (DSH process-activity.ts `activity`, extended with Claude Code / Pi / Codex names). */
export function activityOf(name = ""): Activity {
  const n = name.toLowerCase();
  if (n === "read" || n === "read_file" || n === "view") return "read";
  if (["grep", "glob", "find", "ls", "search", "list"].includes(n) || n.endsWith("_inspect")) return "search";
  if (n === "write" || n === "write_file") return "write";
  if (["edit", "multiedit", "multi_edit", "apply_patch", "notebookedit", "str_replace"].includes(n)) return "edit";
  if (["bash", "shell", "pwsh", "exec", "exec_command", "write_stdin", "bashoutput", "killshell"].includes(n) || n.startsWith("terminal_")) return "commands";
  if (n === "websearch" || n === "web_search") return "webSearch";
  if (n === "webfetch" || n === "web_fetch") return "webFetch";
  if (n === "task" || n === "agent" || n === "subagent" || n.startsWith("subagent_")) return "subagents";
  if (["todowrite", "update_plan", "todo_write"].includes(n)) return "plan";
  if (n === "askuserquestion" || n === "ask_user_question" || n === "request_user_input") return "questions";
  return "tools";
}
/** Past-tense labels (DSH ui-chat locale `message.stepProcess.done.*`, zh). */
export const ACTIVITY_DONE: Record<Activity | "thinking", string> = {
  thinking: "已完成分析",
  read: "已读取文件",
  search: "已搜索代码",
  write: "已写入文件",
  edit: "修改了文件",
  commands: "执行了命令",
  webSearch: "已搜索网页",
  webFetch: "已访问网页",
  subagents: "已协调子智能体",
  plan: "更新了计划",
  questions: "向用户提出了问题",
  tools: "已调用工具",
};
/** Present-tense labels for a turn still running (`message.stepProcess.*`). */
export const ACTIVITY_NOW: Record<Activity | "thinking", string> = {
  thinking: "正在分析请求",
  read: "正在读取文件",
  search: "正在搜索代码",
  write: "正在写入文件",
  edit: "正在编辑文件",
  commands: "正在运行命令",
  webSearch: "正在搜索网页",
  webFetch: "正在访问网页",
  subagents: "正在协调子智能体",
  plan: "正在更新计划",
  questions: "等待你的操作",
  tools: "正在调用工具",
};

/** DSH step-process.ts `processTitle`: the top three activities, "{first}并{second}", "…等". */
export function processTitle(activity: TrajTurn["activity"]): string {
  const labels = activity.slice(0, 3).map(({ kind }) => ACTIVITY_DONE[kind]);
  if (!labels.length) return ACTIVITY_DONE.thinking;
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) {
    const shared = labels[0].startsWith("已") && labels[1].startsWith("已");
    return `${labels[0]}并${shared ? labels[1].slice(1) : labels[1]}`;
  }
  const title = labels.join("，");
  return activity.length > 3 ? `${title}等` : title;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m ${s} s`;
}
export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
export const fmtCost = (c: number | null | undefined) => (c == null ? "—" : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);

/** Wall span + tool histogram, e.g. `1.5 s Bash×6 Edit` (DSH layout.ts `groupDescription`). */
function stepDescription(records: TrajRecord[]): string {
  const times: number[] = [];
  for (const r of records) {
    times.push(r.at);
    if (r.durationMs != null) times.push(r.at + r.durationMs);
  }
  const parts: string[] = [];
  if (times.length >= 2 && Math.max(...times) > Math.min(...times)) parts.push(fmtDuration(Math.max(...times) - Math.min(...times)));
  const tools = new Map<string, number>();
  for (const r of records) if (r.kind === "tool") tools.set(r.item.tool?.name || "tool", (tools.get(r.item.tool?.name || "tool") ?? 0) + 1);
  for (const [name, count] of tools) parts.push(count > 1 ? `${name}×${count}` : name);
  return parts.join(" ");
}

const oneLine = (s = "") => s.replace(/\s+/g, " ").trim();

/**
 * Fold transcript items into turns. `defaults` is the session's binding (model and effort used
 * until the log says otherwise); `live` marks the session as still answering (last turn running).
 */
export function buildTurns(items: readonly Item[], defaults: { model?: string | null; effort?: string | null } = {}, live = false): TrajTurn[] {
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => a.it.at - b.it.at || a.i - b.i).map((x) => x.it);
  const turns: TrajTurn[] = [];
  let model: string | null = defaults.model || null;
  let effort: string | null = defaults.effort || null;
  let index = 0;
  let cur: TrajTurn | null = null;
  let step: TrajStep | null = null;
  let stepKey: string | null = null;
  const runs = new Map<TrajTurn, Item[]>();
  const logUsage = new Set<TrajTurn>();
  const counts = new Map<TrajTurn, Map<Activity, number>>();

  const open = (at: number, user?: Item): TrajTurn => {
    const t: TrajTurn = {
      n: turns.length + 1,
      user,
      source: user?.source,
      startedAt: at,
      endedAt: null,
      durationMs: null,
      running: false,
      model,
      effort,
      usage: emptyUsage(),
      steps: [],
      toolCount: 0,
      messageCount: 0,
      activity: [],
      files: [],
    };
    turns.push(t);
    step = null;
    stepKey = null;
    return t;
  };
  const record = (t: TrajTurn, it: Item, kind: RecordKind, text: string, durationMs: number | null): TrajRecord => ({
    index: ++index,
    id: it.id,
    kind,
    text,
    at: it.at,
    durationMs,
    isError: !!it.tool?.isError,
    running: kind === "tool" && it.tool?.output === undefined && !it.endAt,
    item: it,
  });
  const inStep = (t: TrajTurn, key: string | null, fresh: boolean): TrajStep => {
    if (!step || fresh || (key !== null && key !== stepKey) || (key === null && stepKey !== null)) {
      step = { n: t.steps.filter((x) => x.n > 0).length + 1, records: [], startedAt: 0, endedAt: 0, description: "" };
      t.steps.push(step);
      stepKey = key;
    }
    return step;
  };

  for (const it of sorted) {
    if (it.kind === "context") {
      if (it.model) model = it.model;
      if (it.effort) effort = it.effort;
      if (cur && !cur.steps.length) {
        cur.model = model;
        cur.effort = effort;
      }
      continue;
    }
    if (it.kind === "user") {
      cur = open(it.at, it);
      cur.steps.push({ n: 0, records: [record(cur, it, "user", oneLine(it.text), null)], startedAt: it.at, endedAt: it.at, description: "" });
      step = null;
      continue;
    }
    if (it.kind === "run") {
      if (cur) runs.set(cur, [...(runs.get(cur) ?? []), it]);
      continue;
    }
    if (it.kind === "notice") {
      if (cur) cur.notices = [...(cur.notices ?? []), it];
      continue;
    }
    if (!cur) cur = open(it.at);
    const t: TrajTurn = cur;
    if (it.kind === "usage") {
      addUsage(t.usage, it.usage);
      logUsage.add(t);
      if (it.usage?.model) t.model = it.usage.model;
      continue;
    }
    if (it.kind === "end") {
      t.endedAt = it.at;
      t.durationMs = it.durationMs ?? it.at - t.startedAt;
      if (it.error) t.error = it.error;
      continue;
    }
    if (it.kind === "assistant") {
      const s = inStep(t, it.msg ?? null, !it.msg);
      s.records.push(record(t, it, "message", oneLine(it.text), null));
      t.messageCount += 1;
      t.reply = it;
      continue;
    }
    if (it.kind === "tool") {
      const s = inStep(t, it.msg ?? null, false);
      const dur = it.endAt && it.endAt >= it.at && !it.durationInferred ? it.endAt - it.at : null;
      const name = it.tool?.name || "tool";
      s.records.push(record(t, it, "tool", `${name} ${oneLine(it.tool?.input)}`.trim(), dur));
      t.toolCount += 1;
      const c = counts.get(t) ?? new Map<Activity, number>();
      const act = toolActivity(it);
      c.set(act, (c.get(act) ?? 0) + 1);
      counts.set(t, c);
      if (!it.tool?.isError) for (const f of it.tool?.files ?? []) t.files.push({ path: f.path, op: f.op, at: it.at, toolId: it.id, turn: t.n });
      if (t.reply && t.reply.at <= it.at) t.reply = undefined; // a tool call after the text: that text was not the final answer
    }
  }

  const lastAt = (t: TrajTurn) => Math.max(t.startedAt, ...t.steps.flatMap((s) => s.records.map((r) => r.at + (r.durationMs ?? 0))));
  turns.forEach((t, i) => {
    for (const s of t.steps) {
      if (!s.records.length) continue;
      s.startedAt = Math.min(...s.records.map((r) => r.at));
      s.endedAt = Math.max(...s.records.map((r) => r.at + (r.durationMs ?? 0)));
      s.description = s.n > 0 ? stepDescription(s.records) : "";
    }
    t.steps = t.steps.filter((s) => s.records.length);
    t.activity = [...(counts.get(t) ?? new Map())].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
    // The runner's own accounting for headless turns: cost (Claude only reports it there), and
    // tokens / wall time when the log had none.
    for (const r of runs.get(t) ?? []) {
      const u = r.usage;
      if (!u) continue;
      if (t.usage.cost == null && u.costUsd != null) t.usage.cost = u.costUsd;
      if (!logUsage.has(t)) addUsage(t.usage, { ...u, costUsd: null });
      if (t.durationMs == null && u.durationMs != null) t.durationMs = u.durationMs;
      if (u.model && !t.model) t.model = u.model;
    }
    const isLast = i === turns.length - 1;
    t.running = isLast && t.endedAt == null && live;
    if (t.endedAt == null && !t.running && t.durationMs == null && t.steps.length > 1) t.durationMs = lastAt(t) - t.startedAt;
    if (t.running) t.reply = undefined;
  });
  return turns;
}

/** Every file a session's tool calls wrote, newest last. */
export const filesOf = (turns: TrajTurn[]): FileTouch[] => turns.flatMap((t) => t.files).sort((a, b) => a.at - b.at);

// ——— timeline (DSH timeline.ts) ———
export type TimelineMode = "sequence" | "duration";
export type Span = { start: number; end: number; index: number; kind: RecordKind; lane: number; isError: boolean; label: string; turn: number };
export type TimelineModel = { start: number; end: number; spans: Span[]; turnBoundaries: { turn: number; at: number }[] };
const laneFor = (k: RecordKind) => (k === "tool" ? 2 : k === "message" ? 1 : 0);

export function deriveTimeline(turns: TrajTurn[], mode: TimelineMode): TimelineModel | null {
  const recs = turns.flatMap((t) => t.steps.flatMap((s) => s.records.map((r) => ({ r, turn: t.n }))));
  if (!recs.length) return null;
  const spans: Span[] = [];
  const turnBoundaries: { turn: number; at: number }[] = [];
  if (mode === "sequence") {
    let seen = -1;
    recs.forEach(({ r, turn }, i) => {
      if (turn !== seen) turnBoundaries.push({ turn, at: i });
      seen = turn;
      spans.push({ start: i, end: i + 1, index: r.index, kind: r.kind, lane: laneFor(r.kind), isError: r.isError, label: r.text, turn });
    });
    return { start: 0, end: recs.length, spans, turnBoundaries };
  }
  // Recorded time with idle gaps removed (a turn that waited an hour for the person does not
  // squash every other record into a sliver).
  const raw = recs.map(({ r, turn }) => ({ r, turn, start: r.at, end: r.at + (r.durationMs ?? 0) })).sort((a, b) => a.start - b.start || a.end - b.end);
  let removed = 0;
  let covered: number | null = null;
  const MIN_GAP = 1500;
  for (const x of raw) {
    if (covered !== null && x.start > covered + MIN_GAP) removed += x.start - covered - MIN_GAP;
    const s = x.start - removed;
    const e = x.end - removed;
    spans.push({ start: s, end: e, index: x.r.index, kind: x.r.kind, lane: laneFor(x.r.kind), isError: x.r.isError, label: x.r.text, turn: x.turn });
    covered = covered === null ? x.end : Math.max(covered, x.end);
  }
  for (const t of turns) {
    const own = spans.filter((s) => s.turn === t.n);
    if (own.length) turnBoundaries.push({ turn: t.n, at: Math.min(...own.map((s) => s.start)) });
  }
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end), start + 1);
  return { start, end, spans, turnBoundaries };
}

/** Record indexes active anywhere inside [a, b] (DSH `trajectoryTimelineFocusIndexes`). */
export const focusIndexes = (model: TimelineModel, a: number, b: number) =>
  new Set(model.spans.filter((s) => s.start <= b && s.end >= a).map((s) => s.index));
