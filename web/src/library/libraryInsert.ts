// Turning a catalog item into scene elements. An inserted component becomes:
//   • a transparent "root" rectangle (id = the op's ref) covering the component — the
//     single addressable, bindable element the model and arrows refer to;
//   • the item's own elements with fresh ids and fresh group ids (inner grouping kept);
//   • an optional caption under it;
// all wrapped in one outer group, so the editor moves/selects it as one thing.
import { convertToExcalidrawElements, getCommonBounds, restoreElements } from "@excalidraw/excalidraw";
import type { Side } from "../ops/ops";
import { bbox, FONT, libraryMeta, type El, type LibraryMeta } from "../canvas/scene";

export type LibraryItem = { id: string; name: string; library: string; elements: unknown[] };

/** Everything that belongs to an inserted component (root excluded). */
export const libraryMembers = (root: El, scene: Iterable<El>) => {
  const g = libraryMeta(root)?.group;
  return g ? [...scene].filter((e) => e.id !== root.id && !e.isDeleted && e.groupIds.includes(g)) : [];
};

const rid = () => Math.random().toString(36).slice(2, 10);

export function instantiate(
  item: LibraryItem,
  opts: { ref: string; target?: El; side?: Side; gap?: number; at?: { x: number; y: number }; width?: number; label?: string; frameId?: string | null; obstacles?: readonly El[] },
): El[] {
  const els = restoreElements(structuredClone(item.elements) as never, null, { refreshDimensions: false, repairBindings: true }) as unknown as El[];
  const [x0, y0, x1, y1] = getCommonBounds(els as never);
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const s = opts.width ? Math.max(0.1, Math.min(8, opts.width / bw)) : 1;
  const W = bw * s, H = bh * s;
  // A caption that only repeats the component's own words is dropped (the Kafka wordmark case).
  const ownText = els.filter((e) => e.type === "text").map((e) => (e as unknown as { text: string }).text.toLowerCase()).join(" ");
  const label = opts.label && !ownText.includes(opts.label.trim().toLowerCase()) ? opts.label : undefined;
  const labelH = label ? 24 : 0;

  let X = opts.at?.x ?? 0, Y = opts.at?.y ?? 0;
  if (opts.target) {
    const t = bbox(opts.target);
    const gap = opts.gap ?? 60;
    if (opts.side === "right") (X = t.x + t.width + gap), (Y = t.y + (t.height - H) / 2);
    else if (opts.side === "left") (X = t.x - gap - W), (Y = t.y + (t.height - H) / 2);
    else if (opts.side === "above") (X = t.x + (t.width - W) / 2), (Y = t.y - gap - H - labelH);
    else (X = t.x + (t.width - W) / 2), (Y = t.y + t.height + gap);
  }

  // Keep ≥ MIN_GAP from everything around it: slide along the requested side until clear.
  if (opts.obstacles?.length) ({ X, Y } = clear({ x: X, y: Y, w: W, h: H + labelH }, opts.obstacles, opts.side ?? "right", opts.frameId ?? null));

  const outer = `lib-${opts.ref}-${rid()}`;
  const ids = new Map(els.map((e) => [e.id, `${opts.ref}-${rid()}`]));
  const groups = new Map<string, string>();
  const regroup = (g: string) => groups.get(g) ?? (groups.set(g, `g-${rid()}`), groups.get(g)!);
  const remap = (id: string | null | undefined) => (id && ids.get(id)) || null;
  const frameId = opts.frameId ?? null;

  const members = els.map((e) => {
    const any = e as unknown as Record<string, unknown> & { points?: number[][]; fontSize?: number; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null; containerId?: string | null };
    const out: Record<string, unknown> = {
      ...any,
      id: ids.get(e.id),
      x: X + (e.x - x0) * s,
      y: Y + (e.y - y0) * s,
      width: e.width * s,
      height: e.height * s,
      groupIds: [...e.groupIds.map(regroup), outer],
      frameId,
      boundElements: e.boundElements?.map((b) => ({ ...b, id: remap(b.id) })).filter((b) => b.id) ?? null,
    };
    if (any.points) out.points = any.points.map(([px, py]) => [px * s, py * s]);
    if (any.fontSize) out.fontSize = any.fontSize * s;
    if ("containerId" in any) out.containerId = remap(any.containerId);
    if ("startBinding" in any) out.startBinding = any.startBinding && remap(any.startBinding.elementId) ? { ...any.startBinding, elementId: remap(any.startBinding.elementId) } : null;
    if ("endBinding" in any) out.endBinding = any.endBinding && remap(any.endBinding.elementId) ? { ...any.endBinding, elementId: remap(any.endBinding.elementId) } : null;
    return out as unknown as El;
  });

  const labelEl = label ? caption(label, { x: X, y: Y, width: W, height: H, id: opts.ref, frameId }, outer) : undefined;

  const [root] = convertToExcalidrawElements(
    [{ type: "rectangle", id: opts.ref, x: X, y: Y, width: W, height: H, strokeColor: "transparent", backgroundColor: "transparent", roughness: 0, strokeWidth: 1 }],
    { regenerateIds: false },
  );
  const meta: LibraryMeta = { library: item.id, name: item.name || item.library, group: outer, ...(labelEl ? { label: labelEl.id } : {}), ...(opts.label && !label ? { droppedLabel: opts.label } : {}) };
  return [{ ...root, groupIds: [outer], frameId, customData: { agora: meta } } as El, ...members, ...(labelEl ? [labelEl] : [])];
}

/** Caption centred under a component's root. */
export function caption(text: string, root: { x: number; y: number; width: number; height: number; id: string; frameId: string | null }, group: string): El {
  const [t] = convertToExcalidrawElements([{ type: "text", text, x: 0, y: 0, ...FONT, fontSize: 14, textAlign: "center" }], { regenerateIds: false });
  return { ...t, id: `${root.id}-label`, x: root.x + (root.width - t.width) / 2, y: root.y + root.height + 6, groupIds: [group], frameId: root.frameId } as El;
}

export const MIN_GAP = 16;

/** Distance between two boxes (0 when they touch or overlap). */
export function boxGap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
}

function clear(box: { x: number; y: number; w: number; h: number }, obstacles: readonly El[], side: Side, frameId: string | null) {
  const rects = obstacles
    .filter((e) => !e.isDeleted && e.type !== "arrow" && e.type !== "line" && !(e.type === "text" && (e as unknown as { containerId?: string }).containerId) && e.id !== frameId)
    .map((e) => {
      const b = bbox(e);
      return { x: b.x, y: b.y, w: b.width, h: b.height, frame: e.type === "frame" };
    });
  const step = { right: [1, 0], left: [-1, 0], below: [0, 1], above: [0, -1] }[side];
  let { x, y } = box;
  for (let i = 0; i < 200; i++) {
    const me = { x, y, w: box.w, h: box.h };
    // A frame only blocks at its border: being fully inside or fully outside with room is fine.
    const hit = rects.find((r) => boxGap(me, r) < MIN_GAP && !(r.frame && inside(me, r)));
    if (!hit) break;
    x += step[0] * 8;
    y += step[1] * 8;
  }
  return { X: x, Y: y };
}
const inside = (a: { x: number; y: number; w: number; h: number }, r: { x: number; y: number; w: number; h: number }) =>
  a.x >= r.x + MIN_GAP && a.y >= r.y + MIN_GAP && a.x + a.w <= r.x + r.w - MIN_GAP && a.y + a.h <= r.y + r.h - MIN_GAP;
