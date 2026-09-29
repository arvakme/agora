// PR 回放's camera driver (web/docs/workstation.md「PR 回放」): while a PR plays the main view follows the
// figure — it goes into a sub-diagram when the figure goes in at a node's door, exactly as a click into the
// sub-diagram does (`nav.go`: the breadcrumb leads back), fits it to the pane, and returns to the parent
// when the figure comes out, and to the whole diagram for the summary and before each PR of a 连播. Leaving
// the replay puts back the canvas and the view it was entered from. A short fade covers each switch
// (~400 ms in all); with reduced motion it is a cut. Imperative, no React: it outlives the canvases it switches.
import type { El } from "../canvas/scene";
import { viewport, type Viewport } from "../canvas/viewport";
import { nav, nested } from "../nested/store";
import { canvases } from "../session/ui";
import { clock, prefersReducedMotion } from "./clock";
import { buildGeometry } from "./geometry";
import { stateAt, type Ctx } from "./place";
import { cameraCanvas } from "./replayCamera";
import { replacingPush, withoutReplayParam } from "./replayHistory";
import { scenePlaces } from "./scenePlaces";
import type { WorkRun } from "./runs/types";

const FADE_OUT_MS = 150;
const FADE_IN_MS = 200;

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

let curtain: HTMLElement | null = null;
/** A veil over the canvas pane: opacity `to` over `ms` (resolves when done). */
function veil(to: 0 | 1, ms: number): Promise<void> {
  if (!curtain) {
    curtain = document.createElement("div");
    curtain.className = "ws-pr-curtain";
    curtain.style.opacity = "0";
    document.body.appendChild(curtain);
  }
  const pane = document.querySelector<HTMLElement>('[data-pane]:not([data-hidden="true"]) .canvas-view') ?? document.querySelector<HTMLElement>(".canvas-view");
  const r = pane?.getBoundingClientRect();
  if (r) Object.assign(curtain.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const el = curtain;
  if (!ms || prefersReducedMotion() || !el.animate) {
    el.style.opacity = String(to);
    return Promise.resolve();
  }
  const a = el.animate([{ opacity: to ? 0 : 1 }, { opacity: to }], { duration: ms, fill: "forwards", easing: "ease-in-out" });
  return a.finished.then(() => void (el.style.opacity = String(to)), () => {});
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
  /** The address and history state the replay was entered with: put back on leaving (minus ?replay=). */
  let entry: { state: unknown; href: string } | null = null;
  const log: CameraEvent[] = [];
  if (typeof window !== "undefined") Object.assign(window, { __wsCamera: log });

  /** The canvas's pane, once the switch has mounted it: fit a sub-diagram to it, put the entry view back on the canvas we came from. */
  async function arrive(id: string) {
    for (let i = 0; i < 40 && !(canvases.get(id) && (viewport.get(id)?.width ?? 0) > 0); i++) await wait(40);
    const api = canvases.get(id)?.api;
    if (!api) return;
    if (id === home && homeView) api.updateScene({ appState: { scrollX: homeView.scrollX, scrollY: homeView.scrollY, zoom: { value: homeView.zoom } } as never });
    else api.scrollToContent(api.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.9, animate: false });
    await wait(60);
  }

  async function go(to: string) {
    const from = shown!;
    busy = true;
    try {
      await veil(1, FADE_OUT_MS);
      // the app's navigation pushes a history entry: during a replay it replaces the current one
      replacingPush(() => nav.go(from, to));
      shown = to;
      log.push({ at: Date.now(), t: clock.time(), from, to, title: nested.get().titles[to] ?? "" });
      await arrive(to);
      await veil(0, FADE_IN_MS);
    } finally {
      busy = false;
    }
  }

  return {
    shown: () => shown,
    tick() {
      const o = origin();
      if (!o || busy) return;
      if (home !== o) {
        home = o;
        shown = o;
        homeView = viewport.get(o) ?? null;
        entry = { state: history.state, href: location.href };
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
      if (home && shown && shown !== home) await go(home);
      else if (home && homeView) await arrive(home);
      // the history is what it was: this entry, with the address it had (the replay's own ?replay= left out)
      if (entry) history.replaceState(entry.state, "", withoutReplayParam(entry.href));
      entry = null;
      home = shown = null;
      homeView = null;
    },
  };
}
