// One canvas of the replay: its picture (Excalidraw's SVG export of the scene as it is at the moment shown) under the ordinary 工位视图
// overlay — the figures walk its bridges, climb its ladders, go through its doors — seen by the director's camera (../workstation/director.ts `cameraStep`,
// the shot is ./camera.ts; web/docs/share-build-replay.md §5) on the replay's own world (./sources.ts).
import { exportToSvg, getCommonBounds, hashElementsVersion } from "@excalidraw/excalidraw";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "../app/theme";
import type { CanvasViewState } from "../canvas/CanvasView";
import type { Box } from "../canvas/clearance";
import { byId, type El } from "../canvas/scene";
import { viewport } from "../canvas/viewport";
import { useNested } from "../nested/store";
import { clock, prefersReducedMotion } from "../workstation/clock";
import { cameraStart, viewAt, type CameraState } from "../workstation/director";
import { figurePositions } from "../workstation/focus";
import { frame } from "../workstation/frame";
import { WorkstationOverlay } from "../workstation/Overlay";
import { canvasWhere } from "../workstation/place";
import { jumped, shotOf, stepOf } from "./camera";
import type { BuildWorld } from "./sources";
import "./buildreplay.css";

const NO_CHROME: Box[] = [];
const PAD = 16;
/** A view put on the stage as a cut: the picture cross-fades into it (a view transition, as the live camera's cut); with reduced motion, or where there is none, it is simply there. */
function cutTo(apply: () => void, reduced: boolean) {
  const vt = (document as Document & { startViewTransition?: (f: () => Promise<void>) => unknown }).startViewTransition;
  if (reduced || !vt) return apply();
  vt.call(document, async () => {
    apply();
    await new Promise((r) => setTimeout(r, 60));
  });
}

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
  const live = useRef({ size, run, bounds, svg, reduced, out });
  live.current = { size, run, bounds, svg, reduced, out };
  const placeScene = () => {
    const v = viewport.get(canvasId);
    const s = live.current.svg;
    if (v && s && scene.current) scene.current.style.transform = `matrix(${v.zoom},0,0,${v.zoom},${((s.x + v.scrollX) * v.zoom).toFixed(2)},${((s.y + v.scrollY) * v.zoom).toFixed(2)})`;
  };
  // The camera: registered before the overlay's own frame job, so the picture and the figures move by the same view in the same frame. The director's camera
  // (a rate-limited carrot and a critically damped spring) runs in play time, so a faster replay has a quicker camera as it has quicker figures; a jump in the
  // clock (the scrubber) puts it on the shot; a figure cut across (a hop) is a cut of the view too, at the same moment; a layer that is fading out holds.
  useLayoutEffect(() => {
    let cam: CameraState | null = null;
    let last = 0;
    let gen = clock.gen();
    let prev: { x: number; y: number } | null = null;
    const job = (now: number) => {
      const L = live.current;
      const { w, h } = L.size;
      if (!w || !h) return;
      const p = figurePositions.get(canvasId, L.run) ?? null;
      const shot = shotOf({ size: L.size, bounds: L.bounds, figure: p });
      const dt = last ? Math.min(100, now - last) : 0;
      last = now;
      const c = clock.get();
      const k = c?.playing ? Math.min(4, c.speed) : 1;
      if (clock.gen() !== gen) ((gen = clock.gen()), (cam = null), (prev = null));
      if (!cam || L.reduced) cam = cameraStart(viewAt(shot.centre, shot.zoom, L.size), L.size);
      const out = stepOf(cam, L.out ? null : shot, { dt: dt * k, now: clock.time(), pane: L.size, cut: !L.out && jumped(prev, p) });
      prev = p ?? prev;
      cam = L.reduced ? cameraStart(viewAt(shot.centre, shot.zoom, L.size), L.size) : out.state;
      const v = L.reduced ? viewAt(shot.centre, shot.zoom, L.size) : out.view;
      const apply = () => {
        viewport.set(canvasId, { scrollX: v.scrollX, scrollY: v.scrollY, zoom: v.zoom, width: w, height: h });
        placeScene();
      };
      if (out.cut && !L.reduced) cutTo(apply, false);
      else apply();
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
