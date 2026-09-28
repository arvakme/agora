// Where each bubble goes (web/docs/workstation.md §气泡), decided with each snapshot (≤ 4 Hz):
// above its figure's head (tail down-left or down-right), lifted in 30 px steps, or under the node,
// each also shifted sideways — the first spot that covers no node, no panel and no bubble placed before it.
// Bubbles come in priority order (needs-you first, the main agent, then sub-agents).
//
// The rule that always holds: **no two bubbles overlap**. When there is no clear spot, a
// low-priority sub-agent bubble folds (its dispatcher's bubble shows +N) and the main agent's
// or a needs-you bubble takes the spot that covers the least drawing — still never another bubble.
// Pure (type-only imports); node boxes go through a grid index, so it stays cheap with many nodes.
import type { Box } from "../canvas/clearance";

export type BubbleIn = {
  id: string;
  /** The figure's head, screen px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** A sub-agent that does not need the person: may fold instead of crowding. */
  foldable: boolean;
  /** The bottom of the node it stands on (screen y), for the under-the-node spots. */
  below?: number;
};
export type Placed = { x: number; y: number; tail: "d" | "dr" | null };

const hit = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

export function placeBubbles(list: readonly BubbleIn[], o: { width: number; height: number; nodes: readonly Box[]; avoid?: readonly Box[]; gap?: number }): { at: Map<string, Placed>; folded: string[] } {
  const gap = o.gap ?? 4;
  const cell = 96;
  const grid = new Map<string, Box[]>();
  const cells = (r: Box, f: (key: string) => void) => {
    for (let i = Math.floor(r.x / cell); i <= Math.floor((r.x + r.w) / cell); i++) for (let j = Math.floor(r.y / cell); j <= Math.floor((r.y + r.h) / cell); j++) f(`${i},${j}`);
  };
  for (const b of o.nodes) cells(b, (k) => grid.set(k, [...(grid.get(k) ?? []), b]));
  const onNode = (r: Box) => {
    let yes = false;
    cells(r, (k) => (yes ||= (grid.get(k) ?? []).some((b) => hit(r, b))));
    return yes;
  };
  const avoid = o.avoid ?? [];
  const bubbles: Box[] = [];
  const at = new Map<string, Placed>();
  const folded: string[] = [];
  for (const b of list) {
    const { x: hx, y: hy, w, h } = b;
    const box = (x: number, y: number): Box => ({ x, y, w, h });
    const inView = (r: Box) => r.x >= 8 && r.x + r.w <= o.width - 8 && r.y >= 8 && r.y + r.h <= o.height - 8;
    const onBubble = (r: Box) => bubbles.some((p) => hit(p, r, gap));
    const clear = (r: Box) => inView(r) && !onBubble(r) && !onNode(r) && !avoid.some((p) => hit(p, r));
    const top = hy - h - 14;
    const cands: [number, number, Placed["tail"]][] = [
      [hx - 20, top, "d"],
      [hx - w + 28, top, "dr"],
    ];
    // then: lifted, under the node, each also shifted sideways (half a bubble, a whole one)
    const rows = [top];
    for (let up = 1; up <= 5; up++) rows.push(top - up * 30);
    if (b.below != null) for (let i = 0; i < 4; i++) rows.push(b.below + 10 + i * 30);
    const xs = [hx - 20, hx - w + 28, hx - 20 + (w / 2 + 12), hx - 20 - (w / 2 + 12), hx + 8, hx - w - 12];
    for (const y of rows) for (const x of xs) if (!(y === top && (x === hx - 20 || x === hx - w + 28))) cands.push([x, y, null]);
    let pick = cands.find(([x, y]) => clear(box(x, y)));
    if (!pick && b.foldable) {
      folded.push(b.id);
      continue;
    }
    if (!pick) {
      // Must show (main agent, needs you): the least-bad spot that touches no other bubble.
      const cost = ([x, y]: [number, number, unknown]) => {
        const r = box(x, y);
        return (inView(r) ? 0 : 1000) + (onNode(r) ? 100 : 0) + (avoid.some((p) => hit(p, r)) ? 300 : 0);
      };
      pick = [...cands].filter(([x, y]) => !onBubble(box(x, y))).sort((p, q) => cost(p) - cost(q))[0];
      // everything around is taken by bubbles: stack above the highest one in its column
      if (!pick) {
        let y = top;
        while (onBubble(box(hx - 20, y))) y -= h + gap;
        pick = [hx - 20, y, null];
      }
    }
    at.set(b.id, { x: pick[0], y: pick[1], tail: pick[2] });
    bubbles.push(box(pick[0], pick[1]));
  }
  return { at, folded };
}
