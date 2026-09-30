// Where each bubble goes (web/docs/workstation.md §气泡), decided with each snapshot (≤ 4 Hz).
//
// A bubble belongs to its figure: it sits right above that figure's head with its tail pointing at
// the head (the tail can sit anywhere along the bubble's lower edge, so the bubble may slide
// sideways a little), one row higher on a thin stem, or beside the head with a side tail. It may
// only move that little to stay clear of other bubbles and of the drawing (nodes, icons, text and
// arrow labels). When none of those spots is clear it collapses to a small chip right at the figure
// (verb only) instead of drifting away. Rules that always hold:
//   - no two bubbles (or chips, or stems) overlap;
//   - a bubble never covers the drawing or another figure unless it is the selected one, and never its own figure (`self`):
//     with no room above the head it goes beside it;
//   - a chip only fails to show for a foldable (sub-agent) figure with no free spot at all — its
//     dispatcher's bubble then counts it as +N.
// Bubbles come in priority order (needs-you first, the main agent, then sub-agents); figures whose
// heads are side by side extend away from each other (the left one leftwards, the right one
// rightwards) so both keep their tails. Pure (type-only imports); obstacles go through a grid index.
import type { Box } from "../canvas/clearance";

export type BubbleIn = {
  id: string;
  /** The figure's head centre and radius, screen px. */
  x: number;
  y: number;
  r: number;
  /** Extra room above the head (a ! or ? mark), px. */
  lift?: number;
  /** Full bubble size, and its chip's. */
  w: number;
  h: number;
  chip?: { w: number; h: number };
  /** A sub-agent that does not need the person: may disappear (+N) when even its chip has no room. */
  foldable: boolean;
  /** Selected: shows in full even over the drawing. */
  keep?: boolean;
  /** The figure itself (screen box), so other bubbles avoid covering it. */
  body?: Box;
  /** Its own figure from head to feet, always (a walking one too): its bubble never covers it, whatever else is in the way. */
  self?: Box;
  /** The prototype's own spot for this bubble, tried first (see protoSpot). */
  proto?: { x: number; y: number; tail: Tail; tailX: number };
  /** Where it was last time (same frame of reference): kept while still clear, so bubbles don't hop. */
  prev?: { x: number; y: number; tail: Tail; tailX: number; stem: number };
};
export type Tail = "d" | "l" | "r" | null;
export type Placed = { x: number; y: number; tail: Tail; /** px from the bubble's left edge to the tail (tail "d") */ tailX: number; /** stem length below the tail (a lifted bubble) */ stem: number; chip: boolean };

/** Gap from the head (or its mark) to the tail's tip, and the tail's height. */
export const TIP_GAP = 3;
export const TAIL_H = 5;
const SIDE = 10;
/**
 * The widest a bubble gets (px): longer words end in … and show in full while it is hovered (workstation.css `--bub-max`,
 * the same number). The selected bubble adds its two buttons beside the words, so it is wider than this by their width.
 */
export const BUBBLE_MAX_W = 260;

const hit = (a: Box, b: Box, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

type Cand = { x: number; y: number; tail: Tail; tailX: number; stem: number; cost: number };

/**
 * Where the prototype puts a bubble (workstation-proto renderOverlay), in screen px: `root` is
 * the figure's feet, `sc` the figures' scale. Alone at its place: its left edge 20 px left of the
 * feet, 34 px above the head line (60·sc over the feet), tail down at 20 px; walking: 22 / 36 px.
 * With others at the same place: stacked upwards in 34 px steps from `left` (the place's first
 * dock, less 16 world px), no tail — the avatar at its left says whose it is.
 */
export function protoSpot(root: { x: number; y: number }, sc: number, o: { walking?: boolean; stack?: { i: number; left: number } }): NonNullable<BubbleIn["proto"]> {
  const headTop = root.y - 60 * sc;
  // walking: the prototype nudges it 2 px (22 / 36); kept at the standing spot here so starting and
  // stopping a walk doesn't retarget the bubble's glide
  if (o.walking) return { x: root.x - 20, y: headTop - 34, tail: "d", tailX: 20 };
  if (o.stack) return { x: o.stack.left, y: headTop - 34 - o.stack.i * 34, tail: null, tailX: 20 };
  return { x: root.x - 20, y: headTop - 34, tail: "d", tailX: 20 };
}

export function placeBubbles(list: readonly BubbleIn[], o: { width: number; height: number; nodes: readonly Box[]; avoid?: readonly Box[]; gap?: number }): { at: Map<string, Placed>; folded: string[] } {
  const gap = o.gap ?? 4;
  const cell = 96;
  const grid = new Map<string, Box[]>();
  const cells = (r: Box, f: (key: string) => void) => {
    for (let i = Math.floor(r.x / cell); i <= Math.floor((r.x + r.w) / cell); i++) for (let j = Math.floor(r.y / cell); j <= Math.floor((r.y + r.h) / cell); j++) f(`${i},${j}`);
  };
  for (const b of o.nodes) cells(b, (k) => grid.set(k, [...(grid.get(k) ?? []), b]));
  const onNode = (r: Box) => {
    let n = 0;
    const seen = new Set<Box>();
    cells(r, (k) => {
      for (const b of grid.get(k) ?? []) if (!seen.has(b) && (seen.add(b), hit(r, b))) n++;
    });
    return n;
  };
  const avoid = o.avoid ?? [];
  const taken: Box[] = [];
  const stems: Box[] = [];
  const at = new Map<string, Placed>();
  const folded: string[] = [];
  const inView = (r: Box) => r.x >= 8 && r.x + r.w <= o.width - 8 && r.y >= 8 && r.y + r.h <= o.height - 8;
  const onBubble = (r: Box, pad = gap) => taken.some((p) => hit(p, r, pad)) || stems.some((s) => hit(s, r, 1));
  const onChrome = (r: Box) => avoid.some((p) => hit(p, r));
  const bodies = list.flatMap((b) => (b.body ? [{ id: b.id, box: b.body }] : []));
  const onFigures = (id: string, r: Box) => bodies.filter((f) => f.id !== id && hit(f.box, r)).length;

  for (const b of list) {
    const { x: hx, y: hy, w, h } = b;
    const tip = hy - b.r - (b.lift ?? 0) - TIP_GAP;
    const y0 = tip - TAIL_H - h;
    // side by side: extend away from the neighbour so both tails stay on their own heads
    const rightN = list.some((q) => q !== b && Math.abs(q.y - hy) < 48 && q.x > hx && q.x - hx < w + 8);
    const leftN = list.some((q) => q !== b && Math.abs(q.y - hy) < 48 && q.x < hx && hx - q.x < q.w + 8);
    const lo = 14;
    const hi = Math.max(lo, w - 14);
    const pref = rightN && !leftN ? w - 20 : leftN && !rightN ? 20 : rightN && leftN ? w / 2 : 20;
    const txs = [...new Set([pref, 20, w - 20, w / 2, ...Array.from({ length: 7 }, (_, i) => lo + ((hi - lo) * i) / 6)].map((v) => Math.round(Math.max(lo, Math.min(hi, v)))))];
    const cands: Cand[] = [];
    if (b.proto) cands.push({ ...b.proto, stem: 0, cost: -1 });
    // where it already is beats every other alternative, but not the prototype's own spot
    if (b.prev) cands.push({ ...b.prev, cost: -0.5 });
    for (const row of [0, 1])
      for (const tx of txs) cands.push({ x: hx - tx, y: y0 - row * (h + 6), tail: "d", tailX: tx, stem: row * (h + 6), cost: row * 10 + (Math.abs(tx - pref) / Math.max(1, w)) * 4 });
    // beside the figure: past its body (shoulders and arms), not just past the head
    const right = Math.max(hx + b.r, b.self ? b.self.x + b.self.w : -Infinity) + SIDE;
    const left = Math.min(hx - b.r, b.self ? b.self.x : Infinity) - SIDE;
    cands.push({ x: right, y: hy - h / 2, tail: "l", tailX: 0, stem: 0, cost: 7 });
    cands.push({ x: left - w, y: hy - h / 2, tail: "r", tailX: 0, stem: 0, cost: 7 });
    const onSelf = (r: Box) => !!b.self && hit(b.self, r);
    const stemBox = (c: Cand): Box | null => (c.stem ? { x: hx - 1, y: c.y + h, w: 2, h: c.stem + TAIL_H } : null);
    let pick: Cand | null = null;
    for (const c of cands) {
      const r = { x: c.x, y: c.y, w, h };
      if (!inView(r) || onBubble(r) || onChrome(r) || onSelf(r)) continue;
      const s = stemBox(c);
      if (s && (onBubble(s, 1) || onNode(s))) continue;
      if (!b.keep && (onNode(r) || onFigures(b.id, r))) continue;
      const cost = c.cost + (b.keep ? onNode(r) * 20 + onFigures(b.id, r) * 6 : 0);
      if (!pick || cost < pick.cost) pick = { ...c, cost };
    }
    if (pick) {
      at.set(b.id, { x: pick.x, y: pick.y, tail: pick.tail, tailX: pick.tailX, stem: pick.stem, chip: false });
      taken.push({ x: pick.x, y: pick.y, w, h });
      const s = stemBox(pick);
      if (s) stems.push(s);
      continue;
    }
    // No room near its figure: a chip right at the figure (never a bubble far away).
    const cw = b.chip?.w ?? 40;
    const ch = b.chip?.h ?? 22;
    const cy = tip - TAIL_H - ch;
    const chips: Cand[] = [
      { x: hx - cw / 2, y: cy, tail: "d", tailX: cw / 2, stem: 0, cost: 0 },
      { x: hx - 12, y: cy, tail: "d", tailX: 12, stem: 0, cost: 1 },
      { x: hx - cw + 12, y: cy, tail: "d", tailX: cw - 12, stem: 0, cost: 1 },
      { x: right, y: hy - ch / 2, tail: "l", tailX: 0, stem: 0, cost: 2 },
      { x: left - cw, y: hy - ch / 2, tail: "r", tailX: 0, stem: 0, cost: 2 },
    ];
    let best: Cand | null = null;
    for (const c of chips) {
      const r = { x: c.x, y: c.y, w: cw, h: ch };
      if (!inView(r) || onBubble(r) || onSelf(r)) continue;
      const cost = c.cost + onNode(r) * 20 + (onChrome(r) ? 50 : 0) + onFigures(b.id, r) * 4;
      if (!best || cost < best.cost) best = { ...c, cost };
    }
    if (!best && b.foldable) {
      folded.push(b.id);
      continue;
    }
    if (!best) {
      // must show: stack above the highest thing in its column (still never on another bubble)
      let y = cy;
      while (onBubble({ x: hx - cw / 2, y, w: cw, h: ch }) || onSelf({ x: hx - cw / 2, y, w: cw, h: ch })) y -= ch + gap;
      best = { x: hx - cw / 2, y, tail: null, tailX: cw / 2, stem: 0, cost: 0 };
    }
    at.set(b.id, { x: best.x, y: best.y, tail: best.tail, tailX: best.tailX, stem: 0, chip: true });
    taken.push({ x: best.x, y: best.y, w: cw, h: ch });
  }
  return { at, folded };
}

/** Shown bubbles (client rects) as boxes in the frame of `origin`, a layer's client corner; the talk box keeps off them. */
export function boxesIn(origin: { left: number; top: number }, rects: readonly { left: number; top: number; width: number; height: number }[]): Box[] {
  return rects.filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }));
}
