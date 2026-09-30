// What the floating panel's title bar and bottom bar say about the session (web/docs/workstation.md §15): the state and how long it has been idle, and the last thing said.
import type { Item } from "./agents";

export type StatusLine = { text: string; tone: "work" | "wait" | "idle" };

const ago = (ms: number) => {
  const s = ms / 1000;
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时`;
  return `${Math.round(s / 86400)} 天`;
};

/** 思考中 / 等你回答 / 排队中, or 空闲 and how long since it last did anything. */
export function statusLine(a: { running: boolean; busy: boolean; waiting: boolean; held: boolean; lastAt: number | null; now: number }): StatusLine {
  if (a.waiting) return { text: "等你回答", tone: "wait" };
  if (a.running || a.busy) return { text: "思考中", tone: "work" };
  if (a.held) return { text: "排队中", tone: "work" };
  return { text: a.lastAt == null ? "空闲" : `空闲 · ${ago(a.now - a.lastAt)}`, tone: "idle" };
}

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
/** The agent's last words on one line; else what the person said last; cards the page wrote are not words. */
export function lastSaid(items: readonly Item[]): string {
  const words = items.filter((i) => i.text && !i.card && (i.kind === "assistant" || i.kind === "user"));
  const said = [...words].reverse().find((i) => i.kind === "assistant") ?? words.at(-1);
  return said?.text ? oneLine(said.text) : "";
}
