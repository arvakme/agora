// Geometry of the lines between nodes, kept free of Excalidraw so it is testable without it (scene.ts draws with
// it). Twin of server/canvas/graph_geom.py's edge_point / default_path and of model_view.py's _drawn_path.

type Box = { type?: string; x: number; y: number; width: number; height: number };
type Pt = [number, number];

/** How far outside its node an arrow stops. */
export const ARROW_GAP = 6;
/** An arrow whose ends are this close to where the page would put them is "plain". */
const PLAIN_SLACK = 8;

/** Point where the ray from the box centre towards (tx, ty) leaves the box, pushed out by gap. */
export function edgePoint(el: Box, tx: number, ty: number, gap: number = ARROW_GAP): Pt {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const hw = el.width / 2 + gap, hh = el.height / 2 + gap;
  let t: number;
  if (el.type === "ellipse") t = 1 / Math.hypot(dx / hw, dy / hh);
  else if (el.type === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

/** The straight arrow the page draws between two nodes. */
export function defaultPath(a: Box, b: Box): [Pt, Pt] {
  const ca: Pt = [a.x + a.width / 2, a.y + a.height / 2];
  const cb: Pt = [b.x + b.width / 2, b.y + b.height / 2];
  return [edgePoint(a, cb[0], cb[1]), edgePoint(b, ca[0], ca[1])];
}

type LineEl = { x: number; y: number; points: readonly (readonly [number, number])[]; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null };

/** The arrow's absolute points (whole numbers) unless it is the plain straight arrow between its two nodes. */
export function drawnPath(el: LineEl, shapes: ReadonlyMap<string, Box>): Pt[] | undefined {
  if (el.points.length < 2) return undefined;
  const pts: Pt[] = el.points.map((p) => [el.x + p[0], el.y + p[1]]);
  const from = el.startBinding && shapes.get(el.startBinding.elementId);
  const to = el.endBinding && shapes.get(el.endBinding.elementId);
  if (pts.length === 2 && from && to) {
    const plain = defaultPath(from, to);
    if (pts.every((p, i) => Math.abs(p[0] - plain[i][0]) <= PLAIN_SLACK && Math.abs(p[1] - plain[i][1]) <= PLAIN_SLACK)) return undefined;
  }
  return pts.map(([x, y]) => [Math.round(x), Math.round(y)]);
}

/** A small dot where several lines meet (customData.junction): geometry lines end on, not a node. */
export const isJunction = (el: { customData?: unknown }): boolean => !!(el.customData as { junction?: unknown } | undefined)?.junction;
