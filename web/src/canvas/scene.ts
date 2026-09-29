// Scene helpers on top of Excalidraw's public API. The Excalidraw element array is the
// single source of truth; everything here reads it or rebuilds elements with stable ids.
import { convertToExcalidrawElements, FONT_FAMILY, ROUNDNESS } from "@excalidraw/excalidraw";
import { edgePoint } from "./lines";
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

/** The inserted library component an element belongs to (its transparent root), if any: a
 * member shares the component's outer group, recorded on the root as `customData.agora.group`. */
export function componentOf(el: El, map: Map<string, El>): El | undefined {
  if (libraryMeta(el) || !el.groupIds?.length) return undefined;
  const groups = new Set(el.groupIds);
  for (const e of map.values()) {
    const m = libraryMeta(e);
    if (m && groups.has(m.group) && e.id !== el.id) return e;
  }
  return undefined;
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

type ArrowSpec = {
  id: string;
  from: El;
  to: El;
  label?: string;
  bothEnds?: boolean;
  /** No arrowhead at either end (a line that only joins a junction dot). */
  plain?: boolean;
  /** The line's absolute points, first on the start node's edge, last on the end node's: a bent line, not the straight default. */
  path?: readonly (readonly [number, number])[];
  base?: Partial<El>;
};

/**
 * Builds a bound arrow (plus its label) between two shapes via convertToExcalidrawElements,
 * which computes binding focus/gap and label layout. Straight between the two edges unless a
 * `path` says how it runs. Endpoints are passed as throwaway skeleton copies; callers patch the
 * real endpoints' boundElements.
 */
export function buildArrow({ id, from, to, label, bothEnds, plain, path, base }: ArrowSpec): El[] {
  const fc = [from.x + from.width / 2, from.y + from.height / 2];
  const tc = [to.x + to.width / 2, to.y + to.height / 2];
  const line: [number, number][] = path && path.length >= 2 ? path.map((p) => [p[0], p[1]]) : [edgePoint(from, tc[0], tc[1], 6), edgePoint(to, fc[0], fc[1], 6)];
  const [sx, sy] = line[0];
  const points = line.map(([x, y]) => [x - sx, y - sy]);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
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
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        points: points as never,
        startArrowhead: bothEnds && !plain ? "arrow" : null,
        endArrowhead: plain ? null : "arrow",
        start: { id: from.id },
        end: { id: to.id },
        ...(label ? { label: { text: label, ...FONT, fontSize: 14 } } : {}),
      },
    ],
    { regenerateIds: false },
  );
  return out.filter((e) => e.id !== from.id && e.id !== to.id);
}

/** The small solid dot where several lines meet: an ellipse marked in customData, so it is not a node (lines end on it). */
export const JUNCTION_SIZE = 10;
export function buildJunction({ id, x, y }: { id: string; x: number; y: number }): El[] {
  return convertToExcalidrawElements(
    [{ ...STYLE, roundness: null, backgroundColor: STYLE.strokeColor, type: "ellipse", id, x, y, width: JUNCTION_SIZE, height: JUNCTION_SIZE, customData: { junction: true } }],
    { regenerateIds: false },
  );
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
