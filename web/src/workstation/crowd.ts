// Which figures get a bubble (web/docs/workstation.md §气泡): every session that is doing
// something, and a sub-agent only when it needs the person (waiting on a reply, or writing the
// same file as someone else). Those that need you come first. Pure.
//
// Caps (2 figures per node, 6 per screen, 4 bubbles, 工位组 chips) are v2 (docs §v2); v1 draws every
// run and orders bubbles only.

export type BubbleCand = { id: string; depth: number; need: boolean; writing: boolean; order: number; idle?: boolean };

export function pickBubbles(cands: readonly BubbleCand[], max = Infinity): string[] {
  const eligible = cands.filter((c) => !c.idle && (c.depth === 0 || c.need));
  const score = (c: BubbleCand) => (c.need ? 0 : 4) + (c.writing ? 0 : 2) + c.depth;
  return [...eligible].sort((a, b) => score(a) - score(b) || a.order - b.order).slice(0, max).map((c) => c.id);
}

/** Figures side by side at one node: tree order, so a sub-agent stands next to its dispatcher. */
export function slots(items: readonly { id: string; place: string; order: number }[]): Map<string, number> {
  const at = new Map<string, { id: string; order: number }[]>();
  for (const it of items) at.set(it.place, [...(at.get(it.place) ?? []), it]);
  const out = new Map<string, number>();
  for (const list of at.values()) list.sort((a, b) => a.order - b.order).forEach((it, i) => out.set(it.id, i));
  return out;
}
