// One canvas of the replay: its picture (Excalidraw's SVG export of the scene as it is at the moment shown) under the ordinary 工位视图
// overlay — the figures walk its bridges, climb its ladders, go through its doors — seen by a camera that glides after the figure
// (web/docs/share-build-replay.md §5). The same idea as the old follow pane's stage, on the replay's own world (./sources.ts).
import { exportToSvg, getCommonBounds, hashElementsVersion } from "@excalidraw/excalidraw";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "../app/theme";
import type { CanvasViewState } from "../canvas/CanvasView";
import type { Box } from "../canvas/clearance";
import { byId, type El } from "../canvas/scene";
import { viewport } from "../canvas/viewport";
import { useNested } from "../nested/store";
import { prefersReducedMotion } from "../workstation/clock";
import { figurePositions } from "../workstation/focus";
import { frame } from "../workstation/frame";
import { WorkstationOverlay } from "../workstation/Overlay";
import { canvasWhere } from "../workstation/place";
import type { BuildWorld } from "./sources";
import "./buildreplay.css";

const NO_CHROME: Box[] = [];
const PAD = 16;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The drawing's extent (scene coordinates). */
function boundsOf(elements: readonly El[]): Box {
  if (!elements.length) return { x: 0, y: 0, w: 1, h: 1 };
  const [x0, y0, x1, y1] = getCommonBounds(elements);
  return Number.isFinite(x0) ? { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) } : { x: 0, y: 0, w: 1, h: 1 };
}

type SceneSvg = { html: string; x: number; y: number; w: number; h: number };
const svgs = new Map<string, Promise<SceneSvg | null>>();

function sceneSvg(canvasId: string, elements: readonly El[], version: number, dark: boolean): Promise<SceneSvg | null> {
  const key = `${canvasId}|${version}|${dark ? "d" : "l"}`;
  let p = svgs.get(key);
  if (!p) {
    if (svgs.size >= 64) svgs.delete(svgs.keys().next().value!);
    // a scene with a bad order key (a hand-edited file) still draws, in the order it is listed
    p = exportScene(elements, dark)
      .catch(() => exportScene(elements.map((e) => ({ ...e, index: null })) as unknown as readonly El[], dark))
      .catch(() => null);
    svgs.set(key, p);
  }
  return p;
}

async function exportScene(elements: readonly El[], dark: boolean): Promise<SceneSvg | null> {
  if (!elements.length) return null;
  const frames = new Set(elements.filter((e) => e.type === "frame" || e.type === "magicframe").map((e) => e.id));
  const b = boundsOf(elements.filter((e) => frames.has(e.id) || !e.frameId || !frames.has(e.frameId)));
  const svg = await exportToSvg({
    elements: elements as readonly NonDeletedExcalidrawElement[],
    appState: { exportBackground: false, exportWithDarkMode: dark, viewBackgroundColor: "transparent", frameRendering: { enabled: true, name: false, outline: true, clip: true } },
    files: null,
    exportPadding: PAD,
    skipInliningFonts: true,
  });
  return { html: svg.outerHTML, x: b.x - PAD, y: b.y - PAD, w: b.w + 2 * PAD, h: b.h + 2 * PAD };
}

/** The canvas's picture for this scene version and theme; the last one stays up while the next renders. */
function useSceneSvg(canvasId: string, elements: readonly El[], version: number, dark: boolean): SceneSvg | null {
  const [svg, setSvg] = useState<SceneSvg | null>(null);
  useEffect(() => {
    let live = true;
    void sceneSvg(canvasId, elements, version, dark).then((s) => live && setSvg(s));
    return () => void (live = false);
  }, [canvasId, version, dark]);
  return svg;
}

/**
 * `canvasId`: the world's id of the canvas (./sources.ts); `run`: the figure the camera follows; `node`: the node it works at, when it is off the drawing;
 * `only`: who is drawn (those in this canvas or below it, and the followed one).
 */
export function BuildStage({ world, canvasId, run, size, out, only }: { world: BuildWorld; canvasId: string; run: string; size: { w: number; h: number }; out: boolean; only: (runId: string) => boolean }) {
  const nst = useNested();
  const dark = useTheme().resolved === "dark";
  const reduced = prefersReducedMotion();
  // the places (all of them, from the start: the figure walks to a node before it draws it) and the picture (what has been drawn by now)
  const elements = useMemo(() => (nst.scenes.get(canvasId) ?? []).filter((e) => !e.isDeleted), [nst.scenes, canvasId]);
  const version = useMemo(() => hashElementsVersion(elements), [elements]);
  const bounds = useMemo(() => boundsOf(elements), [elements]);
  const drawn = useSyncExternalStore(world.visible.subscribe, world.visible.get).get(canvasId);
  const picture = useMemo(() => (drawn ?? []).filter((e) => !e.isDeleted), [drawn]);
  const pictureVersion = useMemo(() => hashElementsVersion(picture), [picture]);
  const svg = useSceneSvg(canvasId, picture, pictureVersion, dark);
  const view = useMemo<CanvasViewState>(
    () => ({ id: canvasId, version, elements, map: byId(elements), appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, width: size.w, height: size.h, selectedElementIds: {} } as unknown as CanvasViewState["appState"] }),
    [canvasId, version, elements, size.w, size.h],
  );
  const scene = useRef<HTMLDivElement>(null);
  const live = useRef({ size, run, bounds, svg, reduced });
  live.current = { size, run, bounds, svg, reduced };
  const placeScene = () => {
    const v = viewport.get(canvasId);
    const s = live.current.svg;
    if (v && s && scene.current) scene.current.style.transform = `matrix(${v.zoom},0,0,${v.zoom},${((s.x + v.scrollX) * v.zoom).toFixed(2)},${((s.y + v.scrollY) * v.zoom).toFixed(2)})`;
  };
  // The camera: registered before the overlay's own frame job, so the picture and the figures move by the same view in the same frame.
  useLayoutEffect(() => {
    let cam: { x: number; y: number } | null = null;
    let last = 0;
    const job = (now: number) => {
      const L = live.current;
      const { w, h } = L.size;
      const b = L.bounds;
      if (!w || !h) return;
      const z = clamp(Math.min((w - 32) / (b.w + 96), (h - 32) / (b.h + 96)), 0.55, 1);
      const p = figurePositions.get(canvasId, L.run);
      const want = p ? { x: p.x, y: p.y - 40 / z } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      let r = { x0: b.x - 48, y0: b.y - 48, x1: b.x + b.w + 48, y1: b.y + b.h + 48 };
      if (p) r = { x0: Math.min(r.x0, p.x - 90), y0: Math.min(r.y0, p.y - 130), x1: Math.max(r.x1, p.x + 90), y1: Math.max(r.y1, p.y + 30) };
      const vw = w / z;
      const vh = h / z;
      const fit = (c: number, lo: number, hi: number, ext: number) => (hi - lo <= ext ? (lo + hi) / 2 : clamp(c, lo + ext / 2, hi - ext / 2));
      const to = { x: fit(want.x, r.x0, r.x1, vw), y: fit(want.y, r.y0, r.y1, vh) };
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!cam || L.reduced) cam = to;
      else {
        const a = 1 - Math.exp(-dt / 0.35);
        cam = { x: cam.x + (to.x - cam.x) * a, y: cam.y + (to.y - cam.y) * a };
        if (Math.abs(to.x - cam.x) < 0.05 && Math.abs(to.y - cam.y) < 0.05) cam = to;
      }
      viewport.set(canvasId, { scrollX: vw / 2 - cam.x, scrollY: vh / 2 - cam.y, zoom: z, width: w, height: h });
      placeScene();
    };
    job(performance.timeOrigin + performance.now());
    const off = frame.add(job);
    return () => {
      off();
      viewport.drop(canvasId);
      figurePositions.drop(canvasId);
      canvasWhere.delete(canvasId);
    };
  }, [canvasId]);
  useLayoutEffect(placeScene, [svg]);
  return (
    <div className="br-stage" data-out={out || undefined}>
      <div className="br-scene" ref={scene} style={svg ? { width: svg.w, height: svg.h } : { display: "none" }} dangerouslySetInnerHTML={svg ? { __html: svg.html } : undefined} />
      <WorkstationOverlay view={view} chrome={NO_CHROME} figuresOn only={only} />
    </div>
  );
}
