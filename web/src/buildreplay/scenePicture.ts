// A canvas's picture as Excalidraw's SVG export, placed on the page by the canvas's view: the build replay draws its stage with it (./BuildStage.tsx),
// the live canvas draws an agent's batch with it while the batch is shown station by station (../workstation/RevealLayer.tsx), and a node shows
// its sub-diagram with it while it is zoomed into (../nested/ZoomLayer.tsx).
import { exportToSvg, getCommonBounds } from "@excalidraw/excalidraw";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { Box } from "../canvas/clearance";
import type { El } from "../canvas/scene";
import type { Viewport } from "../canvas/viewport";

const PAD = 16;

/** The drawing's extent (scene coordinates). */
export function boundsOf(elements: readonly El[]): Box {
  if (!elements.length) return { x: 0, y: 0, w: 1, h: 1 };
  const [x0, y0, x1, y1] = getCommonBounds(elements);
  return Number.isFinite(x0) ? { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) } : { x: 0, y: 0, w: 1, h: 1 };
}

/** The SVG markup and where it lies in the scene. */
export type SceneSvg = { html: string; x: number; y: number; w: number; h: number };
const svgs = new Map<string, Promise<SceneSvg | null>>();
/** The pictures that are ready, by the same key: what a view about to mount draws in its first frame (no waiting on a promise). */
const ready = new Map<string, SceneSvg | null>();
const keyOf = (key: string, version: number, dark: boolean) => `${key}|${version}|${dark ? "d" : "l"}`;

/** The part of the scene a picture shows (frames clip what is in them): its extent without the margin. */
export const pictureBounds = (elements: readonly El[]): Box => {
  const frames = new Set(elements.filter((e) => e.type === "frame" || e.type === "magicframe").map((e) => e.id));
  return boundsOf(elements.filter((e) => frames.has(e.id) || !e.frameId || !frames.has(e.frameId)));
};
/** A picture made already, if it is (undefined: not yet). */
export const sceneSvgNow = (key: string, version: number, dark: boolean): SceneSvg | null | undefined => ready.get(keyOf(key, version, dark));

/** The picture of these elements, cached by `key` (a canvas id and a scene version) and theme; a scene with a bad order key still draws, in listed order. */
export function sceneSvg(key: string, elements: readonly El[], version: number, dark: boolean, files: BinaryFiles | null = null): Promise<SceneSvg | null> {
  const k = keyOf(key, version, dark);
  let p = svgs.get(k);
  if (!p) {
    if (svgs.size >= 64) {
      const old = svgs.keys().next().value!;
      svgs.delete(old);
      ready.delete(old);
    }
    p = exportScene(elements, dark, files)
      .catch(() => exportScene(elements.map((e) => ({ ...e, index: null })) as unknown as readonly El[], dark, files))
      .catch(() => null);
    p.then((v) => svgs.has(k) && ready.set(k, v));
    svgs.set(k, p);
  }
  return p;
}

async function exportScene(elements: readonly El[], dark: boolean, files: BinaryFiles | null): Promise<SceneSvg | null> {
  if (!elements.length) return null;
  const b = pictureBounds(elements);
  const svg = await exportToSvg({
    elements: elements as readonly NonDeletedExcalidrawElement[],
    appState: { exportBackground: false, exportWithDarkMode: dark, viewBackgroundColor: "transparent", frameRendering: { enabled: true, name: false, outline: true, clip: true } },
    files,
    exportPadding: PAD,
    skipInliningFonts: true,
  });
  return { html: svg.outerHTML, x: b.x - PAD, y: b.y - PAD, w: b.w + 2 * PAD, h: b.h + 2 * PAD };
}

/** The CSS transform that puts a picture where the view shows its part of the scene. */
export const placeOf = (s: Pick<SceneSvg, "x" | "y">, v: Pick<Viewport, "zoom" | "scrollX" | "scrollY">): string =>
  `matrix(${v.zoom},0,0,${v.zoom},${((s.x + v.scrollX) * v.zoom).toFixed(2)},${((s.y + v.scrollY) * v.zoom).toFixed(2)})`;
