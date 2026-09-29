// The sub-agents a turn dispatched, listed under that turn in the trajectory. Pure.
import type { WorkRun } from "../workstation/runs/types";

/**
 * Which turn each sub-agent of `run` belongs to: the turn of the delegate call that dispatched it (the run's
 * segments carry the turn and the child); without one, the latest turn that had started when it was dispatched.
 * Claude's Task, Codex's collaborators and Seedmux workers all come as `children`.
 */
export function kidsByTurn(run: Pick<WorkRun, "children" | "segs">, turns: readonly { n: number; startedAt: number }[]): Map<number, WorkRun[]> {
  const out = new Map<number, WorkRun[]>();
  const known = new Set(turns.map((t) => t.n));
  for (const kid of run.children) {
    const call = run.segs.find((s) => s.kind === "delegate" && s.child === kid.id && s.turn != null && known.has(s.turn));
    let n = call?.turn;
    if (n == null && kid.spawnAt != null) {
      const at = kid.spawnAt;
      n = turns.filter((t) => t.startedAt <= at).sort((a, b) => b.startedAt - a.startedAt)[0]?.n;
    }
    if (n == null) continue;
    out.set(n, [...(out.get(n) ?? []), kid]);
  }
  return out;
}
