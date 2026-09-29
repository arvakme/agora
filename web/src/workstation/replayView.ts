// The camera driver of a played turn (web/docs/workstation.md §11 按轮追踪): while a turn plays the main view follows the
// figure — it goes into a sub-diagram when the figure goes in at a node's door, exactly as a click into the
// sub-diagram does (`nav.go`: the breadcrumb leads back), fits it to the pane, and returns to the parent
// when the figure comes out, and to the whole diagram for the summary. Leaving
// the play puts back the canvas and the view it was entered from. Each switch is a cross-fade of the old
// picture into the new one (a view transition, ~400 ms with the mount; never through a blank frame); with
// reduced motion, or where the browser has no view transitions, it is a cut. Imperative, no React: it outlives the canvases it switches.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { El } from "../canvas/scene";
import { canvasStep, isBehind, nextPaused, newCanvasMachine, type PauseEvent } from "./liveCamera";
import { cameraResume, cameraStart, cameraStep, inShot, switchView, ZOOM_MAX, ZOOM_MIN, type CameraGoal, type CameraState } from "./director";
import { firstView, viewport, type Viewport } from "../canvas/viewport";
import { nav, nested } from "../nested/store";
import { canvases } from "../session/ui";
import { clock, prefersReducedMotion } from "./clock";
import { buildGeometry } from "./geometry";
import { OUTSIDE, stateAt, type Ctx } from "./place";
import { cameraCanvas } from "./replayCamera";
import { occupiedOf, excalidrawEl } from "./replayDom";
import { fitView, type Box, type Fit } from "./replayFit";
import { followView, trayShotBox } from "./replayFollow";
import { figurePositions } from "./focus";
import { replacingPush } from "./replayHistory";
import { byCamera, userNav } from "./navOrigin";
import { scenePlaces } from "./scenePlaces";
import type { WorkRun } from "./runs/types";

const NODE_KIND = new Set(["rectangle", "ellipse", "diamond", "frame", "image", "embeddable"]);
/** Room over the top nodes for the figure standing there and its bubble (px), and the margin round the rest. */
const FIGURE_ROOM = 100;
const MARGIN = 28;
/** The follow shot (./replayFollow.ts): 100 % preferred, held to the camera's zoom range (./director.ts); screen px the figure needs round its feet (head and bubble above, the bubble to each side); the dead zone. How the view gets there is ./director.ts `cameraStep`. */
const ZOOM = { preferred: 1, min: ZOOM_MIN, max: ZOOM_MAX };
const ROOM = { up: 120, side: 170, down: 20 };
const DEAD = 0.18;
/** A look at the whole diagram this long after the replay's first beat starts (the clock begins 400 ms before it), and for the summary. */
const OVERVIEW_MS = 600;

const ctxs = new Map<string, { scenes: unknown; reduced: boolean; ctx: Ctx; boxOf: (place: string) => Box | undefined }>();
/** A canvas's own picture for the figure's state on it (as its overlay builds it), from the scene store: any canvas, open or not. */
export function ctxFor(id: string): Ctx | null {
  const st = nested.get();
  // a canvas with nothing in the store yet (an empty one the agent is about to draw on) still has its tray: the figure stands there, and is followed there
  const els = st.scenes.get(id) ?? [];
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
const sameView = (a: Fit, b: Fit) => Math.abs(a.zoom - b.zoom) < 0.004 && Math.abs(a.scrollX - b.scrollX) * a.zoom < 1.5 && Math.abs(a.scrollY - b.scrollY) * a.zoom < 1.5;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type CameraEvent = { at: number; t: number; from: string; to: string; title: string };
export type Camera = { tick: () => void; frame: (dtMs: number) => void; resume: () => void; exit: () => Promise<void>; /** Let go without putting anything back (the live camera). */ stop: () => void; shown: () => string | null };
/** The live camera (./liveCamera.ts, web/docs/workstation.md 默认跟随): follows an agent at work in everyday use, with no window to play. */
export type LiveHooks = {
  /** The canvas the person has in front of them (the main pane's). */
  current: () => string | null;
  /** The camera has a turn to follow (./liveCamera.ts `spellStep`): from the person's message to the turn's end, thinking and the tray included; only the turn's end sends it home. */
  working: () => boolean;
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
  /** Leaving (a play's exit is under way): nothing else moves the view meanwhile. */
  let leaving = false;
  /** Live: which canvas to show — go / home / the person's own doing (./liveCamera.ts `canvasStep`) — and whether the view is on its way back to `homeView`. */
  const machine = newCanvasMachine();
  let returning = false;
  /** Where the camera is (./director.ts `cameraStep`; made from the view the first frame it is needed, and again after a switch), and whether it is to take over from the view the person left (「继续」). */
  let cam: CameraState | null = null;
  let resync = false;
  /** A play's whole-diagram view (its first moment, its summary) that was put on the canvas: not put again while it is the view. */
  let overviewShown: Fit | null = null;
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
  const overviewAt = (w: { start: number; end: number | null }, t: number) => t < w.start + OVERVIEW_MS || (w.end != null && t >= w.end);
  /** A view put on the canvas as a cut: the picture cross-fades into it (a view transition; where there is none, or with reduced motion, it is simply there). */
  const cutTo = (api: ExcalidrawImperativeAPI, v: Fit) => {
    const vt = (document as Document & { startViewTransition?: (f: () => Promise<void>) => unknown }).startViewTransition;
    if (prefersReducedMotion() || !vt) return setView(api, v);
    vt.call(document, async () => {
      setView(api, v);
      await wait(60);
    });
  };
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
    const node = boxOfFor(id, st.at) ?? null;
    // at the tray (outside the drawing) the piece of the drawing nearest to it is framed with the figure: the shot keeps the diagram's context
    const els = st.at === OUTSIDE ? api.getSceneElements().filter((e) => !e.isDeleted) : [];
    const x0 = Math.min(...els.map((e) => e.x));
    const y0 = Math.min(...els.map((e) => e.y));
    const drawing: Box | null = els.length ? { x: x0, y: y0, w: Math.max(...els.map((e) => e.x + e.width)) - x0, h: Math.max(...els.map((e) => e.y + e.height)) - y0 } : null;
    const shot = st.at === OUTSIDE ? trayShotBox(figure, drawing, undefined, els.filter((e) => NODE_KIND.has(e.type)).map((e) => ({ x: e.x, y: e.y, w: e.width, h: e.height }))) : node && inShot(figure, node) ? node : null;
    return followView({ pane: { w: appState.width, h: appState.height }, occupied: occ, margin: MARGIN, figure, node: shot, room: ROOM, zoom: ZOOM, current, dead: DEAD });
  }
  /** The view a canvas gets when it is shown (./director.ts `switchView`): the one it was entered with (leaving), else the figure close up; a play's whole diagram; live, never the whole diagram. */
  const viewFor = (id: string, restore: boolean) => (api: ExcalidrawImperativeAPI) => {
    const r = run();
    const w = getWindow();
    const follow = !restore && r && w && !overviewAt(w, clock.time()) ? (followOf(api, id, r, clock.time(), null)?.view ?? null) : null;
    const st = api.getAppState();
    const v = switchView({ live: !!live, restore, home: id === home, homeView, follow, fit: fitOf(api), pane: { w: st.width, h: st.height } });
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
        replacingPush(() => byCamera(() => nav.go(from, to)));
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
      cam = null;
      overviewShown = null;
      busy = false;
    }
  }

  // the person's own pan or zoom of the canvas takes the camera from us until they hand it back. Live: only a real drag (not a click that
  // selects), a wheel, the zoom buttons, opening the comment dock or typing into the canvas's text editor; Esc alone is not.
  let press: { x: number; y: number } | null = null;
  /** How many navigations of the person's the camera has taken account of (./navOrigin.ts): a canvas change seen while there are more is theirs. */
  let navSeen = userNav.seq();
  const takeOver = (e: Event) => {
    const el = e.target as HTMLElement | null;
    if (live && e.type === "pointerdown" && el?.closest?.(".dock")) return pause("comment");
    if (live && e.type === "pointermove") {
      const pe = e as PointerEvent;
      if (press && Math.hypot(pe.clientX - press.x, pe.clientY - press.y) > 4) ((press = null), pause("pan"));
      return;
    }
    if (live && e.type === "pointerup") return void (press = null);
    if (!el?.closest?.(".excalidraw") || el.closest?.(".ws-play-bar, .ws-live-bar")) return;
    if (e.type === "wheel") return pause("zoom");
    if (el.closest(".zoom-actions")) return pause("zoom");
    if (el.tagName === "CANVAS") {
      if (live) press = { x: (e as PointerEvent).clientX, y: (e as PointerEvent).clientY };
      else pause("pan");
    }
  };
  // live: typing into an element of the canvas (its text editor) pauses it as well
  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (e.key !== "Escape" && typing && el?.closest?.(".excalidraw")) pause("edit");
  };
  const listen = (on: boolean) => {
    const evs = live ? (["pointerdown", "pointermove", "pointerup", "wheel"] as const) : (["pointerdown", "wheel"] as const);
    for (const ev of evs) on ? addEventListener(ev, takeOver, true) : removeEventListener(ev, takeOver, true);
    if (live) on ? addEventListener("keydown", onKey, true) : removeEventListener("keydown", onKey, true);
    if (!on) press = null;
    // the person navigated (a breadcrumb, back, a tab, a key: ./navOrigin.ts): the camera lets go at that moment, not when the change is seen
    offNav?.();
    offNav = live && on ? userNav.subscribe(() => home && pause("select")) : null;
  };
  let offNav: (() => void) | null = null;
  /** Live: the camera lets go (a play takes over, the switch is off, the timeline is replaying): nothing put back — the person's view is theirs. */
  const release = () => {
    listen(false);
    setAway(false);
    manual = false;
    hooks.setManual(false);
    home = shown = null;
    homeView = null;
    entry = null;
    Object.assign(machine, newCanvasMachine());
    returning = false;
    cam = null;
    overviewShown = null;
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
    const t = clock.time();
    const doorOf = (c: string) => {
      const ctx = ctxFor(c);
      if (!ctx) return { behind: false, into: null };
      const st = stateAt(r, t, ctx);
      return { behind: !st.present && st.portalPhase === "behind", into: st.portal?.canvasId ?? null };
    };
    const want = cameraCanvas(home, doorOf);
    // the figure went in at a door of the canvas shown, and is out of sight on it: nothing to wait for
    const door = doorOf(shown!);
    const behind = isBehind(shown!, want, door);
    // out of the door and on the canvas the path wants (it is coming out, or on the way to the next door): nothing to wait for either
    const wantDoor = want !== shown ? doorOf(want) : null;
    const arrived = !!wantDoor && !behind && (() => { const c = ctxFor(want); return !!c && stateAt(r, t, c).present; })();
    const act = canvasStep(machine, { now: Date.now(), working: live!.working(), want, shown: shown!, home, cur, busy, manual, displaced: shown !== home || !!homeView, behind, arrived, input: userNav.seq() !== navSeen });
    if (!cur || cur === shown) navSeen = userNav.seq(); // nothing pending: what was noted led nowhere the camera is not already at
    if (act.type === "canvas-moved" || act.type === "user-moved") navSeen = userNav.seq();
    if (act.type === "canvas-moved") {
      // the app put another canvas in front (an agent reading a sub-canvas opens it): not the person's doing — go on, on that one
      home = shown = act.to;
      homeView = null;
      cam = null;
      setAway(false);
      return;
    }
    if (act.type === "user-moved") {
      // the person went to another canvas themself (breadcrumb, a node's child, back): that is theirs; they are on their own view now
      home = shown = act.to;
      homeView = null;
      setAway(false);
      return pause("select");
    }
    if (act.type === "home") {
      // the turn is over (about 3 s ago): back to the canvas and the view it started from
      if (shown !== home) {
        setAway(true);
        void go(home, true).then(() => void (homeView = null));
      } else returning = true;
      return;
    }
    if (act.type === "go") {
      // away from the first moment of a switch until the tick after it is done: nothing of the move is kept
      setAway(true);
      void go(act.to);
      return;
    }
    if (!busy) setAway(!manual && shown !== home);
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
    manual = false;
    hooks.setManual(false);
    home = shown = null;
    homeView = null;
    cam = null;
    overviewShown = null;
    leaving = false;
  }

  return {
    shown: () => shown,
    stop: release,
    resume() {
      // live: the person's view now is the view to go home to
      if (live && home && shown === home) homeView = viewport.get(home) ?? null;
      manual = false;
      resync = true;
      overviewShown = null;
      hooks.setManual(false);
    },
    /** Once per animation frame: the camera (./director.ts `cameraStep`) moves the shown canvas toward the shot. */
    frame(dtMs) {
      if (!home || !shown || busy || leaving) return;
      const r = run();
      const w = getWindow();
      const api = canvases.get(shown)?.api;
      const v = viewport.get(shown);
      if (!r || !w || !api || !v || !v.width) return;
      const t = clock.time();
      const cur = { zoom: v.zoom, scrollX: v.scrollX, scrollY: v.scrollY };
      const pane = { w: v.width, h: v.height };
      // the person has the view: nothing here writes it — not the overview, not reduced motion, not the way home
      if (manual) return;
      if (now() - lastSample > 100) (lastSample = now(), zooms.length < 4000 && zooms.push([Date.now(), shown, +v.zoom.toFixed(3)]));
      // a play's first moment and its summary: the whole diagram, as a cut
      if (!live && overviewAt(w, t)) {
        const fit = fitOf(api);
        if (fit && (!overviewShown || !sameView(fit, overviewShown))) {
          overviewShown = fit;
          cutTo(api, fit);
          cam = null;
        }
        return;
      }
      overviewShown = null;
      let goal: CameraGoal = null;
      if (live) {
        if (live.working()) {
          returning = false;
          // the view the person had, kept once before the first move (a canvas the camera left is remembered by `go`)
          if (!homeView && shown === home) homeView = viewport.get(shown) ?? null;
          const f = followOf(api, shown, r, t, cur);
          goal = f && { view: f.view, move: f.move };
        } else if (returning && homeView) goal = { view: homeView, move: true, home: true };
      } else {
        const f = followOf(api, shown, r, t, cur);
        goal = f && { view: f.view, move: f.move };
      }
      if (prefersReducedMotion()) {
        // no travelling: the shot is simply there, and the way home too
        cam = null;
        if (goal?.move) setView(api, goal.view);
        if (live && returning) ((returning = false), (homeView = null));
        return;
      }
      if (!cam) cam = cameraStart(cur, pane);
      else if (resync) cam = cameraResume(cam, cur, pane);
      resync = false;
      const out = cameraStep(cam, goal, { dt: dtMs, now: now(), pane });
      const moved = out.state.at.x !== cam.at.x || out.state.at.y !== cam.at.y || out.state.at.zoom !== cam.at.zoom;
      cam = out.state;
      if (out.cut) cutTo(api, out.view);
      else if (moved) setView(api, out.view);
      // arrived home
      if (live && returning && out.mode === "hold") ((returning = false), (homeView = null));
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
