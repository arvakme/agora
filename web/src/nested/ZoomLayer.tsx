// Semantic zoom on a canvas (docs/nested-canvas.md §2 缩放进出). Over Excalidraw's static canvas (its picture) and under everything
// else (the interactive canvas with selection and the text editor, the panels, our marks), this layer draws, while a node with a
// sub-diagram is zoomed into: the sub-diagram's picture inside the node (Excalidraw's SVG export, ../buildreplay/scenePicture.ts),
// fading in as the node grows, and a veil the colour of the canvas over the rest of it, closing as the node comes to fill the pane.
// Zoomed far enough the sub-diagram takes over where its picture was (./zoomNav.ts); zoomed out of a sub-diagram far enough, its
// parent takes over with the node showing it. While a canvas just switched to has not drawn its view yet, this layer shows it (the
// same picture), so the switch never passes through a blank frame. Updated by the frame loop, not by React (../workstation/frame.ts).
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../app/theme";
import { sceneSvg, sceneSvgNow, type SceneSvg } from "../buildreplay/scenePicture";
import type { Box } from "../canvas/clearance";
import { nodeBox } from "../canvas/nodes";
import { byId, live, type El } from "../canvas/scene";
import { viewport, type Viewport } from "../canvas/viewport";
import { frame } from "../workstation/frame";
import { plays } from "../workstation/replayMode";
import { childOf } from "./graph";
import { useNested } from "./store";
import { fillOf, IDLE_MS, innerBox, nestBox, nestOf, onPage, parentSim, simOf, THUMB_FROM, thumbAlpha, veilAlpha, ZOOM_MIN, zoomStep, type Nest, type Sim } from "./zoom";
import { arrivalOf, contentOf, enterByZoom, flightOn, gesture, leaveByZoom, nestFor, noteZoomGesture, onZoomWake, pictureKey, rememberBefore, sinceSwitch } from "./zoomNav";
import "./zoom.css";

/** A node that opens a sub-diagram, on this canvas. */
type Door = { node: string; child: string; box: Box; color: string };
/** How fast the veil and the thumbnail follow their goal when a gesture starts or stops (ms, exponential). */
const EASE_MS = 140;
const smoothTo = (v: number, goal: number, dt: number) => goal + (v - goal) * Math.exp(-dt / EASE_MS);

/** Overflow of the "flight" ramps: a click's flight closes the veil and opens the thumbnail by its progress, whatever the zoom. */
const flightAlpha = (dir: "in" | "out", u: number) => {
  const s = (a: number, b: number) => Math.max(0, Math.min(1, (u - a) / (b - a)));
  return dir === "in" ? { thumb: s(0, 0.45), veil: s(0.35, 0.85) } : { thumb: 1 - s(0.35, 0.9), veil: 1 - s(0.1, 0.6) };
};

function blocked(api: ExcalidrawImperativeAPI | null, pressed: boolean): boolean {
  if (!api || pressed || plays.get().play) return true;
  const a = api.getAppState();
  return !!(a.editingTextElement || a.newElement || a.selectedElementsAreBeingDragged || a.isResizing || a.isRotating || a.multiElement);
}

const viewOf = (api: ExcalidrawImperativeAPI | null): Viewport | undefined => {
  if (!api) return undefined;
  const a = api.getAppState();
  return a.width > 0 ? { scrollX: a.scrollX, scrollY: a.scrollY, zoom: a.zoom.value, width: a.width, height: a.height } : undefined;
};

export function ZoomLayer({ api, canvasId }: { api: ExcalidrawImperativeAPI | null; canvasId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const patch = useRef<HTMLDivElement>(null);
  const pic = useRef<HTMLDivElement>(null);
  const dark = useTheme().resolved === "dark";
  const st = useNested();
  const els = st.scenes.get(canvasId);
  // this canvas's doors (nodes that open a sub-diagram that exists)
  const doors = useMemo(() => {
    const all = (els ?? []) as readonly El[];
    const map = byId(all);
    const out = new Map<string, Door>();
    for (const e of all) {
      const c = live(e) ? childOf(e) : null;
      if (!c || c === canvasId || !st.scenes.has(c)) continue;
      out.set(e.id, { node: e.id, child: c, box: nodeBox(e, map, all), color: e.backgroundColor });
    }
    return out;
  }, [els, st.scenes, canvasId]);
  // on a sub-diagram: the node it is in, on the parent, and how it sits there (for zooming back out)
  const parent = st.index.get(canvasId);
  const up = useMemo(() => (parent ? nestFor(parent.canvasId, canvasId) : null), [parent?.canvasId, st.scenes, canvasId]);

  // the picture the layer shows: a sub-diagram's, in its node; or (just switched to a sub-diagram) the canvas's own
  const [shown, setShown] = useState<{ child: string; svg: SceneSvg | null; html: string } | null>(() => {
    const a = arrivalOf(canvasId);
    const who = a?.self ? canvasId : a?.child;
    const c = who && contentOf(who);
    const svg = c ? sceneSvgNow(pictureKey(who!), c.version, dark) : undefined;
    return who && svg ? { child: who, svg, html: svg.html } : null;
  });
  const want = useRef<string | null>(null);
  const load = (child: string) => {
    if (want.current === child && shown?.child === child) return;
    want.current = child;
    const c = contentOf(child);
    if (!c) return setShown(null);
    void sceneSvg(pictureKey(child), c.els, c.version, dark).then((svg) => want.current === child && setShown({ child, svg, html: svg?.html ?? "" }));
  };

  const s = useRef({ armed: null as Door | null, arm: 0, gate: 0, last: performance.now(), pressed: false, arrived: 0 });
  // the person's zoom: ⌘/Ctrl + wheel (a trackpad pinch is one too), Safari's pinch; zooming in over a door arms it
  useEffect(() => {
    const el = root.current?.parentElement;
    if (!el) return;
    const at = (x: number, y: number) => {
      const v = viewport.get(canvasId);
      if (!v || !api) return null;
      const a = api.getAppState();
      const p = { x: (x - a.offsetLeft) / v.zoom - v.scrollX, y: (y - a.offsetTop) / v.zoom - v.scrollY };
      let best: Door | null = null;
      for (const d of doors.values()) if (p.x >= d.box.x && p.x <= d.box.x + d.box.w && p.y >= d.box.y && p.y <= d.box.y + d.box.h && (!best || d.box.w * d.box.h < best.box.w * best.box.h)) best = d;
      return best;
    };
    const zoomed = (dir: 1 | -1, x: number, y: number) => {
      noteZoomGesture(canvasId, dir, x, y);
      wake();
      if (dir < 0 || s.current.armed || !api) return;
      const d = at(x, y);
      if (!d) return;
      const v = viewport.get(canvasId)!;
      if (fillOf(d.box, v.zoom, { w: v.width, h: v.height }) < THUMB_FROM) rememberBefore(canvasId, { scrollX: v.scrollX, scrollY: v.scrollY, zoom: v.zoom });
      s.current.armed = d;
      load(d.child);
    };
    const wheel = (e: WheelEvent) => (e.ctrlKey || e.metaKey) && e.deltaY !== 0 && zoomed(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY);
    let scale = 1;
    const gest = (e: Event) => {
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      if (e.type === "gesturestart") scale = 1;
      else if (g.scale && g.scale !== scale) zoomed(g.scale > scale ? 1 : -1, g.clientX ?? 0, g.clientY ?? 0), (scale = g.scale);
    };
    const down = (e: PointerEvent) => {
      s.current.pressed = true;
      // working on this level: the node shows itself again
      if ((e.target as Element | null)?.closest?.(".excalidraw")) s.current.armed = null;
    };
    const upp = () => void (s.current.pressed = false);
    el.addEventListener("wheel", wheel, { capture: true, passive: true });
    el.addEventListener("gesturestart", gest, { capture: true, passive: true });
    el.addEventListener("gesturechange", gest, { capture: true, passive: true });
    el.addEventListener("pointerdown", down, { capture: true, passive: true });
    addEventListener("pointerup", upp, { capture: true, passive: true });
    addEventListener("pointercancel", upp, { capture: true, passive: true });
    return () => {
      el.removeEventListener("wheel", wheel, { capture: true });
      el.removeEventListener("gesturestart", gest, { capture: true });
      el.removeEventListener("gesturechange", gest, { capture: true });
      el.removeEventListener("pointerdown", down, { capture: true });
      removeEventListener("pointerup", upp, { capture: true });
      removeEventListener("pointercancel", upp, { capture: true });
    };
  }, [api, canvasId, doors]);

  // a flight or an arrival names its door: show that sub-diagram
  useEffect(() => {
    const a = arrivalOf(canvasId);
    if (a?.self) load(canvasId);
    else if (a?.child) load(a.child);
  }, [canvasId]);

  useEffect(() => {
    // on the performance clock (the frame loop passes wall time; the gesture and the switches are on this one)
    const step = () => {
      const now = performance.now();
      const el = root.current;
      const host = el?.parentElement;
      if (!el || !host) return;
      const k = s.current;
      const dt = Math.max(0, Math.min(100, now - k.last));
      k.last = now;
      const r = host.getBoundingClientRect();
      const origin = { x: r.left, y: r.top };
      const pane = { w: r.width, h: r.height };
      const arr = arrivalOf(canvasId);
      const pending = !!arr && !arr.settled;
      // a click's way out: the node shows its sub-diagram, the rest veiled, until the flight out begins
      const hold = pending || !!arr?.out;
      // the editor's own view: the viewport store keeps a canvas's last view after it unmounts, so a canvas mounted again would read
      // where it was last time until its first change
      const v = viewOf(api) ?? viewport.get(canvasId);
      // until the canvas has the view it was given, the stand-in is where that view puts it; then where the canvas is
      const sim: Sim | null = pending && !arr.matched ? arr.sim : v ? simOf(v, origin) : null;
      const fl = flightOn(canvasId);
      if (fl) {
        const d = doors.get(fl.node);
        if (d && k.armed?.node !== d.node) (k.armed = d), load(d.child);
      } else if (arr?.node && k.armed?.node !== arr.node) {
        const d = doors.get(arr.node);
        if (d) (k.armed = d), load(d.child), (k.gate = 1), (k.arm = 1);
      }
      const mine = gesture.canvas === canvasId;
      const idle = !mine || now - gesture.t > IDLE_MS;
      const dir = mine ? gesture.dir : 0;
      let thumb = 0;
      let veilA = 0;
      let place: { box: Box; m: Nest; door: Door } | null = null;
      if (sim && k.armed && !arr?.self) {
        const d = doors.get(k.armed.node) ?? null;
        const c = d && contentOf(d.child);
        if (d && c) {
          const fill = fillOf(d.box, sim.k, pane);
          place = { box: d.box, m: nestOf(d.box, c.box), door: d };
          // the gesture over: the veil opens again (a flight keeps it)
          k.gate = smoothTo(k.gate, !idle || fl || hold ? 1 : 0, dt);
          k.arm = smoothTo(k.arm, 1, dt);
          thumb = thumbAlpha(fill) * k.arm;
          veilA = veilAlpha(fill) * k.gate;
          if (fl) {
            const f = flightAlpha(fl.dir, fl.u);
            thumb = Math.max(thumb, f.thumb);
            veilA = Math.max(veilA, f.veil);
          }
          if (hold) (thumb = 1), (veilA = 1);
          // zoomed through: into the sub-diagram
          if (!fl && !arr && zoomStep({ side: "parent", fill, dir, since: sinceSwitch(now), idle, blocked: blocked(api, k.pressed) }) === "enter") enterByZoom(canvasId, d.child, d.node);
          else if (!fl && !hold && fill < THUMB_FROM * 0.8) k.armed = null;
        } else k.armed = null;
      } else if (k.armed === null) k.arm = k.gate = 0;
      // a sub-diagram just switched to: its own picture until Excalidraw has drawn it
      if (arr?.self) {
        const settled = !pending;
        k.arrived = settled ? smoothTo(k.arrived, 0, dt * 3) : 1;
        if (settled && k.arrived < 0.02) k.arrived = 0;
        veilA = pending ? 1 : 0;
      }
      // zoomed out of a sub-diagram this far: into its parent
      if (!pending && !fl && up && parent && v && api) {
        const ps = parentSim(simOf(v, origin), up.m);
        const fill = fillOf(up.box, ps.k, pane);
        if (zoomStep({ side: "child", fill, dir, since: sinceSwitch(now), idle, blocked: blocked(api, k.pressed), atMin: v.zoom <= ZOOM_MIN * 1.02 }) === "leave") leaveByZoom(canvasId, parent.canvasId);
      }

      const showPic = arr?.self ? (pending || k.arrived > 0) : thumb > 0.001;
      el.hidden = !(showPic || veilA > 0.001);
      host.style.setProperty("--sz-veil", (arr?.self ? (pending ? 1 : k.arrived) : veilA).toFixed(3));
      if (el.hidden || !sim) return;
      if (veil.current) veil.current.style.opacity = veilA.toFixed(3);
      if (patch.current) {
        if (place && !arr?.self) {
          const b = onPage(sim, innerBox(place.box));
          Object.assign(patch.current.style, { display: "", opacity: thumb.toFixed(3), transform: `translate(${(b.x - origin.x).toFixed(2)}px,${(b.y - origin.y).toFixed(2)}px)`, width: `${b.w}px`, height: `${b.h}px`, background: place.door.color && place.door.color !== "transparent" ? place.door.color : (api?.getAppState().viewBackgroundColor ?? "") });
        } else patch.current.style.display = "none";
      }
      const p = pic.current;
      const svg = shown?.svg;
      if (p && svg && (arr?.self ? shown.child === canvasId : place && shown.child === place.door.child)) {
        // the picture's own box: in the canvas it belongs to (self), or placed in the node
        const b = arr?.self ? onPage(sim, svg) : onPage(sim, nestBox(place!.m, svg));
        const sc = b.w / svg.w;
        p.style.display = "";
        p.style.opacity = (arr?.self ? (pending ? 1 : k.arrived) : thumb).toFixed(3);
        p.style.transform = `matrix(${sc},0,0,${sc},${(b.x - origin.x).toFixed(2)},${(b.y - origin.y).toFixed(2)})`;
      } else if (p) p.style.display = "none";
    };
    stepRef.current = () => {
      step();
      // nothing to show or watch: the loop sleeps until a zoom gesture, a flight or an arrival wakes it
      const k = s.current;
      if (root.current?.hidden && !arrivalOf(canvasId) && !flightOn(canvasId) && !k.armed && performance.now() - gesture.t > 2 * IDLE_MS) sleep();
    };
    wake();
    return onZoomWake(canvasId, wake);
  }, [api, canvasId, doors, up, shown, parent?.canvasId]);
  // placed before the first paint (a canvas just switched to shows its stand-in from its very first frame)
  const stepRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => stepRef.current?.());
  const loop = useRef<(() => void) | null>(null);
  const wake = () => void (loop.current ??= frame.add(() => stepRef.current?.()));
  const sleep = () => {
    loop.current?.();
    loop.current = null;
  };
  useEffect(() => sleep, []);

  // a canvas switched to by a zoom: its tab does not fade in (it is already showing what the one before it showed)
  const [arriving] = useState(() => !!arrivalOf(canvasId));
  const bg = api?.getAppState().viewBackgroundColor ?? (getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim() || "white");
  return (
    <div className="sz-layer" ref={root} data-dark={dark || undefined} data-arriving={arriving || undefined} hidden aria-hidden>
      <div className="sz-tint">
        <div className="sz-patch" ref={patch} style={{ display: "none" }} />
        <div className="sz-veil" ref={veil} style={{ background: bg }} />
      </div>
      <div className="sz-pic" ref={pic} style={shown?.svg ? { width: shown.svg.w, height: shown.svg.h, display: "none" } : { display: "none" }} dangerouslySetInnerHTML={shown?.svg ? { __html: shown.html } : undefined} />
    </div>
  );
}
