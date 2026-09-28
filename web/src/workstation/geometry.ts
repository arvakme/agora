// Where things are on one canvas, in scene (world) coordinates: node boxes, the docks workers stand
// on, the 图外 tray, and which node a file belongs to (with the child canvas it lies in, if any).
// Built once per scene version (./Overlay.tsx), never per frame. Pure.
import { footprint, type Box } from "../canvas/clearance";
import { labelOf, live, type El } from "../canvas/scene";
import { effectiveLinks, type Scenes } from "../nested/graph";
import { elementFor } from "../pointer/codeLinks";
import { routeAround, type Pt } from "./rig";
import { OUTSIDE, type Located } from "./place";

export type Geometry = {
  canvasId: string;
  /** Linked nodes (the only places workers go), by element id. */
  boxes: Map<string, Box>;
  labels: Map<string, string>;
  tray: Box;
  locate: (path: string) => Located | null;
  /** Where a worker stands at a place (feet, world coordinates). Slot offsets are added by the overlay. */
  dock: (place: string) => Pt;
  /** Place → box (the tray for OUTSIDE). */
  boxOf: (place: string) => Box | undefined;
  /** Child canvas a node opens, if any. */
  childOf: Map<string, string>;
  /** Waypoints around the nodes between two docks. */
  route: (a: Pt, b: Pt) => Pt[];
};

/** Node the tray is drawn beside: below the diagram's bottom-right, never in a screen corner. */
export function trayBox(elements: readonly El[]): Box {
  let x1 = -Infinity;
  let y1 = -Infinity;
  let x0 = Infinity;
  for (const e of elements) {
    if (!live(e) || e.type === "text" || e.type === "arrow" || e.type === "line") continue;
    x0 = Math.min(x0, e.x);
    x1 = Math.max(x1, e.x + e.width);
    y1 = Math.max(y1, e.y + e.height);
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 200, h: 56 };
  return { x: Math.max(x0, x1 - 200), y: y1 + 72, w: 200, h: 56 };
}

export function buildGeometry(canvasId: string, elements: readonly El[], map: Map<string, El>, scenes: Scenes, childTitle: (id: string) => string | undefined): Geometry {
  const everything = new Map(scenes).set(canvasId, elements);
  const links = effectiveLinks(canvasId, everything);
  const boxes = new Map<string, Box>();
  const labels = new Map<string, string>();
  const childOf = new Map<string, string>();
  for (const l of links) {
    const el = map.get(l.id);
    if (!live(el)) continue;
    boxes.set(l.id, footprint(el, map, elements));
    labels.set(l.id, labelOf(el, map).replace(/\s+/g, " ").trim() || l.label);
    if (l.child) childOf.set(l.id, l.child);
  }
  const tray = trayBox(elements);
  const cache = new Map<string, Located | null>();
  const below = new Map<string, ReturnType<typeof effectiveLinks>>();
  const locate = (path: string): Located | null => {
    if (cache.has(path)) return cache.get(path)!;
    const hit = elementFor(path, links);
    let out: Located | null = null;
    if (hit && boxes.has(hit.link.id)) {
      out = { place: hit.link.id };
      const link = links.find((l) => l.id === hit.link.id)!;
      // Claimed only through its child canvas: the worker stands here, the bubble says where below.
      if (link.child && !link.own.includes(hit.glob)) {
        if (!below.has(link.child)) below.set(link.child, effectiveLinks(link.child, everything));
        const inner = elementFor(path, below.get(link.child)!);
        out.portal = { canvasId: link.child, label: inner?.link.label ?? childTitle(link.child) ?? "子图" };
      }
    }
    cache.set(path, out);
    return out;
  };
  const boxOf = (place: string) => (place === OUTSIDE ? tray : boxes.get(place));
  const dock = (place: string): Pt => {
    const b = boxOf(place) ?? tray;
    return place === OUTSIDE ? { x: b.x + 30, y: b.y } : { x: b.x + Math.min(28, b.w / 4), y: b.y };
  };
  const all = [...boxes.values()];
  const route = (a: Pt, b: Pt) => routeAround(a, b, all);
  return { canvasId, boxes, labels, tray, locate, dock, boxOf, childOf, route };
}
