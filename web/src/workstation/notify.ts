// 等你就叫你 (web/docs/workstation.md「新想法」): which waits to tell the person about while the page is
// hidden — a worker that began waiting on them after `since` (when the page was last in view) and
// still waits at `now`, not told before (`told` holds the keys already announced: one per wait
// segment, `run|start`). ./WaitNotifier.tsx raises the system notification. Pure.
import type { FlatRun } from "./runs/types";

export type WaitNote = { key: string; runId: string; sessionId?: string; title: string; body: string };

export function waitsToTell(flat: readonly FlatRun[], since: number, now: number, told: ReadonlySet<string>): WaitNote[] {
  const out: WaitNote[] = [];
  for (const f of flat)
    for (const g of f.run.segs) {
      if (g.kind !== "wait" || g.start < since || g.start > now || now >= g.end) continue;
      const key = `${f.run.id}|${g.start}`;
      if (told.has(key)) continue;
      // a space between a Latin name and the Chinese, none after the full-width bracket
      const who = f.parent ? `${f.run.name}（${f.parent.name} 派）` : `${f.run.name} `;
      out.push({ key, runId: f.run.id, sessionId: f.root.sessionId, title: "Agora", body: g.question ? `${who}在等你：${g.question}` : `${who}在等你回复` });
    }
  return out;
}
