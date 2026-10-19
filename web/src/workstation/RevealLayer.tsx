// 分站揭示 on the page (web/docs/workstation.md §2 智能体改图; the timing is ./reveal.ts). An agent's batch is in the scene, in undo and in the saved file
// the moment it is applied; nothing here touches an element. While some of its new elements are still to come, Excalidraw's static canvas (the picture;
// selection, handles and text editing are on its interactive canvas, above, and keep working) is hidden, and this layer, under it, draws the canvas in its
// place: Excalidraw's SVG export of the scene without what is still to come (../buildreplay/scenePicture.ts, the build replay's picture), one picture
// per station — each with everything up to that station, so the order of the layers is the scene's — that fades in when the figure gets there; the
// station's arrows and lines are not faded but drawn, start to end, over it (`drawInk`). When the
// last station is in (or at REVEAL_CAP_MS, or the moment the person touches the canvas) the layer goes and the static canvas is back.
import { hashElementsVersion } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "../app/theme";
import { placeOf, sceneSvg, type SceneSvg } from "../buildreplay/scenePicture";
import type { El } from "../canvas/scene";
import { viewport, type Viewport } from "../canvas/viewport";
import { useHighlight } from "../session/ui";
import { clock, prefersReducedMotion, useReplay } from "./clock";
import { frame } from "./frame";
import { canvasWhere, stateAt } from "./place";
import { drawAt, elementTimes, holds, isDrawn, nodeTimes, REVEAL_CAP_MS, REVEAL_MIN, REVEAL_SETTLE_MS, SCHEDULE_WAIT_MS, shownAt, stationsOf, stopsOf, stopTime, type Held, type RevealEl, type RevealStop } from "./reveal";
import { useRuns, type Runs } from "./runs/store";

/** `flat`: decided once the runs have the change — true when it shows at once (one station), as it always did. */
type Hold = Held & { els: ReadonlyMap<string, RevealEl>; flat?: boolean };
type Host = (h: Hold) => boolean;
const hosts = new Map<string, Host>();

/**
 * The page executor (../session/agentBridge.ts `applyFromAgent`) tells the canvas, before the scene changes, which elements a batch adds (`els`: the
 * scene after it). Held only where the canvas is on the page with its figures; otherwise nothing happens and the batch shows at once.
 */
export function holdReveal(canvas: string, at: number, ids: readonly string[], els: ReadonlyMap<string, RevealEl>): boolean {
  return hosts.get(canvas)?.({ canvas, at, ids, els }) ?? false;
}

/** A station: the elements that appear together, and when (figure time). */
type Station = { t: number; ids: string[] };
/** One picture: the scene with everything up to station `i` (0: before the first) but the lines station `i` draws; or (`ink`) just those lines. */
type Layer = { key: string; i: number; ink: boolean; svg: SceneSvg | null };

const STATIC = "canvas.excalidraw__canvas.static";

/** `version`: the scene's (CanvasView's `view.version`): the pictures follow the scene while a batch is shown. */
export function RevealLayer({ api, canvasId, version, figuresOn }: { api: ExcalidrawImperativeAPI; canvasId: string; version: number; figuresOn: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const snap = useRef<HTMLCanvasElement>(null);
  const bg = useRef<HTMLDivElement>(null);
  const runs = useRuns();
  const replay = useReplay();
  const hl = useHighlight();
  const dark = useTheme().resolved === "dark";
  const [stations, setStations] = useState<Station[] | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const st = useRef({ held: [] as Hold[], seen: new Map<string, number | "walking">(), sig: "", stations: [] as Station[], snapView: null as Viewport | null, runs: runs as Runs, version: 0 });
  st.current.runs = runs;
  const live = useRef({ figuresOn, replay: !!replay });
  live.current = { figuresOn, replay: !!replay };

  const holding = () => st.current.held.length > 0;
  /** Everything shows: the layer goes, the static canvas is back. */
  const lift = () => {
    const s = st.current;
    if (!holding()) return;
    s.held = [];
    s.seen.clear();
    s.sig = "";
    s.stations = [];
    root.current?.parentElement?.removeAttribute("data-revealing");
    setStations(null);
    setLayers([]);
  };

  // the host: hold a batch (the static canvas is hidden from now on; until the first picture is ready, a copy of what it showed stands in)
  useEffect(() => {
    const host: Host = (h) => {
      const el = root.current;
      if (!el || prefersReducedMotion() || !live.current.figuresOn || live.current.replay || h.ids.length < REVEAL_MIN) return false;
      const s = st.current;
      if (!holding()) {
        const cv = el.parentElement?.querySelector<HTMLCanvasElement>(STATIC);
        const c = snap.current;
        if (cv && c) {
          c.width = cv.width;
          c.height = cv.height;
          c.style.width = cv.style.width || `${cv.clientWidth}px`;
          c.style.height = cv.style.height || `${cv.clientHeight}px`;
          c.style.filter = getComputedStyle(cv).filter;
          c.getContext("2d")?.drawImage(cv, 0, 0);
          c.style.display = "";
          s.snapView = viewport.get(canvasId) ?? null;
        }
        el.parentElement?.setAttribute("data-revealing", "");
      }
      s.held.push(h);
      setStations([]);
      return true;
    };
    hosts.set(canvasId, host);
    return () => {
      if (hosts.get(canvasId) === host) hosts.delete(canvasId);
      lift();
    };
  }, [canvasId]);

  // a person's hand on the canvas (a click, a key, a scroll), a replay, the figures off, a step of these elements outlined: everything shows at once
  useEffect(() => {
    if (!figuresOn || replay) lift();
  }, [figuresOn, replay]);
  useEffect(() => {
    if (!hl || hl.canvasId !== canvasId || !holding()) return;
    const pending = new Set(st.current.held.flatMap((h) => h.ids));
    if (hl.ids.some((id) => pending.has(id))) lift();
  }, [hl, canvasId]);
  useEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const hand = (e: Event) => {
      if (holding() && (e.target as Element | null)?.closest?.(".excalidraw")) lift();
    };
    const evs = ["pointerdown", "wheel", "keydown"] as const;
    evs.forEach((n) => parent.addEventListener(n, hand, { capture: true, passive: true }));
    return () => evs.forEach((n) => parent.removeEventListener(n, hand, { capture: true }));
  }, []);

  // when each station shows: every frame, from the runs' stops and where the figure is (figure time: the figures are drawn a moment behind now)
  useEffect(() => {
    if (stations == null) return;
    const step = (wall: number) => {
      const s = st.current;
      if (!holding()) return;
      const now = clock.figureTime(wall);
      const since = Math.min(...s.held.map((h) => h.at)) - 50;
      const stops = stopsOf(s.runs.roots, canvasId, since);
      const ctx = canvasWhere.get(canvasId)?.ctx;
      for (const stop of stops) {
        if (typeof s.seen.get(stop.key) === "number") continue; // arrived: that is when it was
        const x = seenAt(stop, s.runs, ctx, now);
        if (x === undefined) s.seen.delete(stop.key);
        else s.seen.set(stop.key, x);
      }
      const nodeAt = nodeTimes(stops, (x) => stopTime(x, s.seen.get(x.key)));
      const times = new Map<string, number>();
      let waiting = false;
      for (const h of s.held) {
        const t = elementTimes(h, h.els, nodeAt);
        if (h.flat == null) {
          // the runs have not taken the change in yet: wait for them a moment, then decide once — a single station shows as it always did
          if (!h.ids.some((id) => nodeAt.has(id)) && wall - h.at < SCHEDULE_WAIT_MS) {
            waiting = true;
            h.ids.forEach((id) => times.set(id, Infinity));
            continue;
          }
          h.flat = !holds({ count: h.ids.length, stations: stationsOf(t, h.at).length, reduced: false, figures: true });
        }
        // nothing stays hidden past the cap (wall clock), however the figure fares
        const over = h.flat || wall - h.at >= REVEAL_CAP_MS;
        for (const [id, x] of t) times.set(id, over ? -Infinity : x);
      }
      // stations, as the page groups them: elements that appear at one moment; the pictures are made again only when the grouping changes
      const by = new Map<number, string[]>();
      for (const [id, t] of times) if (t > now || t === Infinity) (by.get(t) ?? by.set(t, []).get(t)!).push(id);
      for (const [id, t] of times) if (t <= now && now < t + REVEAL_SETTLE_MS) (by.get(t) ?? by.set(t, []).get(t)!).push(id);
      const list: Station[] = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, ids]) => ({ t, ids: ids.sort() }));
      if (!list.length && !waiting) return lift();
      const sig = list.map((x) => x.ids.join(",")).join("|");
      s.stations = list;
      if (sig !== s.sig) {
        s.sig = sig;
        setStations(list);
      }
      place(now);
    };
    const place = (now: number) => {
      const el = root.current;
      const v = viewport.get(canvasId);
      if (!el || !v) return;
      const s = st.current;
      // the copy that stood in until the first picture: moved with the view since it was taken
      if (snap.current && s.snapView && snap.current.style.display !== "none") {
        const k = v.zoom / s.snapView.zoom;
        snap.current.style.transform = `matrix(${k},0,0,${k},${((v.scrollX - s.snapView.scrollX) * v.zoom).toFixed(2)},${((v.scrollY - s.snapView.scrollY) * v.zoom).toFixed(2)})`;
      }
      const pics = el.querySelectorAll<HTMLDivElement>("[data-layer]");
      const at = (i: number) => (i === 0 ? -Infinity : (s.stations[i - 1]?.t ?? Infinity));
      // layer i shows everything up to station i (0: none of them) but the lines station i draws; the topmost one that is fully in covers the ones below
      let top = 0;
      pics.forEach((p) => {
        const i = Number(p.dataset.layer);
        if (p.dataset.ink == null && p.dataset.ready === "1" && shownAt(at(i), now) >= 1) top = Math.max(top, i);
      });
      let any = false;
      pics.forEach((p) => {
        const i = Number(p.dataset.layer);
        const ink = p.dataset.ink != null;
        const o = shownAt(at(i), now);
        // a station's lines, drawn over its picture until the next picture (which has them) is fully in
        const show = p.dataset.ready === "1" && i >= top && o > 0;
        p.style.display = show ? "" : "none";
        if (!show) return;
        if (ink) drawInk(p, now - at(i));
        else p.style.opacity = String(o);
        any = true;
        p.style.transform = placeOf({ x: Number(p.dataset.x), y: Number(p.dataset.y) }, v);
      });
      if (any && snap.current) snap.current.style.display = "none";
    };
    step(performance.timeOrigin + performance.now());
    return frame.add(step);
  }, [stations == null, canvasId]);

  // the pictures: one per station, with everything up to it (made again when the stations or the scene change)
  // (a picture is known by what is in it, so one that only moves down a place — its station is in and it became the base — stays as it is)
  // A station's lines (arrows, lines and their labels) are not in its picture: they are a picture of their own over it, drawn stroke by stroke (`drawInk`);
  // the next station's picture has them as they are.
  useEffect(() => {
    if (!stations?.length) return setLayers([]);
    let alive = true;
    const scene = api.getSceneElements() as readonly El[];
    const map = new Map(scene.map((e) => [e.id, e as unknown as RevealEl] as const));
    const pending = new Set(stations.flatMap((x) => x.ids));
    const files = api.getFiles();
    const inkOf = (ids: readonly string[]) => {
      const lines = new Set(ids.filter((id) => map.get(id) && isDrawn(map.get(id)!)));
      return new Set(ids.filter((id) => lines.has(id) || (map.get(id)?.containerId && lines.has(map.get(id)!.containerId!))));
    };
    const sets: { els: El[]; v: number; ink: boolean; i: number }[] = [];
    for (let i = 0; i <= stations.length; i++) {
      const upTo = new Set(stations.slice(0, i).flatMap((x) => x.ids));
      const drawn = i ? inkOf(stations[i - 1].ids) : new Set<string>();
      const els = scene.filter((e) => (!pending.has(e.id) || upTo.has(e.id)) && !drawn.has(e.id));
      sets.push({ els, v: hashElementsVersion(els), ink: false, i });
      const ink = scene.filter((e) => drawn.has(e.id));
      if (ink.length) sets.push({ els: ink, v: hashElementsVersion(ink), ink: true, i });
    }
    const keys = sets.map((x, k) => `${x.ink ? "ink:" : ""}${x.v}#${sets.slice(0, k).filter((y) => y.v === x.v && y.ink === x.ink).length}`);
    setLayers((old) => sets.map((x, k) => ({ key: keys[k], i: x.i, ink: x.ink, svg: old.find((o) => o.key === keys[k])?.svg ?? null })));
    sets.forEach(({ els, v }, k) => {
      void sceneSvg(`reveal:${canvasId}`, els, v, dark, files).then((svg) => {
        if (alive) setLayers((ls) => ls.map((l) => (l.key === keys[k] ? { ...l, svg } : l)));
      });
    });
    return () => void (alive = false);
  }, [stations, version, dark]);
  useLayoutEffect(() => {
    if (bg.current) bg.current.style.background = api.getAppState().viewBackgroundColor;
  });

  return (
    <div className="ws-reveal" ref={root} data-dark={dark || undefined} hidden={!stations} aria-hidden>
      <div className="ws-reveal-bg" ref={bg} />
      <canvas className="ws-reveal-snap" ref={snap} style={{ display: "none" }} />
      {layers.map((l) => (
        <div
          key={l.key}
          className="ws-reveal-pic"
          data-layer={l.i}
          data-ink={l.ink ? "" : undefined}
          data-ready={l.svg ? "1" : "0"}
          data-x={l.svg?.x ?? 0}
          data-y={l.svg?.y ?? 0}
          style={l.svg ? { width: l.svg.w, height: l.svg.h, display: "none" } : { display: "none" }}
          dangerouslySetInnerHTML={l.svg ? { __html: l.svg.html } : undefined}
        />
      ))}
    </div>
  );
}

// ——— drawing a station's lines ———
// The ink picture is Excalidraw's export of just those lines and their labels, in scene order: each line is a group whose first path is its stroke (Rough.js
// draws it as two passes, two subpaths of one path) and whose other paths are its head; a label is a group with text in it, after its line (a mask for
// the gap the label leaves in the line sits between them). Each pass of a stroke becomes a path of its own, drawn from its start with a dash offset.

type Stroke = { el: SVGPathElement; len: number };
type InkLine = { strokes: Stroke[]; heads: SVGElement[]; labels: SVGElement[] };
const inks = new WeakMap<Element, { svg: Element; lines: InkLine[] }>();

function prepareInk(svg: SVGSVGElement): InkLine[] {
  const lines: InkLine[] = [];
  for (const g of [...svg.children]) {
    const tag = g.tagName.toLowerCase();
    if (tag !== "g" && tag !== "a") continue;
    if (g.querySelector("text")) {
      // a label: with the line before it
      lines[lines.length - 1]?.labels.push(g as SVGElement);
      continue;
    }
    const paths = [...g.querySelectorAll<SVGPathElement>("path")];
    if (!paths.length) continue;
    const [stroke, ...heads] = paths;
    const line: InkLine = { strokes: [], heads, labels: [] };
    const d = stroke.getAttribute("d") ?? "";
    // a dashed or dotted line keeps its own dashes: it fades in instead
    if (stroke.getAttribute("stroke-dasharray")) line.heads = paths;
    else
      for (const part of d.split(/(?=M)/).filter((x) => x.trim())) {
        const p = stroke.cloneNode() as SVGPathElement;
        p.setAttribute("d", part);
        stroke.parentNode!.insertBefore(p, stroke);
        const len = p.getTotalLength();
        p.style.strokeDasharray = `${len} ${len + 1}`;
        line.strokes.push({ el: p, len });
      }
    if (line.strokes.length) stroke.remove();
    lines.push(line);
  }
  return lines;
}

/** A station's lines `ms` after its moment: each drawn in turn from its start, its head as the stroke gets there, its label after. */
function drawInk(div: HTMLDivElement, ms: number) {
  const svg = div.querySelector("svg");
  if (!svg) return;
  let ink = inks.get(div);
  if (!ink || ink.svg !== svg) inks.set(div, (ink = { svg, lines: prepareInk(svg) }));
  const n = ink.lines.length;
  ink.lines.forEach((l, k) => {
    const { stroke, head, label } = drawAt(ms, k, n);
    for (const s of l.strokes) {
      s.el.style.strokeDashoffset = String(s.len * (1 - stroke));
      s.el.style.opacity = stroke > 0 ? "1" : "0";
    }
    for (const h of l.heads) h.style.opacity = String(l.strokes.length ? head : stroke);
    for (const t of l.labels) t.style.opacity = String(label);
  });
}

/** Where the figure is for this stop: arrived (when, figure time), still on its way, or not to be seen on this canvas (undefined: go by the plan). */
function seenAt(stop: RevealStop, runs: Runs, ctx: Parameters<typeof stateAt>[2] | undefined, now: number): number | "walking" | undefined {
  const run = runs.byId.get(stop.run);
  if (!ctx || !run || now < stop.seg.start) return undefined;
  const s = stateAt(run, now, ctx);
  if (!s.present || !s.seg || s.seg.start !== stop.seg.start || s.seg.path !== stop.seg.path) return undefined;
  return s.w >= 1 && !s.cut ? now : "walking";
}
