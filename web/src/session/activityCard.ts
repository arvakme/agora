// 进行中的一轮 as one card (web/docs/workstation.md §15 过程展示): instead of a row per tool call, the action in progress and a line of
// what is done so far. This is the model both the card and the bar above the composer read, so there is one account of "what it is doing".
// Pure apart from the per-session 「过程：简洁 / 详细」 choice and the turns the person left expanded (this browser only).
import { ACTIVITY_NOW, toolActivity, type Activity, type TrajRecord, type TrajTurn } from "./trajectoryModel";

export type Bucket = "command" | "read" | "edit" | "subagent" | "other";
const BUCKET: Record<Activity, Bucket> = { commands: "command", read: "read", search: "read", write: "edit", edit: "edit", subagents: "subagent", webSearch: "other", webFetch: "other", plan: "other", questions: "other", tools: "other" };
const LABEL: Record<Bucket, string> = { command: "命令", read: "读", edit: "改", subagent: "子代理", other: "其他" };
const ORDER: Bucket[] = ["command", "read", "edit", "subagent", "other"];

export type ActivityModel = {
  running: boolean;
  /** It has a question or an approval open with the person. */
  waiting: boolean;
  /** Tool calls so far, and the finished ones among them. */
  total: number;
  done: number;
  /** Finished calls by kind. */
  counts: Record<Bucket, number>;
  /** The newest call still running; null between calls (the agent is thinking). */
  current: TrajRecord | null;
  /** Failed calls: never folded away. */
  failed: TrajRecord[];
  title: string;
  stats: string;
  /** What the bar above the composer says. */
  now: string;
};

export function statsLine(counts: Record<Bucket, number>): string {
  const done = ORDER.reduce((n, b) => n + counts[b], 0);
  if (!done) return "还没有动作";
  return `已完成 ${done} 个动作：${ORDER.filter((b) => counts[b]).map((b) => `${LABEL[b]} ${counts[b]}`).join(" · ")}`;
}

export function activityModel(turn: TrajTurn, o: { waiting?: boolean } = {}): ActivityModel {
  const tools = turn.steps.flatMap((s) => s.records).filter((r) => r.kind === "tool");
  const counts: Record<Bucket, number> = { command: 0, read: 0, edit: 0, subagent: 0, other: 0 };
  for (const r of tools) if (!r.running) counts[BUCKET[toolActivity(r.item)]] += 1;
  const current = turn.running ? ([...tools].reverse().find((r) => r.running) ?? null) : null;
  const waiting = !!o.waiting && turn.running;
  return {
    running: turn.running,
    waiting,
    total: tools.length,
    done: tools.filter((r) => !r.running).length,
    counts,
    current,
    failed: tools.filter((r) => r.isError),
    title: waiting ? "等你回答" : ACTIVITY_NOW[current ? toolActivity(current.item) : "thinking"],
    stats: statsLine(counts),
    now: waiting ? "等你回答" : (current?.text ?? "正在想…"),
  };
}

// ——— 过程：简洁 / 详细, per session ———
export type ProcessMode = "brief" | "detail";
const KEY = "agora.processMode";
const KEEP = 200;
const readAll = (): Record<string, ProcessMode> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter(([, m]) => m === "brief" || m === "detail")) as Record<string, ProcessMode>;
  } catch {
    return {};
  }
};
let chosen = readAll();
const listeners = new Set<() => void>();
/** The person's choice for each session in this browser (never written into the project); a session with none, old ones included, is brief. */
export const processMode = {
  get: (sessionId: string): ProcessMode => chosen[sessionId] ?? "brief",
  set(sessionId: string, mode: ProcessMode) {
    const { [sessionId]: _, ...rest } = chosen;
    chosen = Object.fromEntries(Object.entries({ ...rest, [sessionId]: mode }).slice(-KEEP));
    try {
      localStorage.setItem(KEY, JSON.stringify(chosen));
    } catch {
      /* private window: this page only */
    }
    listeners.forEach((l) => l());
  },
  /** Read the storage again (tests; another tab's choice). */
  reload() {
    chosen = readAll();
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
};

// ——— a turn the person expanded while it ran stays expanded when it ends ———
const opened = new Set<string>();
const turnKey = (sessionId: string, n: number) => `${sessionId}#${n}`;
export const keepOpen = (sessionId: string, n: number, on: boolean) => void (on ? opened.add(turnKey(sessionId, n)) : opened.delete(turnKey(sessionId, n)));
export const wasKeptOpen = (sessionId: string, n: number) => opened.has(turnKey(sessionId, n));
