// Scene helpers on top of Excalidraw's public API. The Excalidraw element array is the
// single source of truth; everything here reads it or rebuilds elements with stable ids.
import { convertToExcalidrawElements, FONT_FAMILY, ROUNDNESS } from "@excalidraw/excalidraw";
import type {
  ExcalidrawArrowElement,
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/excalidraw/element/types";

export type El = ExcalidrawElement;
export type Scene = readonly El[];
export type ShapeKind = "rectangle" | "ellipse" | "diamond";

export const STYLE = {
  roughness: 0,
  strokeWidth: 1,
  strokeColor: "#1f2328",
  fillStyle: "solid",
  roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
} as const;
export const FONT = { fontFamily: FONT_FAMILY.Helvetica, fontSize: 16 } as const;
export const NODE_SIZE = { width: 160, height: 64 } as const;

export const byId = (scene: Scene) => new Map(scene.map((e) => [e.id, e]));
export const live = (e: El | undefined): e is El => !!e && !e.isDeleted;
export const isShape = (e: El): boolean =>
  e.type === "rectangle" || e.type === "ellipse" || e.type === "diamond";
export const isArrow = (e: El): e is ExcalidrawArrowElement => e.type === "arrow";

export function boundText(el: El, map: Map<string, El>): ExcalidrawTextElement | undefined {
  const ref = el.boundElements?.find((b) => b.type === "text");
  const t = ref && map.get(ref.id);
  return t && !t.isDeleted && t.type === "text" ? t : undefined;
}

/** Marker on the transparent root rectangle of an inserted library component. */
export type LibraryMeta = { library: string; name: string; group: string; label?: string; droppedLabel?: string };
export const libraryMeta = (el: El | undefined): LibraryMeta | undefined => {
  const m = (el?.customData as { agora?: LibraryMeta } | undefined)?.agora;
  return m?.library ? m : undefined;
};

/** Code paths (globs) a diagram element stands for — the progress pointer's mapping (docs/progress-pointer.md). */
export const codePathsOf = (el: El | undefined): string[] => {
  const v = (el?.customData as { codePaths?: unknown } | undefined)?.codePaths;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
};

export function labelOf(el: El, map: Map<string, El>): string {
  if (el.type === "text") return el.text;
  const lib = libraryMeta(el);
  if (lib) {
    const t = lib.label ? map.get(lib.label) : undefined;
    return t && !t.isDeleted && t.type === "text" ? t.text : lib.name;
  }
  if (el.type === "frame") return el.name ?? "";
  return boundText(el, map)?.text ?? "";
}

/** Human name for thread replies: the label, falling back to the id. */
export const nameOf = (el: El, map: Map<string, El>) => labelOf(el, map).replace(/\s+/g, " ") || el.id;

/** Opaque freshness token: container version plus its label's version. */
export function versionOf(el: El, map: Map<string, El>): string {
  const t = boundText(el, map);
  return t ? `${el.version}.${t.version}` : `${el.version}`;
}

export function bbox(el: El) {
  if (isArrow(el)) {
    const xs = el.points.map((p) => p[0] + el.x);
    const ys = el.points.map((p) => p[1] + el.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

/** Point where the ray from the box centre towards (tx, ty) leaves the box, pushed out by gap. */
function edgePoint(el: El, tx: number, ty: number, gap: number): [number, number] {
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

type ArrowSpec = {
  id: string;
  from: El;
  to: El;
  label?: string;
  bothEnds?: boolean;
  base?: Partial<El>;
};

/**
 * Builds a straight, bound arrow (plus its label) between two shapes via
 * convertToExcalidrawElements, which computes binding focus/gap and label layout.
 * Endpoints are passed as throwaway skeleton copies; callers patch the real
 * endpoints' boundElements.
 */
export function buildArrow({ id, from, to, label, bothEnds, base }: ArrowSpec): El[] {
  const fc = [from.x + from.width / 2, from.y + from.height / 2];
  const tc = [to.x + to.width / 2, to.y + to.height / 2];
  const [sx, sy] = edgePoint(from, tc[0], tc[1], 6);
  const [ex, ey] = edgePoint(to, fc[0], fc[1], 6);
  const endpoint = (e: El) => ({ type: e.type as ShapeKind, id: e.id, x: e.x, y: e.y, width: e.width, height: e.height });
  const out = convertToExcalidrawElements(
    [
      endpoint(from),
      endpoint(to),
      {
        ...STYLE,
        roundness: null,
        ...(base as object),
        type: "arrow",
        id,
        x: sx,
        y: sy,
        width: ex - sx,
        height: ey - sy,
        points: [[0, 0], [ex - sx, ey - sy]] as never,
        startArrowhead: bothEnds ? "arrow" : null,
        endArrowhead: "arrow",
        start: { id: from.id },
        end: { id: to.id },
        ...(label ? { label: { text: label, ...FONT, fontSize: 14 } } : {}),
      },
    ],
    { regenerateIds: false },
  );
  return out.filter((e) => e.id !== from.id && e.id !== to.id);
}

type ShapeSpec = {
  id: string;
  shape: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  base?: Partial<El>;
};

/** Builds a labelled shape; returns [container, text?]. */
export function buildShape({ id, shape, x, y, width, height, label, base }: ShapeSpec): El[] {
  return convertToExcalidrawElements(
    [
      {
        ...STYLE,
        backgroundColor: "#f6f8fa",
        ...(base as object),
        type: shape,
        id,
        x,
        y,
        width,
        height,
        ...(label ? { label: { text: label, ...FONT } } : {}),
      },
    ],
    { regenerateIds: false },
  );
}

export const STYLE_KEYS = [
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "roundness",
  "groupIds",
  "frameId",
  "link",
  "locked",
] as const;

export function styleOf(el: El): Partial<El> {
  const out: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) out[k] = (el as unknown as Record<string, unknown>)[k];
  return out as Partial<El>;
}

/** Arrows currently bound (either end) to the given element. */
export function arrowsOf(id: string, scene: Scene): ExcalidrawArrowElement[] {
  return scene.filter(
    (e): e is ExcalidrawArrowElement =>
      isArrow(e) && !e.isDeleted && (e.startBinding?.elementId === id || e.endBinding?.elementId === id),
  );
}
