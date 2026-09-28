// What a command said when it finished (web/docs/workstation.md「新想法」): the CLI's own verdict,
// `tool.isError`, which server/canvas/adapters/ derive from each CLI's log (Claude `is_error`, Codex
// exit code ≠ 0 or a failed status, Pi `isError`, Grok the exit code), and — for a test run whose
// output the page holds in full — the pass / fail counts of the runner's last summary line (pytest,
// vitest, jest, cargo, mocha). The page gets outputs cut to a 4000-character head
// (server/canvas/sessions.py PREVIEW, `outputLen` = the full length): the summary is at the end, so a
// cut output gives the verdict only. Pure.
import type { Item } from "../session/agents";
import type { RunSeg, WorkRun } from "./runs/types";

export type ExecResult = { ok: boolean; passed?: number; failed?: number };

const COUNT = /(\d+) (passed|passing|failed|failing|errors?)\b/g;
const ANSI = /\u001b\[[0-9;]*m/g;

/** A finished call's result; null while it runs, or when its log does not say. */
export function execResult(item: Item | undefined): ExecResult | null {
  const t = item?.tool;
  if (!t || typeof t.isError !== "boolean") return null;
  const out: ExecResult = { ok: !t.isError };
  const text = t.output ?? "";
  if (t.outputLen != null && t.outputLen > text.length) return out;
  const lines = text.replace(ANSI, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const hits = [...lines[i].matchAll(COUNT)];
    if (!hits.length) continue;
    for (const [, n, word] of hits) {
      if (word.startsWith("pass")) out.passed = (out.passed ?? 0) + Number(n);
      else out.failed = (out.failed ?? 0) + Number(n);
    }
    break;
  }
  return out;
}

/** A run's finished commands and their results, by segment (from its session's transcript items).
 * Only top-level runs have their items on the page: a sub-agent's are used once by the run tree
 * (runs/derive.ts `fromTree`) and not kept. */
export function execResults(run: WorkRun, items: readonly Item[]): Map<RunSeg, ExecResult> {
  const byId = new Map(items.map((it) => [it.id, it]));
  const out = new Map<RunSeg, ExecResult>();
  for (const g of run.segs) {
    if (g.kind !== "exec" || !g.itemId) continue;
    const r = execResult(byId.get(g.itemId));
    if (r) out.set(g, r);
  }
  return out;
}
