// The follow pane (web/docs/workstation.md §10 子视图跟随): a read-only window at the right of the
// canvas in use that keeps one agent in view while it works in sub-diagrams. Inside: the canvas the
// agent is in (the deepest one that has its file, ./subview.ts) as Excalidraw's SVG export, cached
// per scene version, under the same 工位视图 overlay the canvas has (./Overlay.tsx) — so there too it
// walks bridges, climbs ladders and stands on that canvas's nodes — seen through a camera that
// glides after it.
//
// It opens by itself when any agent starts working on a file below the canvas in use (the latest
// newcomer wins; a row of avatars switches between those inside), follows it deeper and back up
// with a short cross-fade, and once it has left them all (or finished) says so and closes about
// 3 s later — unless pinned or under the pointer. F / 跟随 open it for the selected figure, wherever
// that is. The person's own canvas never moves and never changes level (only 在主画布打开 does that).
import { exportToSvg, getCommonBounds, hashElementsVersion } from "@excalidraw/excalidraw";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { cloneElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { IconClose, IconEnter, IconPin } from "../app/icons";
import { useTheme } from "../app/theme";
import type { CanvasViewState } from "../canvas/CanvasView";
import type { Box } from "../canvas/clearance";
import { byId, type El } from "../canvas/scene";
import { viewport } from "../canvas/viewport";
import { nav, useNested } from "../nested/store";
import { canvases } from "../session/ui";
import { clock, prefersReducedMotion, useReplay, useTick, useWorkstation } from "./clock";
import { figurePositions } from "./focus";
import { follow, paneView, useFollow } from "./follow";
import { useReplays } from "./replayMode";
import { frame } from "./frame";
import { WorkstationOverlay } from "./Overlay";
import { canvasWhere } from "./place";
import { RunAvatar } from "./RunAvatar";
import { useRuns } from "./runs/store";
import { arrivals, presenceAt, subviewCtx, type Level } from "./subview";
import "./follow.css";

/** How long the pane stays after its agent has left or finished (unless pinned or hovered). */
const LINGER_MS = 3000;
/** The cross-fade between two canvases, and the pane's own exit (follow.css). */
const SWAP_MS = 300;
const CLOSE_MS = 180;
const NO_CHROME: Box[] = [];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const untitled = (t: string | undefined) => t || "未命名画布";

type Layer = { canvasId: string; out: boolean };

export function FollowPane({ main }: { main: string }) {
  const f = useFollow();
  const runs = useRuns();
  const nst = useNested();
  // a PR replay has its own camera (./replayView.ts): no pane while it plays
  const prOn = !!useReplays().id;
  const on = useWorkstation() && !prOn;
  useReplay();
  useTick(250);
  const t = clock.time();
  const reduced = prefersReducedMotion();
  const ctx = useMemo(() => subviewCtx(main, nst.scenes, nst.titles, (id) => runs.byId.get(id)), [main, nst.scenes, nst.titles, runs]);
  const ps = new Map(runs.flat.map((x) => [x.run.id, presenceAt(x.run, t, ctx)] as const));

  // ── the pane's own choices, ≤ 4 Hz: open for a newcomer, move on when its agent leaves, say it ended ──
  const announced = useRef(new Map<string, number>());
  useEffect(() => {
    const cur = follow.get();
    const fresh = arrivals(ps, announced.current);
    for (const [id, p] of ps) if (p?.entered != null) announced.current.set(id, p.entered);
    if (!on) return void (cur.run && cur.auto && follow.stop());
    // Someone came below to work: follow the latest — unless the person chose whom to follow.
    if (fresh.length && (!cur.run || cur.auto)) return void follow.start(fresh[0], { auto: true });
    if (!cur.run) return;
    const p = ps.get(cur.run);
    const below = !!p && !p.ended && (p.levels?.length ?? 0) > 1;
    if (cur.auto && !below) {
      // It left (or finished): the latest of the others still working below takes over.
      const next = arrivals(ps, new Map()).find((id) => id !== cur.run);
      if (next) return void follow.start(next, { auto: true });
    }
    const done = !p || p.ended || (cur.auto && !below);
    if (done && !cur.ended) follow.end();
    else if (!done && cur.ended) follow.start(cur.run, { auto: cur.auto });
  });
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!f.run) return setHovered(false);
    if (!f.ended || f.pinned || hovered) return;
    const tm = window.setTimeout(() => follow.stop(), LINGER_MS);
    return () => clearTimeout(tm);
  }, [f.run, f.ended, f.pinned, hovered]);

  // ── what it shows: the canvas its agent is in; where it last was once it has gone or ended ──
  const p = f.run ? ps.get(f.run) : undefined;
  const stay = useRef<{ run: string; levels: Level[] | null } | null>(null);
  // Followed by itself, only a sub-view counts (leaving one, it stays on it while it says so).
  if (f.run && p && (!f.auto || (!p.ended && (p.levels?.length ?? 0) > 1))) stay.current = { run: f.run, levels: p.levels };
  const known = f.run && stay.current?.run === f.run ? stay.current : null;
  const levels = known?.levels ?? null;
  const deepest = levels?.[levels.length - 1];
  const target = deepest?.canvasId ?? main;
  const [layers, setLayers] = useState<Layer[]>([]);
  const current = layers.find((l) => !l.out)?.canvasId;
  if (f.run && current !== target)
    setLayers(reduced || !current ? [{ canvasId: target, out: false }] : [...layers.filter((l) => l.canvasId !== target).map((l) => ({ ...l, out: true })), { canvasId: target, out: false }]);
  if (!f.run && layers.length) setLayers([]);
  useEffect(() => {
    if (!layers.some((l) => l.out)) return;
    const tm = window.setTimeout(() => setLayers((ls) => ls.filter((l) => !l.out)), SWAP_MS + 40);
    return () => clearTimeout(tm);
  }, [layers]);

  // ── where: the right of the canvas in use, below its toolbar, above the timeline ──
  const open = !!f.run && (on || !f.auto);
  const [rect, setRect] = useState<{ left: number; top: number; right: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const el = document.querySelector<HTMLElement>(`[data-pane="${CSS.escape(main)}"] .canvas-layers`);
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect((o) => (o && o.left === r.left && o.top === r.top && o.right === r.right && o.height === r.height ? o : { left: r.left, top: r.top, right: r.right, width: r.width, height: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    addEventListener("resize", measure);
    const iv = window.setInterval(measure, 500); // panes glide after layout changes
    return () => (ro.disconnect(), removeEventListener("resize", measure), clearInterval(iv));
  }, [main, open]);
  const body = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!open || !el) return;
    const measure = () => setSize((s) => (s && s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, !!rect]);

  const flat = f.run ? runs.flat.find((x) => x.run.id === f.run) : undefined;
  const mainTitle = untitled(nst.titles[main]);
  const crumbs = levels ? [...levels.map((l) => untitled(l.title)), deepest!.label] : known ? [mainTitle, "图外"] : [mainTitle];
  // Everyone standing below the canvas in use (tree order, so the avatars never trade places), and the followed one.
  const row = runs.flat.filter((x) => x.run.id === f.run || (ps.get(x.run.id)?.levels?.length ?? 0) > 1);
  const note = !f.ended ? null : p && !p.ended ? `回到 ${mainTitle}` : "已结束";
  const pos = rect && {
    top: rect.top + 64,
    right: Math.max(8, innerWidth - rect.right + 12),
    width: clamp(rect.width * 0.4, Math.min(300, rect.width - 24), 720),
    height: clamp(rect.height * 0.55, Math.min(220, rect.height - 80), Math.max(160, rect.height - 80)),
  };
  const openInMain = () => {
    nav.go(main, target);
    follow.stop();
  };

  // Enter: slides in from the right (CSS). Leave: the last picture fades out the same way, then
  // unmounts. Reduced motion: it just appears and goes.
  const shown = open && flat && pos;
  const last = useRef<ReactElement | null>(null);
  const [leaving, setLeaving] = useState<ReactElement | null>(null);
  if (!shown && last.current && !leaving && !reduced) setLeaving(cloneElement(last.current, { "data-closing": "" } as object));
  if (shown && leaving) setLeaving(null);
  useEffect(() => {
    if (!leaving) return;
    const tm = window.setTimeout(() => ((last.current = null), setLeaving(null)), CLOSE_MS);
    return () => clearTimeout(tm);
  }, [leaving]);
  if (!shown) {
    if (reduced) last.current = null;
    return leaving;
  }
  return (last.current = (
        <section
          key="follow"
          className="ws-follow"
          style={pos}
          aria-label={`跟随 ${flat.run.name}`}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          data-ended={f.ended || undefined}
        >
          <header className="ws-follow-head">
            {row.length > 1 ? (
              <div className="ws-follow-who" role="tablist" aria-label="子视图里的 agent">
                {row.map((x) => (
                  <button
                    key={x.run.id}
                    role="tab"
                    aria-selected={x.run.id === f.run}
                    title={`跟随 ${x.run.name}${x.parent ? `（${x.parent.name} 派的）` : ""}`}
                    onClick={() => follow.start(x.run.id)}
                  >
                    <RunAvatar agent={x.run.agent} size={18} parent={x.parent?.agent} />
                  </button>
                ))}
              </div>
            ) : (
              <RunAvatar agent={flat.run.agent} size={20} parent={flat.parent?.agent} />
            )}
            <div className="ws-follow-ttl">
              <b>{flat.run.name}</b>
              {flat.parent && <span className="par">{flat.parent.name} 派的</span>}
              <ol className="ws-follow-crumbs" aria-label="它在哪">
                {crumbs.map((c, i) => (
                  <li key={i} aria-current={i === crumbs.length - 1 ? "location" : undefined}>{c}</li>
                ))}
              </ol>
            </div>
            <div className="ws-follow-acts">
              <button className="icon-btn xs" aria-pressed={f.pinned} data-on={f.pinned || undefined} onClick={() => follow.pin(!f.pinned)} title={f.pinned ? "取消钉住" : "钉住：它离开或结束后也不收起"} aria-label="钉住">
                <IconPin size={14} />
              </button>
              <button className="icon-btn xs" disabled={target === main} onClick={openInMain} title={`在主画布打开「${untitled(nst.titles[target])}」`} aria-label="在主画布打开">
                <IconEnter size={14} />
              </button>
              <button className="icon-btn xs" onClick={() => follow.stop()} title="停止跟随（Esc）" aria-label="停止跟随">
                <IconClose size={14} />
              </button>
            </div>
          </header>
          <div className="ws-follow-body" ref={body}>
            {size &&
              size.w > 0 &&
              layers.map((l) => (
                <Stage
                  key={l.canvasId}
                  canvasId={l.canvasId}
                  run={flat.run.id}
                  node={l.canvasId === target ? deepest?.node : undefined}
                  size={size}
                  out={l.out}
                  reduced={reduced}
                  // only who is in this canvas (or below it) and the one followed — the others would stand at its 图外 tray
                  only={(id) => id === flat.run.id || !!ps.get(id)?.levels?.some((lv) => lv.canvasId === l.canvasId)}
                />
              ))}
            {note && (
              <div className="ws-follow-note" role="status">
                <span>
                  {flat.run.name} {note}
                </span>
                {!f.pinned && <em>即将收起</em>}
              </div>
            )}
          </div>
        </section>
  ));
}

/**
 * One canvas in the pane: its picture and the overlay, seen by the pane's camera — zoomed to show
 * the whole drawing when it fits (between 55 % and 100 %), gliding after the figure otherwise, and
 * kept on the drawing (or on the figure when it stands off it, like at 图外).
 */
function Stage({ canvasId, run, node, size, out, reduced, only }: { canvasId: string; run: string; node?: string; size: { w: number; h: number }; out: boolean; reduced: boolean; only: (runId: string) => boolean }) {
  const nst = useNested();
  const dark = useTheme().resolved === "dark";
  const elements = useMemo(() => (nst.scenes.get(canvasId) ?? []).filter((e) => !e.isDeleted), [nst.scenes, canvasId]);
  const version = useMemo(() => hashElementsVersion(elements), [elements]);
  const bounds = useMemo(() => boundsOf(elements), [elements]);
  const svg = useSceneSvg(canvasId, elements, version, dark);
  const id = paneView(canvasId);
  const view = useMemo<CanvasViewState>(
    () => ({ id, version, elements, map: byId(elements), appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, width: size.w, height: size.h, selectedElementIds: {} } as unknown as CanvasViewState["appState"] }),
    [id, version, elements, size.w, size.h],
  );
  const scene = useRef<HTMLDivElement>(null);
  const live = useRef({ size, run, node, bounds, svg, reduced, map: view.map });
  live.current = { size, run, node, bounds, svg, reduced, map: view.map };
  const placeScene = () => {
    const v = viewport.get(id);
    const s = live.current.svg;
    if (v && s && scene.current) scene.current.style.transform = `matrix(${v.zoom},0,0,${v.zoom},${((s.x + v.scrollX) * v.zoom).toFixed(2)},${((s.y + v.scrollY) * v.zoom).toFixed(2)})`;
  };
  // The camera: registered before the overlay's own frame job (that one is a passive effect), so
  // the picture and the figures move by the same view in the same frame.
  useLayoutEffect(() => {
    let cam: { x: number; y: number } | null = null;
    let last = 0;
    const job = (now: number) => {
      const L = live.current;
      const { w, h } = L.size;
      const b = L.bounds;
      if (!w || !h) return;
      const z = clamp(Math.min((w - 32) / (b.w + 96), (h - 32) / (b.h + 96)), 0.55, 1);
      const p = figurePositions.get(id, L.run);
      const at = L.node ? L.map.get(L.node) : undefined;
      const want = p ? { x: p.x, y: p.y - 40 / z } : at ? { x: at.x + at.width / 2, y: at.y } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
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
      viewport.set(id, { scrollX: vw / 2 - cam.x, scrollY: vh / 2 - cam.y, zoom: z, width: w, height: h });
      placeScene();
    };
    job(performance.timeOrigin + performance.now());
    const off = frame.add(job);
    return () => {
      off();
      viewport.drop(id);
      figurePositions.drop(id);
      canvasWhere.delete(id);
    };
  }, [id]);
  useLayoutEffect(placeScene, [svg]);
  return (
    <div className="ws-follow-stage" data-out={out || undefined}>
      <div className="ws-follow-scene" ref={scene} style={svg ? { width: svg.w, height: svg.h } : { display: "none" }} dangerouslySetInnerHTML={svg ? { __html: svg.html } : undefined} />
      <WorkstationOverlay view={view} chrome={NO_CHROME} figuresOn only={only} />
    </div>
  );
}

/** The drawing's extent (scene coordinates). */
function boundsOf(elements: readonly El[]): Box {
  if (!elements.length) return { x: 0, y: 0, w: 1, h: 1 };
  const [x0, y0, x1, y1] = getCommonBounds(elements);
  return Number.isFinite(x0) ? { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) } : { x: 0, y: 0, w: 1, h: 1 };
}

/** A canvas as SVG (Excalidraw's export, without background or frame names), and where it sits in scene coordinates. */
type SceneSvg = { html: string; x: number; y: number; w: number; h: number };
const PAD = 16;
const svgs = new Map<string, Promise<SceneSvg | null>>();

function sceneSvg(canvasId: string, elements: readonly El[], version: number, dark: boolean): Promise<SceneSvg | null> {
  const key = `${canvasId}|${version}|${dark ? "d" : "l"}`;
  let p = svgs.get(key);
  if (!p) {
    if (svgs.size >= 24) svgs.delete(svgs.keys().next().value!);
    p = exportScene(canvasId, elements, dark).catch(() => null);
    svgs.set(key, p);
  }
  return p;
}

async function exportScene(canvasId: string, elements: readonly El[], dark: boolean): Promise<SceneSvg | null> {
  if (!elements.length) return null;
  // What the export frames: the elements not inside a frame, and the frames (Excalidraw's getRootElements).
  const frames = new Set(elements.filter((e) => e.type === "frame" || e.type === "magicframe").map((e) => e.id));
  const b = boundsOf(elements.filter((e) => frames.has(e.id) || !e.frameId || !frames.has(e.frameId)));
  const svg = await exportToSvg({
    elements: elements as readonly NonDeletedExcalidrawElement[],
    appState: { exportBackground: false, exportWithDarkMode: dark, viewBackgroundColor: "transparent", frameRendering: { enabled: true, name: false, outline: true, clip: true } },
    files: canvases.get(canvasId)?.api.getFiles() ?? null,
    exportPadding: PAD,
    skipInliningFonts: true, // the page has the fonts
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
