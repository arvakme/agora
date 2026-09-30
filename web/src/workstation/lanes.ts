// 工位视图 lanes (web/docs/workstation.md): one session's transcript (the CLI's own log,
// server/canvas/transcript.py) as read / write / exec / think / wait / delegate segments. The
// same log always gives the same lane; ./runs/derive.ts turns it into a top-level run. A turn that
// works on a canvas comment says so in its first message, so its segments carry that comment.
import type { Item } from "../session/agents";
import { buildTurns, toolActivity, type TrajTurn } from "../session/trajectoryModel";
import type { TurnComment } from "./runs/types";

/** What a worker is doing: reading, writing, running a command, thinking, waiting for the person, or nothing. */
export type SegKind = "read" | "write" | "exec" | "think" | "wait" | "delegate";
export type Seg = {
  sessionId: string;
  kind: SegKind;
  start: number;
  end: number;
  /** Turn number (as in the trajectory, 1-based). */
  turn: number;
  /** The transcript item behind it (tool calls); thinking has none. */
  itemId?: string;
  /** Project-relative file it read or wrote, when known. */
  path?: string;
  /** The call reported no real length (`durationMs` missing or 0): `end` is the padded minimum. */
  durationKnown?: false;
  label: string;
  /** Command line (exec), question (wait), task (delegate): the call's one-line input. */
  input?: string;
  /** Its turn works on a canvas comment (`commentOf` its first message). */
  comment?: TurnComment;
};
export type Lane = { sessionId: string; segs: Seg[]; turns: { n: number; start: number; end: number }[] };

export const SEG_NAMES: Record<SegKind | "idle", string> = { read: "读", write: "写", exec: "执行命令", think: "思考", wait: "等待用户", delegate: "派子代理", idle: "空闲" };

const MIN_TOOL_MS = 600;
const MIN_THINK_MS = 400;

const KIND: Record<string, SegKind> = {
  read: "read",
  search: "read",
  webFetch: "read",
  webSearch: "read",
  write: "write",
  edit: "write",
  commands: "exec",
  tools: "exec",
  subagents: "delegate",
  plan: "think",
  questions: "wait",
};

/** Fallback for items without `tool.reads` (older snapshots): a read tool's file from its one-line input (Claude `file_path`, Pi `path`), relative to the project. */
export function readPath(input: string | undefined, root: string | undefined): string | undefined {
  const s = (input ?? "").trim();
  if (!s || /\s/.test(s) || !/[/.]/.test(s) || s.startsWith("{")) return undefined;
  const r = root?.replace(/\/+$/, "");
  if (r && s.startsWith(`${r}/`)) return s.slice(r.length + 1);
  return s.startsWith("/") ? s : s.replace(/^\.\//, "");
}

const base = (p: string) => p.split("/").pop() || p;

/**
 * The canvas comment a turn works on, from its first message: 「交给 Agent」 sends
 * 「画布评论 #n（锚点：名字（id）、名字（id））：」 as its first line (../comments/handoff.ts
 * `commentMessage`; 「锚点：整块画布」 has no elements). Undefined for any other message.
 */
export function commentOf(text: string | undefined): TurnComment | undefined {
  const m = /^画布评论 #(\d+)（锚点：(.*)）：$/.exec((text ?? "").split("\n", 1)[0].trim());
  if (!m) return undefined;
  // each anchor ends with its id in brackets, before the next 「、」 or the end (a name may have brackets of its own)
  return { n: Number(m[1]), anchor: [...m[2].matchAll(/（([^（）、\s]+)）(?=、|$)/g)].map((x) => x[1]) };
}

/** One session's lane: tool calls as read / write / exec / wait, the time between them in a turn as thinking. */
export function buildLane(sessionId: string, items: readonly Item[], opts: { live?: boolean; now?: number; root?: string } = {}): Lane {
  const now = opts.now ?? Date.now();
  const turns: TrajTurn[] = buildTurns(items, {}, !!opts.live);
  const segs: Seg[] = [];
  const spans: Lane["turns"] = [];
  for (const t of turns) {
    const recs = t.steps.flatMap((s) => s.records);
    const lastEnd = Math.max(t.startedAt, ...recs.map((r) => r.at + (r.durationMs ?? 0)));
    const end = t.endedAt ?? (t.running ? now : lastEnd);
    spans.push({ n: t.n, start: t.startedAt, end: Math.max(end, t.startedAt) });
    const c = commentOf(t.user?.text);
    const on = c ? { comment: t.running ? { ...c, open: true as const } : c } : {};
    const tools = recs
      .filter((r) => r.kind === "tool")
      .map((r) => {
        const it = r.item;
        // Server tool facts (server/canvas/adapters/): activity, reads, waitsUser — the page needs no CLI tool names.
        const kind: SegKind = it.tool?.waitsUser ? "wait" : (KIND[toolActivity(it)] ?? "exec");
        const dur = r.durationMs ?? (r.running ? now - r.at : MIN_TOOL_MS);
        const file = it.tool?.files?.[0]?.path;
        const path = kind === "write" ? file : kind === "read" ? (it.tool?.reads?.[0] ?? readPath(it.tool?.input, opts.root)) : (file ?? (kind === "exec" ? it.tool?.on?.[0] : undefined));
        const verb = SEG_NAMES[kind];
        const input = (it.tool?.input ?? "").replace(/\s+/g, " ").trim();
        return { sessionId, kind, start: r.at, end: r.at + Math.max(dur, MIN_TOOL_MS), turn: t.n, itemId: it.id, ...(path ? { path } : {}), ...(!r.running && !(r.durationMs && r.durationMs > 0) ? { durationKnown: false as const } : {}), ...(input && (!path || kind === "exec") ? { input } : {}), ...on, label: path ? `${verb} ${base(path)}` : `${verb} · ${it.tool?.name ?? "工具"} ${it.tool?.input ?? ""}`.trim() } as Seg;
      })
      .sort((a, b) => a.start - b.start);
    // Parallel calls in one step are shown one after another: a worker does one thing at a time.
    let cursor = t.startedAt;
    for (const s of tools) {
      if (s.start < cursor) {
        const d = s.end - s.start;
        s.start = cursor;
        s.end = cursor + d;
      }
      if (s.start - cursor >= MIN_THINK_MS) segs.push({ sessionId, kind: "think", start: cursor, end: s.start, turn: t.n, ...on, label: SEG_NAMES.think });
      segs.push(s);
      cursor = s.end;
    }
    const turnEnd = Math.max(end, cursor);
    if (turnEnd - cursor >= MIN_THINK_MS) segs.push({ sessionId, kind: "think", start: cursor, end: turnEnd, turn: t.n, ...on, label: SEG_NAMES.think });
    spans[spans.length - 1].end = turnEnd;
  }
  return { sessionId, segs, turns: spans };
}
