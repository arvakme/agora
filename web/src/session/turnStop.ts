import { lang, tr } from "../i18n";

// The error text of a turn the server stopped for going quiet or running past its fuse (server/canvas/turn_clock.py
// `TurnClock.message`). The native session is intact, so the panel offers 继续: the word goes out as the next message.
export const CONTINUE_WORD = tr("继续", "Continue");

const STOPPED = /^这一轮.*，已中止；原生会话还在，发「继续」就能接着$/;

export function stoppedForTime(error: string | null | undefined): boolean {
  return !!error && STOPPED.test(error);
}

const UNIT: Record<string, [string, string]> = { 小时: ["hour", "hours"], 分钟: ["minute", "minutes"], 秒: ["second", "seconds"] };
const enSpan = (n: string, unit: string) => `${n} ${UNIT[unit]?.[n === "1" ? 0 : 1] ?? unit}`;

/** That stop text in the interface language (the server writes it in Chinese); any other text as it is. */
export function stopText(error: string): string {
  if (!stoppedForTime(error) || lang() === "zh") return error;
  const max = /^这一轮已经跑了 ([\d.]+) (小时|分钟|秒)，到了上限/.exec(error);
  if (max) return `This turn ran for ${enSpan(max[1], max[2])} and hit the limit, so it was stopped; the native session is intact — send “${CONTINUE_WORD}” to pick up where it left off`;
  const idle = /^这一轮 ([\d.]+) (小时|分钟|秒)没有任何输出/.exec(error);
  if (idle) return `This turn had no output for ${enSpan(idle[1], idle[2])}, so it was stopped; the native session is intact — send “${CONTINUE_WORD}” to pick up where it left off`;
  return error;
}
