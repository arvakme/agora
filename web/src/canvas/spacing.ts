// Minimum spacing for elements the agent adds (plain shapes and library components):
// a new box never overlaps, or comes within MIN_GAP of, another node, component or a
// frame's border. The executor nudges it to the nearest clear spot along the allowed
// directions; the model's coordinates stay the intent, this only enforces the invariant.
// Pure (type-only imports) so it runs under vitest in node.
import type { Side } from "../ops/ops";
import type { El } from "./scene";

export const MIN_GAP = 16;
const STEP = 8;
const MAX_STEPS = 200;

export type Box = { x: number; y: number; w: number; h: number };

/** Distance between two boxes (0 when they touch or overlap). */
export function boxGap(a: Box, b: Box) {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
}

/** `a` sits inside `r` with at least MIN_GAP to every edge. */
const inside = (a: Box, r: Box) => a.x >= r.x + MIN_GAP && a.y >= r.y + MIN_GAP && a.x + a.w <= r.x + r.w - MIN_GAP && a.y + a.h <= r.y + r.h - MIN_GAP;

/**
 * Obstacles for a new element: live nodes, components and frames. Arrows, lines and bound
 * labels don't count; neither does the frame the element is being put into (it grows to
 * fit), nor anything listed in `skip` (the element's own parts).
 */
export function obstaclesFor(scene: Iterable<El>, { frameId = null, skip = [] }: { frameId?: string | null; skip?: Iterable<string> } = {}) {
  const skipped = new Set(skip);
  const out: (Box & { container: boolean })[] = [];
  for (const e of scene) {
    if (e.isDeleted || skipped.has(e.id) || e.id === frameId) continue;
    if (e.type === "arrow" || e.type === "line") continue;
    if (e.type === "text" && (e as unknown as { containerId?: string | null }).containerId) continue;
    out.push({ x: e.x, y: e.y, w: e.width, h: e.height, container: e.type === "frame" || e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond" });
  }
  return out;
}

const DIRS: Record<Side, [number, number]> = { right: [1, 0], left: [-1, 0], below: [0, 1], above: [0, -1] };

/**
 * Nearest position for `box` that keeps MIN_GAP from every obstacle, searching straight
 * lines along `sides` (in preference order on ties). A container (frame or shape) that
 * fully encloses the box with room is intentional nesting, not a collision.
 */
export function clearSpot(box: Box, obstacles: readonly (Box & { container?: boolean })[], sides: readonly Side[]): { x: number; y: number } {
  const blocked = (me: Box) => obstacles.some((r) => boxGap(me, r) < MIN_GAP && !(r.container && inside(me, r)));
  if (!blocked(box)) return { x: box.x, y: box.y };
  let best: { x: number; y: number; d: number } | null = null;
  for (const side of sides) {
    const [dx, dy] = DIRS[side];
    for (let i = 1; i <= MAX_STEPS; i++) {
      const d = i * STEP;
      if (best && d >= best.d) break;
      const me = { ...box, x: box.x + dx * d, y: box.y + dy * d };
      if (!blocked(me)) {
        best = { x: me.x, y: me.y, d };
        break;
      }
    }
  }
  return best ? { x: best.x, y: best.y } : { x: box.x, y: box.y };
}
