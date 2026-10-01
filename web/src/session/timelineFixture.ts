// Test fixture for the trajectory overview: a deterministic conversation of any length.
import type { Item } from "./agents.ts";
import { buildTurns, deriveTimeline, type TimelineMode } from "./trajectoryModel.ts";

/** A deterministic long conversation: `turns` turns, each a user line, then `per` actions spread over a few model steps. */
const KINDS = ["Read", "Bash", "Edit", "Bash", "Read", "Grep", "Write", "Task", "AskUserQuestion", "Bash"] as const;
export function convo(turns: number, per: number, opts: { fail?: (turn: number, i: number) => boolean; slow?: boolean } = {}): Item[] {
  const items: Item[] = [];
  let at = 1_700_000_000_000;
  for (let t = 0; t < turns; t++) {
    items.push({ id: `u${t}`, kind: "user", text: `第 ${t + 1} 句`, at, source: "agora" });
    at += 800;
    for (let i = 0; i < per; i++) {
      const msg = `m${t}-${Math.floor(i / 4)}`;
      if (i % 4 === 0) {
        items.push({ id: `a${t}-${i}`, kind: "assistant", text: "想一下", at, msg });
        at += 300;
      }
      const name = opts.slow ? (i % 5 === 0 ? "Bash" : "Read") : KINDS[(t * 7 + i) % KINDS.length];
      const dur = opts.slow ? (i % 5 === 0 ? 9000 : 3) : 60 + ((t + i) % 5) * 40;
      items.push({ id: `t${t}-${i}`, kind: "tool", at, endAt: at + dur, msg, tool: { name, input: `arg-${i}`, output: "ok", isError: opts.fail?.(t, i) || undefined } });
      at += dur + 20;
    }
    items.push({ id: `e${t}`, kind: "end", at, durationMs: 1000, turn: `u${t}` });
    at += 5000;
  }
  return items;
}
export const modelOf = (items: Item[], mode: TimelineMode = "sequence") => deriveTimeline(buildTurns(items, {}, false), mode)!;

