// The camera driver of a played turn (web/docs/workstation.md §11 按轮追踪): while a turn plays the main view follows the
// figure — it goes into a sub-diagram when the figure goes in at a node's door, exactly as a click into the
// sub-diagram does (`nav.go`: the breadcrumb leads back), fits it to the pane, and returns to the parent
// when the figure comes out, and to the whole diagram for the summary. Leaving
// the play puts back the canvas and the view it was entered from. Each switch is a cross-fade of the old
// picture into the new one (a view transition, ~400 ms with the mount; never through a blank frame); with
// reduced motion, or where the browser has no view transitions, it is a cut. Imperative, no React: it outlives the canvases it switches.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { El } from "../canvas/scene";
import { goHomeDue, nextPaused, type PauseEvent } from "./liveCamera";
import { firstView, viewport, type Viewport } from "../canvas/viewport";
import { nav, nested } from "../nested/store";
import { canvases } from "../session/ui";
import { clock, prefersReducedMotion } from "./clock";
import { buildGeometry } from "./geometry";
import { stateAt, type Ctx } from "./place";
import { cameraCanvas } from "./replayCamera";
import { occupiedOf, excalidrawEl } from "./replayDom";
import { fitView, viewShowsContent, type Box } from "./replayFit";
import { followView } from "./replayFollow";
import { figurePositions } from "./focus";
import { replacingPush } from "./replayHistory";
import { scenePlaces } from "./scenePlaces";
import type { WorkRun } from "./runs/types";

/** Room over the top nodes for the figure standing there and its bubble (px), and the margin round the rest. */
const FIGURE_ROOM = 100;
const MARGIN = 28;
/** The follow camera: 100 % preferred, 70 % at the least, 125 % at the most; screen px the figure needs round its feet (head and bubble above, the bubble to each side); the dead zone; how fast the view catches up (ms). */
const ZOOM = { preferred: 1, min: 0.7, max: 1.25 };
const ROOM = { up: 120, side: 170, down: 20 };
const DEAD = 0.18;
const CATCH_UP_MS = 320;
/** A look at the whole diagram this long after the replay's first beat starts (the clock begins 400 ms before it), and for the summary. */
const OVERVIEW_MS = 600;

const ctxs = new Map<string, { scenes: unknown; reduced: boolean; ctx: Ctx; boxOf: (place: string) => Box | undefined }>();
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
  ctxs.set(id, { scenes: st.scenes, reduced, ctx, boxOf: geom.boxOf });
  return ctx;
}
/** A place's box on a canvas (scene coordinates), once `ctxFor` has built it. */
const boxOfFor = (id: string, place: string) => ctxs.get(id)?.boxOf(place);

const now = () => performance.now();
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type CameraEvent = { at: number; t: number; from: string; to: string; title: string };
export type Camera = { tick: () => void; frame: (dtMs: number) => void; resume: () => void; exit: () => Promise<void>; /** Let go without putting anything back (the live camera). */ stop: () => void; shown: () => string | null };
/** The live camera (./liveCamera.ts, web/docs/workstation.md 默认跟随): follows an agent at work in everyday use, with no window to play. */
export type LiveHooks = {
  /** The canvas the person has in front of them (the main pane's). */
  current: () => string | null;
  /** Whether there is work on the diagram to follow (on a node or on the way): idle, or in the tray, the camera holds still — and after a while goes home. */
  awake: () => boolean;
  /** Whether the camera has taken the canvas away from the one the person is on: saving the layout and the 「在子图里」 hint wait meanwhile. */
  away: (on: boolean) => void;
};
export type CameraHooks = { /** The person moved the canvas themself: the camera stops following until told to (the bar's 「跟随小人」). */ setManual: (on: boolean) => void; live?: LiveHooks };

/**
 * `origin`: the canvas the replay was started from; `run`: the traced agent's run. Call
 * `tick` a few times a second; `exit` when leaving the replay.
 */
export function createCamera(origin: () => string | null, run: () => WorkRun | null, getWindow: () => { start: number; end: number | null } | null, hooks: CameraHooks = { setManual: () => {} }): Camera {
  const live = hooks.live;
  const tag = live ? "Live" : "";
  let manual = false;
  let chasing = false;
  /** Leaving (a play's exit is under way): nothing else moves the view meanwhile. */
  let leaving = false;
  /** Live: how many ticks in a row the canvas in front of the person was not the one the camera shows; whether it is `away`. */
  let mismatch = 0;
  /** Live: since when there has been nothing to follow (performance.now), and whether the view is on its way back to `homeView`. */
  let holdSince: number | null = null;
  let returning = false;
  let awayNow = false;
  const setAway = (on: boolean) => {
    if (on === awayNow) return;
    awayNow = on;
    live?.away(on);
  };
  const pause = (ev: PauseEvent) => {
    if (nextPaused(manual, ev) === manual) return;
    manual = true;
    hooks.setManual(true);
  };
  let lastSample = 0;
  const zooms: [number, string, number][] = [];
  if (typeof window !== "undefined") Object.assign(window, { [`__wsZooms${tag}`]: zooms });
  let home: string | null = null;
  let homeView: Viewport | null = null;
  let shown: string | null = null;
  let busy = false;
  /** How far down the replay bar reaches from the top of the canvas (px), measured on whichever canvas showed it. */
  let barCovers = 0;
  const measureBar = () => {
    const ex = excalidrawEl();
    const bar = ex?.closest("[data-pane]")?.querySelector<HTMLElement>(".ws-play-bar");
    if (ex && bar && bar.offsetWidth) barCovers = Math.max(0, bar.getBoundingClientRect().bottom - ex.getBoundingClientRect().top);
  };
  /** The address and history state the replay was entered with: put back on leaving (minus ?replay=). */
  let entry: { state: unknown; href: string } | null = null;
  const log: CameraEvent[] = [];
  /** Each fit, for the evidence (window.__wsFits). */
  const fits: unknown[] = [];
  if (typeof window !== "undefined") Object.assign(window, { [`__wsCamera${tag}`]: log, [`__wsFits${tag}`]: fits });

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
  /** Whole diagram (the first moment of a replay, the summary, when the person has taken over) or the figure close up. */
  const overviewAt = (w: { start: number; end: number | null }, t: number) => manual || t < w.start + OVERVIEW_MS || (w.end != null && t >= w.end);
  /** The follow view on canvas `id` at time `t`: the figure, the node it is going to and its bubble. */
  function followOf(api: ExcalidrawImperativeAPI, id: string, r: WorkRun, t: number, current: { zoom: number; scrollX: number; scrollY: number } | null) {
    const ctx = ctxFor(id);
    if (!ctx) return null;
    const st = stateAt(r, t, ctx);
    const appState = api.getAppState();
    const ex = excalidrawEl();
    const occ = ex ? occupiedOf(ex) : { top: 0, right: 0, bottom: 0, left: 0 };
    occ.top = Math.max(occ.top, barCovers);
    // where it stands now (as drawn), else at the dock of its place — a canvas just mounted has drawn nothing yet
    const dock = ctx.dock(st.at);
    const figure = figurePositions.get(id, r.id) ?? dock;
    return followView({ pane: { w: appState.width, h: appState.height }, occupied: occ, margin: MARGIN, figure, node: boxOfFor(id, st.at) ?? null, room: ROOM, zoom: ZOOM, current, dead: DEAD });
  }
  /** The view a canvas gets when it is shown: the one it was entered with (leaving the replay), else the whole diagram or the figure close up. */
  const viewFor = (id: string, restore: boolean) => (api: ExcalidrawImperativeAPI) => {
    let v: { zoom: number; scrollX: number; scrollY: number } | null = restore && id === home ? homeView : null;
    if (!v && !restore) {
      const r = run();
      const w = getWindow();
      v = r && w && !overviewAt(w, clock.time()) ? (followOf(api, id, r, clock.time(), null)?.view ?? null) : null;
    }
    v ??= restore && id === home ? homeView : fitOf(api);
    if (v) setView(api, v);
  };

  async function go(to: string, restore = false) {
    const from = shown!;
    // live: the view of the canvas the person is on, to give back when the camera comes home
    if (live && from === home && !restore) homeView ??= viewport.get(from) ?? null;
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

  // the person's own pan or zoom of the canvas takes the camera from us until they hand it back
  const takeOver = (e: Event) => {
    const el = e.target as HTMLElement | null;
    // live: opening the comment dock is the person's doing too
    if (live && e.type === "pointerdown" && el?.closest?.(".dock")) return pause("comment");
    if (!el?.closest?.(".excalidraw") || el.closest?.(".ws-play-bar, .ws-live-bar")) return;
    if (el.tagName === "CANVAS" || el.closest(".zoom-actions")) pause(e.type === "wheel" ? "zoom" : "pan");
  };
  // live: Esc, and typing into an element of the canvas (its text editor), pause it as well
  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (e.key === "Escape") return void ((!typing || !!el?.closest?.(".excalidraw")) && pause("escape"));
    if (typing && el?.closest?.(".excalidraw")) pause("edit");
  };
  const listen = (on: boolean) => {
    for (const ev of ["pointerdown", "wheel"] as const) on ? addEventListener(ev, takeOver, true) : removeEventListener(ev, takeOver, true);
    if (live) on ? addEventListener("keydown", onKey, true) : removeEventListener("keydown", onKey, true);
  };
  /** Live: the camera lets go (a play takes over, the switch is off, the timeline is replaying): nothing put back — the person's view is theirs. */
  const release = () => {
    listen(false);
    setAway(false);
    manual = chasing = false;
    hooks.setManual(false);
    home = shown = null;
    homeView = null;
    entry = null;
    mismatch = 0;
    holdSince = null;
    returning = false;
  };
  /** Live: the view eases back to the one it started from (a cut with reduced motion), once the work is over. */
  const homeStep = (dtMs: number) => {
    if (!returning || !home || shown !== home || !homeView) return;
    const api = canvases.get(home)?.api;
    const v = viewport.get(home);
    if (!api || !v || !v.width) return;
    const cur = { zoom: v.zoom, scrollX: v.scrollX, scrollY: v.scrollY };
    const near = Math.abs(homeView.zoom - cur.zoom) < 0.004 && Math.abs(homeView.scrollX - cur.scrollX) * cur.zoom < 1.5 && Math.abs(homeView.scrollY - cur.scrollY) * cur.zoom < 1.5;
    if (near || prefersReducedMotion()) {
      setView(api, homeView);
      returning = false;
      homeView = null;
      return;
    }
    const k = 1 - Math.exp(-Math.min(dtMs, 100) / CATCH_UP_MS);
    setView(api, { zoom: cur.zoom + (homeView.zoom - cur.zoom) * k, scrollX: cur.scrollX + (homeView.scrollX - cur.scrollX) * k, scrollY: cur.scrollY + (homeView.scrollY - cur.scrollY) * k });
  };
  /** The live tick: the same choice of canvas as a play's, from the canvas the person is on; nothing while the agent is idle. */
  const liveTick = () => {
    const r = run();
    // it stops (the switch is off, the timeline replays, a play begins): what it took the canvas away from comes back — unless the person has taken it themselves
    if (!r) return void (home && (manual ? release() : void leave()));
    const cur = live!.current();
    if (!home) {
      if (!cur) return;
      home = shown = cur;
      listen(true);
      return;
    }
    if (busy) return;
    // the person went to another canvas themself (breadcrumb, a node's child, back): that is theirs, they are on their own view now
    if (cur && cur !== shown) {
      if (++mismatch < 2) return;
      mismatch = 0;
      home = shown = cur;
      homeView = null;
      setAway(false);
      return pause("select");
    }
    mismatch = 0;
    setAway(!manual && shown !== home);
    if (manual) return;
    if (!live!.awake()) {
      // nothing on the diagram to follow: about 3 s on, back to the canvas and the view it started from
      holdSince ??= now();
      if (goHomeDue({ holdFor: now() - holdSince, paused: manual, displaced: shown !== home || !!homeView })) {
        holdSince = null;
        if (shown !== home) {
          setAway(true);
          void go(home, true).then(() => void (homeView = null));
        } else returning = true;
      }
      return;
    }
    holdSince = null;
    returning = false;
    const t = clock.time();
    const want = cameraCanvas(home, (c) => {
      const ctx = ctxFor(c);
      if (!ctx) return { behind: false, into: null };
      const st = stateAt(r, t, ctx);
      return { behind: !st.present && st.portalPhase === "behind", into: st.portal?.canvasId ?? null };
    });
    if (want === shown) return;
    // away from the first moment of a switch (in or back home) until the tick after it is done: nothing of the move is kept
    setAway(true);
    void go(want);
  };

  async function leave() {
    leaving = true;
    while (busy) await wait(30);
    if (home && shown && shown !== home) await go(home, true);
    else if (home && homeView && !live) {
      const api = canvases.get(home)?.api;
      if (api) viewFor(home, true)(api);
    }
    // the history is what it was: this entry, with the address it had
    if (entry) history.replaceState(entry.state, "", entry.href);
    entry = null;
    listen(false);
    setAway(false);
    manual = chasing = false;
    hooks.setManual(false);
    home = shown = null;
    homeView = null;
    leaving = false;
  }

  return {
    shown: () => shown,
    stop: release,
    resume() {
      manual = false;
      chasing = true;
      hooks.setManual(false);
    },
    /** Once per animation frame: the follow camera moves the shown canvas toward the view it should have. */
    frame(dtMs) {
      if (!home || !shown || busy || manual || leaving) return;
      if (live) {
        if (!live.awake()) return void homeStep(dtMs);
        returning = false;
        holdSince = null;
        // the view the person had, kept once before the first move (a canvas the camera left is remembered by `go`)
        if (!homeView && shown === home) homeView = viewport.get(shown) ?? null;
      }
      const r = run();
      const w = getWindow();
      const api = canvases.get(shown)?.api;
      const v = viewport.get(shown);
      if (!r || !w || !api || !v || !v.width) return;
      const t = clock.time();
      const cur = { zoom: v.zoom, scrollX: v.scrollX, scrollY: v.scrollY };
      let target: { zoom: number; scrollX: number; scrollY: number } | null = null;
      if (overviewAt(w, t)) target = fitOf(api);
      else {
        const f = followOf(api, shown, r, t, cur);
        if (f && (f.move || chasing)) target = f.view;
      }
      if (now() - lastSample > 100) (lastSample = now(), zooms.length < 4000 && zooms.push([Date.now(), shown, +v.zoom.toFixed(3)]));
      // live: never to a place with no diagram in it (the tray, a canvas just switched to): the view stays
      if (target && live) {
        const els = api.getSceneElements().filter((e) => !e.isDeleted);
        if (els.length) {
          const x0 = Math.min(...els.map((e) => e.x)), y0 = Math.min(...els.map((e) => e.y));
          const bounds = { x: x0, y: y0, w: Math.max(...els.map((e) => e.x + e.width)) - x0, h: Math.max(...els.map((e) => e.y + e.height)) - y0 };
          if (!viewShowsContent(target, { w: v.width, h: v.height }, bounds)) target = null;
        }
      }
      if (!target) return void (chasing = false);
      const near = Math.abs(target.zoom - cur.zoom) < 0.004 && Math.abs(target.scrollX - cur.scrollX) * cur.zoom < 1.5 && Math.abs(target.scrollY - cur.scrollY) * cur.zoom < 1.5;
      if (near) return void (chasing = false);
      chasing = true;
      if (prefersReducedMotion()) return setView(api, target);
      const k = 1 - Math.exp(-Math.min(dtMs, 100) / CATCH_UP_MS);
      setView(api, { zoom: cur.zoom + (target.zoom - cur.zoom) * k, scrollX: cur.scrollX + (target.scrollX - cur.scrollX) * k, scrollY: cur.scrollY + (target.scrollY - cur.scrollY) * k });
    },
    tick() {
      if (leaving) return;
      if (live) return liveTick();
      const o = origin();
      if (!o || busy) return;
      measureBar();
      if (home !== o) {
        home = o;
        shown = o;
        homeView = viewport.get(o) ?? null;
        entry = { state: history.state, href: location.href };
        listen(true);
        // the canvas it starts on is fitted too (the bar and the toolbar cover its top)
        const api = canvases.get(o)?.api;
        if (api) viewFor(o, false)(api);
        return;
      }
      const r = run();
      const w = getWindow();
      let want = o;
      if (r && w) {
        const t = clock.time();
        if (t >= w.start) {
          want = cameraCanvas(o, (c) => {
            const ctx = ctxFor(c);
            if (!ctx) return { behind: false, into: null };
            const st = stateAt(r, t, ctx);
            return { behind: !st.present && st.portalPhase === "behind", into: st.portal?.canvasId ?? null };
          }, { summary: w.end != null && t >= w.end });
        }
      }
      if (want !== shown) void go(want);
    },
    exit: leave,
  };
}
