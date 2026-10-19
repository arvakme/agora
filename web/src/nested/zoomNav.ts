// Going into a sub-diagram and back out as one zoom (docs/nested-canvas.md §2 缩放进出): the flights of a click (the entry mark, ⇧↵,
// 「进入子图」, the breadcrumb, ⌘↑) and the switches of a person's own zoom (./ZoomLayer.tsx sees the gesture). Each switch puts the
// canvas it goes to exactly where the one it leaves showed it (./zoom.ts: the thumbnail in the node ↔ the sub-diagram), so the
// picture does not move: the shell's `go` (app/App.tsx) does the rest as before — saves the canvas left, swaps the tab, pushes the
// history entry. Reduced motion, a turn playing, a canvas already open in another group, an empty sub-diagram: the plain switch.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { hashElementsVersion } from "@excalidraw/excalidraw";
import { flushSync } from "react-dom";
import { pictureBounds, sceneSvg } from "../buildreplay/scenePicture";
import type { Box } from "../canvas/clearance";
import { nodeBox } from "../canvas/nodes";
import { byId, live, type El } from "../canvas/scene";
import { viewport } from "../canvas/viewport";
import { theme } from "../app/theme";
import { canvases } from "../session/ui";
import { prefersReducedMotion } from "../workstation/clock";
import { frame } from "../workstation/frame";
import { plays } from "../workstation/replayMode";
import { ancestry, childOf } from "./graph";
import { nested } from "./store";
import { camOf, childSim, clampSim, easeInOut, fillOf, fitCam, flightMs, flyAt, nestOf, parentSim, simOf, VEIL_FROM, type Cam, type Nest, type Pt, type Sim } from "./zoom";

/** The shell's switch (App.tsx `go`): `arrive` is where the canvas gone to is to show its scene on the page. False: it could not be done in place (the canvas is open in another group). */
export type ZoomShell = { go: (from: string, to: string, history: "push" | "replace", arrive?: Sim) => boolean };
let shell: ZoomShell | null = null;
export const installZoomShell = (s: ZoomShell) => void (shell = s);

/** The person's zoom gesture (a wheel with ⌘/Ctrl, a trackpad pinch): kept here, not in a canvas, because it goes on across a switch. */
export const gesture = { t: -Infinity, dir: 0 as 1 | -1 | 0, canvas: "", x: 0, y: 0 };
export const noteZoomGesture = (canvas: string, dir: 1 | -1, x: number, y: number) => void Object.assign(gesture, { t: performance.now(), dir, canvas, x, y });
let lastSwitch = -Infinity;
export const sinceSwitch = (now = performance.now()) => now - lastSwitch;

/**
 * A canvas being switched to, until it shows what it was given: `sim` is its scene on the page. In a sub-diagram (`self`), its own
 * picture stands in until Excalidraw has drawn the view; in a parent, the node (`node`) shows the sub-diagram (`child`) with the
 * rest veiled, and `out` is the flight that then takes the view back out.
 */
export type Arrival = { sim: Sim; self?: boolean; node?: string; child?: string; out?: { dest: Cam | null; ms: number }; /** the canvas has the view */ matched?: boolean; settled?: boolean };
const arrivals = new Map<string, Arrival>();
export const arrivalOf = (canvasId: string) => arrivals.get(canvasId);
/** A flight on a canvas: which node and sub-diagram, which way, how far (eased, 0..1). */
export type Flight = { canvas: string; node: string; child: string; dir: "in" | "out"; u: number };
let flight: Flight | null = null;
export const flightOn = (canvasId: string) => (flight?.canvas === canvasId ? flight : null);
const settledLs = new Map<string, () => void>();
/** A canvas's zoom layer sleeps while there is nothing to show (./ZoomLayer.tsx): a flight on it wakes it. */
const wakeLs = new Map<string, () => void>();
export const onZoomWake = (canvasId: string, f: () => void) => {
  wakeLs.set(canvasId, f);
  return () => void (wakeLs.get(canvasId) === f && wakeLs.delete(canvasId));
};

/** Where a canvas was before it was zoomed into a node: the way back out lands there. */
const before = new Map<string, Cam>();
export const rememberBefore = (canvasId: string, c: Cam) => void before.set(canvasId, c);
/** The node a sub-diagram was entered through (two nodes can open the same one). */
const through = new Map<string, { parent: string; node: string }>();

const liveOf = (canvasId: string) => (nested.get().scenes.get(canvasId) ?? []).filter((e) => live(e)) as El[];
/** A sub-diagram's drawing: its extent, and the key and version its picture is cached under (the thumbnail and the stand-in are one picture). */
export function contentOf(canvasId: string): { els: El[]; box: Box; version: number } | null {
  const els = liveOf(canvasId);
  return els.length ? { els, box: pictureBounds(els), version: hashElementsVersion(els) } : null;
}
export const pictureKey = (canvasId: string) => `zoom:${canvasId}`;
export const pictureOf = (canvasId: string, dark: boolean) => {
  const c = contentOf(canvasId);
  return c ? sceneSvg(pictureKey(canvasId), c.els, c.version, dark) : Promise.resolve(null);
};
const isDark = () => theme.get().resolved === "dark";

/** The node on `parent` that opens `child` (the one it was entered through, else the first), its box and the nesting. */
export function nestFor(parent: string, child: string, nodeId?: string): { node: El; box: Box; m: Nest } | null {
  const els = nested.get().scenes.get(parent) ?? [];
  const want = nodeId ?? (through.get(child)?.parent === parent ? through.get(child)!.node : undefined);
  const node = els.find((e) => live(e) && e.id === want && childOf(e) === child) ?? els.find((e) => live(e) && childOf(e) === child);
  const content = contentOf(child);
  if (!node || !content) return null;
  const box = nodeBox(node, byId(els), els);
  return { node, box, m: nestOf(box, content.box) };
}

const originOf = (api: ExcalidrawImperativeAPI): Pt => {
  const a = api.getAppState();
  return { x: a.offsetLeft, y: a.offsetTop };
};
const camNow = (api: ExcalidrawImperativeAPI): Cam => {
  const a = api.getAppState();
  return { scrollX: a.scrollX, scrollY: a.scrollY, zoom: a.zoom.value };
};
const setCam = (api: ExcalidrawImperativeAPI, c: Cam) => api.updateScene({ appState: { scrollX: c.scrollX, scrollY: c.scrollY, zoom: { value: c.zoom } } as never });
/** Put the canvas where `sim` shows its scene (its own pane's place on the page decides the scroll). */
export const applySim = (api: ExcalidrawImperativeAPI, sim: Sim) => setCam(api, camOf(sim, originOf(api)));

/** The breadcrumb strip a sub-diagram has over it and a top-level canvas does not: the pane below it starts lower. */
const crumbHeight = () => document.querySelector<HTMLElement>(".nest-crumbs")?.offsetHeight || 45;

const blockedNow = () => !!plays.get().play || prefersReducedMotion();

function switchTo(from: string, to: string, sim: Sim, a: Omit<Arrival, "sim">, history: "push" | "replace"): boolean {
  arrivals.set(to, { ...a, sim });
  lastSwitch = performance.now();
  if (gesture.canvas === from) gesture.canvas = to; // the gesture goes on there
  const ok = shell?.go(from, to, history, sim) ?? false;
  if (!ok) arrivals.delete(to);
  else watchArrival(to);
  return ok;
}

/** The canvas gone to has the view it was given, and Excalidraw has drawn it (a few frames on): the stand-ins go. */
function watchArrival(id: string) {
  let since = 0;
  let frames = 0;
  let told = false;
  const off = frame.add(() => {
    const a = arrivals.get(id);
    if (!a) return off();
    const api = canvases.get(id)?.api;
    const v = viewport.get(id);
    frames++;
    // a new editor zooms about the last pointer position it heard of (document pointermove), (0, 0) until the pointer moves: a pinch that
    // goes on without moving would zoom about the corner. Tell it where the pointer is.
    if (api && !told && gesture.canvas === id && performance.now() - gesture.t < 1000) {
      told = true;
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: gesture.x, clientY: gesture.y, bubbles: true }));
    }
    if (api && v && v.width > 0 && !a.matched) {
      const want = camOf(a.sim, originOf(api));
      const same = Math.abs(v.zoom - want.zoom) < 1e-3 * want.zoom && Math.abs(v.scrollX - want.scrollX) * v.zoom < 0.75 && Math.abs(v.scrollY - want.scrollY) * v.zoom < 0.75;
      if (same) a.matched = true;
      else if (frames % 4 === 0) applySim(api, a.sim); // the canvas was mounted already, or fitted itself after all
    }
    // from then on the person's gesture is theirs again (it may move the view at once): a few frames for Excalidraw to draw.
    // ~1 s at most: whatever happened, the canvas is shown as it is
    if (a.matched) since++;
    if (since >= 3 || frames > 60) {
      off();
      a.settled = true;
      settledLs.get(id)?.();
      settledLs.delete(id);
      if (!a.out) arrivals.delete(id);
    }
  });
}
const settledOn = (id: string) => new Promise<void>((ok) => (arrivals.get(id)?.settled ? ok() : settledLs.set(id, ok)));

/** Ease `api`'s view from where it is to `to`; resolves true when it got there, false when the person took over (a press, a wheel, a key). */
function fly(canvas: string, api: ExcalidrawImperativeAPI, to: Sim, ms: number, f: Omit<Flight, "u" | "canvas"> | null, keep = false): Promise<boolean> {
  const o = originOf(api);
  const from = simOf(camNow(api), o);
  const t0 = performance.now();
  return new Promise((done) => {
    let stop = false;
    const cancel = (e: Event) => {
      if (e.type === "keydown" && ["Shift", "Meta", "Control", "Alt"].includes((e as KeyboardEvent).key)) return;
      stop = true;
    };
    const evs = ["pointerdown", "wheel", "keydown"] as const;
    evs.forEach((n) => addEventListener(n, cancel, { capture: true, passive: true }));
    if (f) (flight = { ...f, canvas, u: 0 }), wakeLs.get(canvas)?.();
    const end = (ok: boolean) => {
      off();
      evs.forEach((n) => removeEventListener(n, cancel, { capture: true }));
      // `keep`: the flight's look stays (the veil closed) until the caller has switched
      if (flight?.canvas === canvas && !(keep && ok)) flight = null;
      done(ok);
    };
    // a lead job: the view is written (flushSync) before the overlays are drawn in this frame, so the thumbnail sits on its node
    const off = frame.lead(() => {
      const now = performance.now();
      if (stop || canvases.get(canvas)?.api !== api) return end(false);
      const u = easeInOut(Math.min(1, (now - t0) / ms));
      if (flight?.canvas === canvas) flight.u = u;
      flushSync(() => setCam(api, camOf(flyAt(from, to, u), o)));
      if (u >= 1) end(true);
    });
  });
}

/** Wait for a promise, but not longer than `ms`. */
const atMost = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((ok) => setTimeout(() => ok(undefined), ms))]);

/** The person zoomed into the node this far (./ZoomLayer.tsx): switch to its sub-diagram where the thumbnail is. */
export function enterByZoom(from: string, to: string, nodeId: string): boolean {
  const api = canvases.get(from)?.api;
  const n = nestFor(from, to, nodeId);
  if (!api || !n || flight || isOpenElsewhere(to)) return false;
  const sim = childSim(simOf(camNow(api), originOf(api)), n.m);
  if (!switchTo(from, to, clampSim(sim, centreOf(api)), { self: true }, "push")) return false;
  through.set(to, { parent: from, node: n.node.id });
  return true;
}

/** The person zoomed out of a sub-diagram this far: switch to its parent with the node showing it where it is. */
export function leaveByZoom(from: string, to: string): boolean {
  const api = canvases.get(from)?.api;
  const n = nestFor(to, from);
  if (!api || !n || flight || isOpenElsewhere(to)) return false;
  const sim = parentSim(simOf(camNow(api), originOf(api)), n.m);
  return switchTo(from, to, clampSim(sim, centreOf(api)), { node: n.node.id, child: from }, "push");
}

const centreOf = (api: ExcalidrawImperativeAPI): Pt => {
  const a = api.getAppState();
  return { x: a.offsetLeft + a.width / 2, y: a.offsetTop + a.height / 2 };
};

/**
 * A click into a sub-diagram: the view flies to the node (it grows where it is, its sub-diagram fades in over it and the rest of the
 * canvas fades out), then the sub-diagram takes over, fitted to the pane as entering always did.
 */
export async function flyInto(from: string, to: string, nodeId?: string): Promise<void> {
  const api = canvases.get(from)?.api;
  const n = nestFor(from, to, nodeId);
  const content = contentOf(to);
  if (!api || !n || !content || blockedNow() || flight || isOpenElsewhere(to)) return void shell?.go(from, to, "push");
  const a = api.getAppState();
  const o = originOf(api);
  // the sub-diagram's pane: the same, under a breadcrumb strip when this canvas has none
  const dh = nested.get().index.has(from) ? 0 : crumbHeight();
  const fit = fitCam(content.box, { w: a.width, h: a.height - dh });
  const dest = clampSim(parentSim(simOf(fit, { x: o.x, y: o.y + dh }), n.m), centreOf(api));
  rememberBefore(from, camNow(api));
  const picture = pictureOf(to, isDark());
  const ok = await fly(from, api, dest, flightMs(simOf(camNow(api), o), dest), { node: n.node.id, child: to, dir: "in" }, true);
  if (!ok) return; // the person took over: they are where the flight left them (./ZoomLayer.tsx carries on by the zoom)
  try {
    await atMost(picture, 300);
    if (canvases.get(from)?.api !== api) return;
    const sim = childSim(simOf(camNow(api), o), n.m);
    if (switchTo(from, to, clampSim(sim, centreOf(api)), { self: true }, "push")) through.set(to, { parent: from, node: n.node.id });
  } finally {
    if (flightOn(from)) flight = null;
  }
}

/** A click up the tree (⌘↑, the back pill, a breadcrumb): out of each level in turn, the sub-diagram shrinking back into its node. */
export async function flyUp(from: string, to: string): Promise<void> {
  const chain = ancestry(from, nested.get().index);
  const at = chain.indexOf(to);
  if (at < 0 || at >= chain.length - 1 || blockedNow() || flight || isOpenElsewhere(to)) return void shell?.go(from, to, "push");
  const steps = chain.slice(at).reverse(); // from, …, to
  for (let i = 0; i + 1 < steps.length; i++) {
    const last = i + 2 === steps.length;
    const ok = await upOne(steps[i], steps[i + 1], i === 0 ? "push" : "replace", last);
    if (!ok) return;
  }
}

/** One level up. False: it stopped (a plain switch was made instead, or the person took over). */
async function upOne(child: string, parent: string, history: "push" | "replace", last: boolean): Promise<boolean> {
  const api = canvases.get(child)?.api;
  const n = nestFor(parent, child);
  const content = contentOf(child);
  if (!api || !n || !content) return void shell?.go(child, parent, history), false;
  const a = api.getAppState();
  const o = originOf(api);
  // first the whole sub-diagram in view, if it is not (a short ease)
  const fitSim = simOf(fitCam(content.box, { w: a.width, h: a.height }), o);
  const now = simOf(camNow(api), o);
  const far = Math.abs(Math.log(now.k / fitSim.k)) > 0.15 || Math.hypot(now.x - fitSim.x, now.y - fitSim.y) > 40;
  await atMost(pictureOf(child, isDark()), 300);
  if (far && !(await fly(child, api, fitSim, 240, null))) return false;
  if (canvases.get(child)?.api !== api) return false;
  const sim = clampSim(parentSim(simOf(camNow(api), o), n.m), centreOf(api));
  const back = last ? (before.get(parent) ?? null) : null;
  if (!switchTo(child, parent, sim, { node: n.node.id, child, out: { dest: back, ms: last ? 560 : 340 } }, history)) return false;
  await settledOn(parent);
  const papi = canvases.get(parent)?.api;
  const arr = arrivals.get(parent);
  arrivals.delete(parent);
  if (!papi || !arr) return false;
  // out to where the parent was before it was zoomed into (if the node is small there), else the whole parent
  const pa = papi.getAppState();
  const pane = { w: pa.width, h: pa.height };
  const keep = back && fillOf(n.box, back.zoom, pane) < VEIL_FROM ? back : null;
  const pc = contentOf(parent);
  const destCam = keep ?? (pc ? fitCam(pc.box, pane) : camNow(papi));
  const dest = simOf(destCam, originOf(papi));
  return fly(parent, papi, dest, arr.out!.ms, { node: n.node.id, child, dir: "out" });
}

const isOpenElsewhere = (to: string) => !!canvases.get(to);
