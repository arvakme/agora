// Where things are on one canvas, in scene (world) coordinates: node boxes, the docks workers stand
// on, the 图外 tray, which node a file belongs to (with the child canvas it lies in, if any), and the
// walking map (./route.ts: floors, and the arrows between nodes as ways). Built once per scene version
// (./Overlay.tsx), never per frame. Pure (type-only imports from scene.ts, which pulls in Excalidraw),
// so it runs under vitest in node.
import { footprint, type Box } from "../canvas/clearance";
import type { El } from "../canvas/scene";
import { effectiveLinks, labelOf, type Scenes } from "../nested/graph";
import { elementFor } from "../pointer/codeLinks";
import type { Pt } from "./rig";
import { OUTSIDE, type Located, type Spot } from "./place";
import { dockSpots, inside, REF_K, trayBox } from "./docks";
import { route as routeOn, walkMap, type Connector, type Route } from "./route";
export { dockSpots, FIG_BOX, REF_K, SLOT, trayBox } from "./docks";

export type Geometry = {
  canvasId: string;
  /** Linked nodes (the only places workers go), by element id. */
  boxes: Map<string, Box>;
  labels: Map<string, string>;
  /** Everything drawn that a bubble should not cover (shapes, images, text; not arrows or lines). */
  obstacles: Box[];
  tray: Box;
  locate: (path: string) => Located | null;
  /** Where a worker walks to at a place (feet, world coordinates): its first free spot at 100 %. */
  dock: (place: string) => Pt;
  /** The `n` spots at a place, best first, for figures drawn at `k` world units per figure unit (dockSpots). */
  spots: (place: string, k: number, n: number) => Pt[];
  /** Place → box (the tray for OUTSIDE). */
  boxOf: (place: string) => Box | undefined;
  /** Child canvas a node opens, if any. */
  childOf: Map<string, string>;
  /** The way from one spot to another (./route.ts): along the arrows between nodes, else over a scaffold. */
  route: (from: Spot, to: Spot) => Route;
};

const live = (e: El | undefined): e is El => !!e && !e.isDeleted;

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
  const all = [...boxes.values()];
  // Everything drawn that a figure or a bubble must not cover: linked nodes (with their labels),
  // shapes, icons, images, free text and arrow labels. Not arrows or loose lines, and not a big
  // shape that only frames others (a zone or a group box): its empty inside is free space.
  const drawn: { b: Box; text: boolean }[] = [];
  for (const e of elements) {
    if (!live(e) || e.type === "arrow" || e.type === "line" || !(e.width > 0 && e.height > 0)) continue;
    // an arrow's label is drawn at the arrow's middle (its stored x / y can be stale)
    const on = e.type === "text" && e.containerId ? map.get(e.containerId) : undefined;
    const pts = on && live(on) && on.type === "arrow" ? (on as { points?: readonly (readonly [number, number])[] }).points : undefined;
    if (on && pts?.length) {
      const n = pts.length;
      const [px, py] = n % 2 ? pts[(n - 1) / 2] : [(pts[n / 2 - 1][0] + pts[n / 2][0]) / 2, (pts[n / 2 - 1][1] + pts[n / 2][1]) / 2];
      drawn.push({ b: { x: on.x + px - e.width / 2, y: on.y + py - e.height / 2, w: e.width, h: e.height }, text: true });
    } else drawn.push({ b: { x: e.x, y: e.y, w: e.width, h: e.height }, text: e.type === "text" });
  }
  const frames = (d: { b: Box; text: boolean }) =>
    !d.text && d.b.w * d.b.h > 40_000 && drawn.some((o) => o !== d && !o.text && o.b.w * o.b.h * 4 < d.b.w * d.b.h && inside(o.b, d.b, 0));
  const obstacles: Box[] = [...all, ...drawn.filter((d) => !frames(d)).map((d) => d.b)];
  const tray = trayBox(obstacles);
  const boxOf = (place: string) => (place === OUTSIDE ? tray : boxes.get(place));
  const spotCache = new Map<string, Pt[]>();
  const spots = (place: string, k: number, n: number): Pt[] => {
    const kq = Math.round(k * 20) / 20;
    const key = `${place}|${kq}|${n}`;
    let s = spotCache.get(key);
    if (!s) {
      if (spotCache.size > 2000) spotCache.clear();
      const b = boxOf(place) ?? tray;
      spotCache.set(key, (s = dockSpots(b, obstacles, kq, n, place === OUTSIDE)));
    }
    return s;
  };
  const dock = (place: string): Pt => spots(place, REF_K, 1)[0];
  // The ways between floors: arrows bound at both ends to linked nodes — directly, through a label
  // (its container) or through another member of a node's group (a library icon's drawing).
  const groupNode = new Map<string, string | null>(); // a group's one linked node (null: more than one)
  for (const id of boxes.keys()) for (const g of map.get(id)?.groupIds ?? []) groupNode.set(g, groupNode.has(g) && groupNode.get(g) !== id ? null : id);
  const nodeOf = (id: string | undefined, label = true): string | null => {
    const e = id ? map.get(id) : undefined;
    if (!live(e)) return null;
    if (boxes.has(e.id)) return e.id;
    if (label && e.type === "text" && e.containerId) return nodeOf(e.containerId, false);
    for (const g of e.groupIds ?? []) if (groupNode.get(g)) return groupNode.get(g)!;
    return null;
  };
  const connectors: Connector[] = [];
  for (const e of elements) {
    if (!live(e) || e.type !== "arrow") continue;
    const a = e as unknown as { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null; points: readonly (readonly [number, number])[] };
    const from = nodeOf(a.startBinding?.elementId);
    const to = nodeOf(a.endBinding?.elementId);
    if (from && to) connectors.push({ from, to, pts: a.points.map(([x, y]) => ({ x: e.x + x, y: e.y + y })) });
  }
  const ways = walkMap(new Map([...boxes, [OUTSIDE, tray]]), connectors, obstacles);
  const route = (from: Spot, to: Spot): Route => routeOn(ways, from, to);
  return { canvasId, boxes, labels, obstacles, tray, locate, dock, spots, boxOf, childOf, route };
}
