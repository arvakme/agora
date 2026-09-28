// Which figures get a bubble, and where figures stand side by side (web/docs/workstation.md §气泡).
// Tuned for one main agent with 3–6 sub-agents. Pure.
//
// Caps for many top-level agents (2 figures per node, 6 per screen, 工位组 chips) are v2 (docs §v2);
// v1 draws every run (one level of sub-agents; deeper ones fold into a +N).

export type BubbleCand = { id: string; depth: number; need: boolean; writing: boolean; order: number; idle?: boolean };

/**
 * Tuned for the usual shape — one main agent orchestrating 3–6 sub-agents: the main agent always
 * speaks; sub-agents that need you always do; of the others at work (reading, writing, running,
 * dispatching), at most `maxSub` show a compact bubble, writers first. The rest are figures only
 * (their lane and the hover say what they do).
 */
export function pickBubbles(cands: readonly (BubbleCand & { working?: boolean })[], max = Infinity, maxSub = 3): string[] {
  const score = (c: BubbleCand) => (c.need ? 0 : 4) + (c.writing ? 0 : 2) + c.depth;
  // the main agents always speak, idle ones too (「空闲 这一轮做完了」, as in the prototype)
  const tops = cands.filter((c) => c.depth === 0);
  const subs = cands.filter((c) => c.depth > 0 && !c.idle && (c.need || c.working)).sort((a, b) => score(a) - score(b) || a.order - b.order);
  const needSubs = subs.filter((c) => c.need);
  const busySubs = subs.filter((c) => !c.need).slice(0, Math.max(0, maxSub - needSubs.length));
  return [...tops, ...needSubs, ...busySubs].sort((a, b) => score(a) - score(b) || a.order - b.order).slice(0, max).map((c) => c.id);
}

/** Figures side by side at one node: tree order, so a sub-agent stands next to its dispatcher. */
export function slots(items: readonly { id: string; place: string; order: number }[]): Map<string, number> {
  const at = new Map<string, { id: string; order: number }[]>();
  for (const it of items) at.set(it.place, [...(at.get(it.place) ?? []), it]);
  const out = new Map<string, number>();
  for (const list of at.values()) list.sort((a, b) => a.order - b.order).forEach((it, i) => out.set(it.id, i));
  return out;
}
