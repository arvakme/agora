// PR 回放's camera driver (web/docs/workstation.md「PR 回放」): while a PR plays the main view follows the
// figure — it goes into a sub-diagram when the figure goes in at a node's door, exactly as a click into the
// sub-diagram does (`nav.go`: the breadcrumb leads back), fits it to the pane, and returns to the parent
// when the figure comes out, and to the whole diagram for the summary and before each PR of a 连播. Leaving
// the replay puts back the canvas and the view it was entered from. Each switch is a cross-fade of the old
// picture into the new one (a view transition, ~400 ms with the mount; never through a blank frame); with
// reduced motion, or where the browser has no view transitions, it is a cut. Imperative, no React: it outlives the canvases it switches.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { El } from "../canvas/scene";
import { firstView, viewport, type Viewport } from "../canvas/viewport";
import { nav, nested } from "../nested/store";
import { canvases } from "../session/ui";
import { clock, prefersReducedMotion } from "./clock";
import { buildGeometry } from "./geometry";
import { stateAt, type Ctx } from "./place";
import { cameraCanvas } from "./replayCamera";
import { occupiedOf, excalidrawEl } from "./replayDom";
import { fitView, type Box } from "./replayFit";
import { replacingPush, withoutReplayParam } from "./replayHistory";
import { scenePlaces } from "./scenePlaces";
import type { WorkRun } from "./runs/types";

/** Room over the top nodes for the figure standing there and its bubble (px), and the margin round the rest. */
const FIGURE_ROOM = 100;
const MARGIN = 28;

const ctxs = new Map<string, { scenes: unknown; reduced: boolean; ctx: Ctx }>();
/** A canvas's own picture for the figure's state on it (as its overlay builds it), from the scene store: any canvas, open or not. */
export function ctxFor(id: string): Ctx | null {
  const st = nested.get();
  const els = st.scenes.get(id);
  if (!els) return null;
  const reduced = prefersReducedMotion();
  const hit = ctxs.get(id);
  if (hit && hit.scenes === st.scenes && hit.reduced === reduced) return hit.ctx;
  const map = new Map((els as readonly El[]).map((e) => [e.id, e]));
  const geom = buildGeometry(id, els.filter((e) => !e.isDeleted), map, st.scenes, (c) => st.titles[c]);
  const ctx: Ctx = { locate: geom.locate, dock: geom.dock, route: geom.route, ...scenePlaces(geom.boxes, map, st.index.has(id)), reduced, run: () => undefined };
  ctxs.set(id, { scenes: st.scenes, reduced, ctx });
  return ctx;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type CameraEvent = { at: number; t: number; from: string; to: string; title: string };
export type Camera = { tick: () => void; exit: () => Promise<void>; shown: () => string | null };

/**
 * `origin`: the canvas the replay was started from; `run`: the PR's run (null while it loads). Call
 * `tick` a few times a second; `exit` when leaving the replay.
 */
export function createCamera(origin: () => string | null, run: () => WorkRun | null): Camera {
  let home: string | null = null;
  let homeView: Viewport | null = null;
  let shown: string | null = null;
  let busy = false;
  /** How far down the replay bar reaches from the top of the canvas (px), measured on whichever canvas showed it. */
  let barCovers = 0;
  const measureBar = () => {
    const ex = excalidrawEl();
    const bar = ex?.closest("[data-pane]")?.querySelector<HTMLElement>(".ws-pr-bar");
    if (ex && bar && bar.offsetWidth) barCovers = Math.max(0, bar.getBoundingClientRect().bottom - ex.getBoundingClientRect().top);
  };
  /** The address and history state the replay was entered with: put back on leaving (minus ?replay=). */
  let entry: { state: unknown; href: string } | null = null;
  const log: CameraEvent[] = [];
  /** Each fit, for the evidence (window.__wsFits). */
  const fits: unknown[] = [];
  if (typeof window !== "undefined") Object.assign(window, { __wsCamera: log, __wsFits: fits });

  /** The view that fits `api`'s canvas to what the toolbar and the bar leave free of it. */
  function fitOf(api: ExcalidrawImperativeAPI) {
    const els = api.getSceneElements();
    if (!els.length) return null;
    const x0 = Math.min(...els.map((e) => e.x));
    const y0 = Math.min(...els.map((e) => e.y));
    const bounds: Box = { x: x0, y: y0, w: Math.max(...els.map((e) => e.x + e.width)) - x0, h: Math.max(...els.map((e) => e.y + e.height)) - y0 };
    const st = api.getAppState();
    // the replay bar reaches a new canvas's overlay a little after it mounts: what it covers is what it covered on the canvas before (the same bar, the same place)
    const ex = excalidrawEl();
    const occ = ex ? occupiedOf(ex) : { top: 0, right: 0, bottom: 0, left: 0 };
    occ.top = Math.max(occ.top, barCovers);
    const view = fitView({ pane: { w: st.width, h: st.height }, occupied: occ, margin: MARGIN, above: FIGURE_ROOM, maxZoom: 1, bounds });
    fits.push({ occupied: occ, pane: { w: st.width, h: st.height }, bounds, view, at: Date.now() });
    return view;
  }
  const setView = (api: ExcalidrawImperativeAPI, v: { scrollX: number; scrollY: number; zoom: number }) => api.updateScene({ appState: { scrollX: v.scrollX, scrollY: v.scrollY, zoom: { value: v.zoom } } as never });
  /** The view a canvas gets when it is shown: the one it was entered with (leaving the replay), else fitted. */
  const viewFor = (id: string, restore: boolean) => (api: ExcalidrawImperativeAPI) => {
    const v = restore && id === home ? homeView : fitOf(api);
    if (v) setView(api, v);
  };

  async function go(to: string, restore = false) {
    const from = shown!;
    busy = true;
    measureBar();
    try {
      const swap = async () => {
        // a canvas that is not mounted yet takes its view as it mounts (CanvasView's own fit would come after ours, once the page paints again)
        const mounted = !!canvases.get(to);
        if (!mounted) firstView.set(to, viewFor(to, restore));
        // the app's navigation pushes a history entry: during a replay it replaces the current one
        replacingPush(() => nav.go(from, to));
        shown = to;
        log.push({ at: Date.now(), t: clock.time(), from, to, title: nested.get().titles[to] ?? "" });
        for (let i = 0; i < 60 && !(canvases.get(to) && (viewport.get(to)?.width ?? 0) > 0); i++) await wait(40);
        if (mounted) {
          const api = canvases.get(to)?.api;
          if (api) viewFor(to, restore)(api);
        }
        await wait(60);
      };
      const vt = (document as Document & { startViewTransition?: (f: () => Promise<void>) => { finished: Promise<unknown> } }).startViewTransition;
      if (prefersReducedMotion() || !vt) await swap();
      else await vt.call(document, swap).finished.catch(() => {});
    } finally {
      firstView.drop(to);
      busy = false;
    }
  }

  return {
    shown: () => shown,
    tick() {
      const o = origin();
      if (!o || busy) return;
      measureBar();
      if (home !== o) {
        home = o;
        shown = o;
        homeView = viewport.get(o) ?? null;
        entry = { state: history.state, href: location.href };
        // the canvas it starts on is fitted too (the bar and the toolbar cover its top)
        const api = canvases.get(o)?.api;
        if (api) viewFor(o, false)(api);
        return;
      }
      const r = run();
      let want = o;
      if (r) {
        const t = clock.time();
        if (t >= r.segs[0].start) {
          const sum = r.segs[r.segs.length - 1];
          want = cameraCanvas(o, (c) => {
            const ctx = ctxFor(c);
            if (!ctx) return { behind: false, into: null };
            const st = stateAt(r, t, ctx);
            return { behind: !st.present && st.portalPhase === "behind", into: st.portal?.canvasId ?? null };
          }, { summary: t >= sum.start });
        }
      }
      if (want !== shown) void go(want);
    },
    async exit() {
      while (busy) await wait(30);
      if (home && shown && shown !== home) await go(home, true);
      else if (home && homeView) {
        const api = canvases.get(home)?.api;
        if (api) viewFor(home, true)(api);
      }
      // the history is what it was: this entry, with the address it had (the replay's own ?replay= left out)
      if (entry) history.replaceState(entry.state, "", withoutReplayParam(entry.href));
      entry = null;
      home = shown = null;
      homeView = null;
    },
  };
}
