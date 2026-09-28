// Resolves comment anchors against the live scene: pins follow their element,
// and fall back to the last seen position once the element is gone.
import { bbox, componentOf, isArrow, isShape, live, nameOf, type El } from "./scene";
import type { Anchor } from "../comments/threads";

const lastSeen = new WeakMap<Anchor, { x: number; y: number }>();

export type AnchorState = {
  point: { x: number; y: number };
  status: "ok" | "partial" | "lost";
  names: { id: string; name: string; alive: boolean }[];
};

export function resolveAnchor(anchor: Anchor, map: Map<string, El>): AnchorState {
  const primary = anchor.ids.map((id) => map.get(id)).find(live);
  let point = lastSeen.get(anchor) ?? anchor.last;
  if (primary) {
    const b = bbox(primary);
    // Boxes: the pin's tip sits on the top-right corner, so the teardrop (it grows up and to
    // the right of its tip) stays outside the box and never covers the centred label.
    // Arrows keep the anchored point along their path.
    point = isArrow(primary)
      ? { x: b.x + anchor.rel.x * b.width, y: b.y + anchor.rel.y * b.height }
      : { x: b.x + b.width, y: b.y };
    lastSeen.set(anchor, point);
  }
  const names = anchor.ids.map((id) => {
    const e = map.get(id);
    // A deleted element keeps its (deleted) label in the scene; show that rather than the id.
    const text = e?.boundElements?.find((b) => b.type === "text");
    const t = text && map.get(text.id);
    // A part of an inserted component (its icon's inner rectangle, say) is named by the component.
    const owner = e ? componentOf(e, map) : undefined;
    const name = e && !live(e) && t?.type === "text" ? t.text : owner ? nameOf(owner, map) : e ? nameOf(e, map) : id;
    return { id, name, alive: live(e) };
  });
  const alive = names.filter((n) => n.alive).length;
  return { point, names, status: alive === names.length ? "ok" : alive === 0 ? "lost" : "partial" };
}

/** Topmost commentable element under a scene point (labels resolve to their container, parts of an
 * inserted library component to the component). */
export function hitTest(elements: readonly El[], x: number, y: number, zoom: number): El | undefined {
  const tol = 8 / zoom;
  let map: Map<string, El> | undefined;
  const owner = (e: El) => {
    if (!e.groupIds?.length) return e;
    map ??= new Map(elements.map((x) => [x.id, x]));
    const c = componentOf(e, map);
    return c && !c.isDeleted ? c : e;
  };
  let frame: El | undefined;
  for (let i = elements.length - 1; i >= 0; i--) {
    const e = elements[i];
    if (e.isDeleted) continue;
    if (isArrow(e)) {
      for (let k = 1; k < e.points.length; k++) {
        const [ax, ay] = [e.x + e.points[k - 1][0], e.y + e.points[k - 1][1]];
        const [bx, by] = [e.x + e.points[k][0], e.y + e.points[k][1]];
        if (segDist(x, y, ax, ay, bx, by) <= tol) return e;
      }
      continue;
    }
    const inside = x >= e.x - tol && x <= e.x + e.width + tol && y >= e.y - tol && y <= e.y + e.height + tol;
    if (!inside) continue;
    if (e.type === "text" && e.containerId) {
      const c = elements.find((c) => c.id === e.containerId);
      if (c && !c.isDeleted) return owner(c);
    }
    if (isShape(e)) return owner(e);
    if (e.type === "frame") frame ??= e;
  }
  return frame;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
