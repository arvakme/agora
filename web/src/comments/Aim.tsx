// Comment mode's aim: what you are about to comment on, before you click.
//
// The system crosshair is the cursor (drawn by the OS at the screen's resolution, no lag). Next
// to it a comment pin — ordinary DOM, so it is rendered at the device pixel ratio, never a
// bitmap cursor scaled up — follows the pointer; over something commentable it springs to
// the exact spot the pin will land (its top-right corner) and the thing gets a thin outline.
// Clicking drops the real pin right there.
//
// Pointer moves only record the position; one requestAnimationFrame per frame does the hit test
// and writes `transform` / `opacity` straight to the elements (no React render per move and no
// layout at all: the outline is a tint and four 1px hairlines sized by `scale`, so even its size
// is a transform). Motion follows komo's
// card-motion.ts: a spring integrated in small substeps (stiffness 600, damping 34), `translate`
// only, stopped once settled; prefers-reduced-motion jumps instead.
import { useEffect, useRef } from "react";
import { hitTest } from "../canvas/anchors";
import { footprint, inflate } from "../canvas/clearance";
import type { CanvasViewState } from "../canvas/CanvasView";
import { bbox, isArrow, type El } from "../canvas/scene";
import type { Anchor } from "./threads";
import { IconPlus } from "../app/icons";

type Pt = { x: number; y: number };

/** The anchor a click at scene point (sx, sy) on `hit` creates (the same for the aim and the pin). */
export function anchorAt(hit: El, sx: number, sy: number): Anchor {
  const b = bbox(hit);
  const rel = isArrow(hit) ? { x: 0.5, y: 0.5 } : { x: clamp01((sx - b.x) / (b.width || 1)), y: clamp01((sy - b.y) / (b.height || 1)) };
  return { ids: [hit.id], rel, last: { x: sx, y: sy } };
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Round to the device pixel grid, so edges and the pin's number stay sharp. */
export const snap = (v: number) => {
  const d = window.devicePixelRatio || 1;
  return Math.round(v * d) / d;
};

const LINE = 1.5; // outline hairline, CSS px

// Where the free-floating pin sits relative to the crosshair (its tip, up and to the right).
const FREE_OFFSET = { x: 10, y: -10 };

export function springStep(value: number, velocity: number, target: number, dt: number, stiffness = 600, damping = 34) {
  const v = velocity + ((target - value) * stiffness - velocity * damping) * dt;
  return { value: value + v * dt, velocity: v };
}

export function Aim({ view, landing, onPick, onMiss }: {
  view: CanvasViewState;
  /** Where (screen px) the pin for `anchor` would land — the comment layer's own placement rule. */
  landing: (anchor: Anchor) => Pt;
  onPick: (anchor: Anchor) => void;
  onMiss: (at: Pt) => void;
}) {
  const cap = useRef<HTMLDivElement>(null);
  const outline = useRef<HTMLDivElement>(null);
  const pin = useRef<HTMLDivElement>(null);
  const live = useRef({ view, landing });
  live.current = { view, landing };
  const s = useRef({
    ptr: null as Pt | null,
    target: null as string | null,
    x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0,
    frame: 0, last: 0, springing: false, placed: false,
  }).current;
  const reduced = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  const paint = () => {
    if (pin.current) pin.current.style.transform = `translate3d(${snap(s.x)}px, ${snap(s.y)}px, 0)`;
  };
  const tick = (time: number) => {
    s.frame = 0;
    const dt = Math.min((time - s.last) / 1000, 0.032);
    s.last = time;
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    for (let i = 0; i < steps; i++) {
      const nx = springStep(s.x, s.vx, s.tx, dt / steps);
      const ny = springStep(s.y, s.vy, s.ty, dt / steps);
      (s.x = nx.value), (s.vx = nx.velocity), (s.y = ny.value), (s.vy = ny.velocity);
    }
    if (Math.hypot(s.x - s.tx, s.y - s.ty) < 0.1 && Math.hypot(s.vx, s.vy) < 1) {
      (s.x = s.tx), (s.y = s.ty), (s.vx = s.vy = 0), (s.springing = false);
    }
    paint();
    if (s.springing) s.frame = requestAnimationFrame(tick);
  };
  /** Move the pin to (x, y): springing when it changes target, glued to the pointer otherwise. */
  const moveTo = (x: number, y: number, glide: boolean) => {
    s.tx = x;
    s.ty = y;
    if (!s.placed || reduced?.matches || (!glide && !s.springing)) {
      (s.x = x), (s.y = y), (s.vx = s.vy = 0), (s.placed = true);
      return paint();
    }
    if (glide) s.springing = true;
    if (!s.frame) {
      s.last = performance.now();
      s.frame = requestAnimationFrame(tick);
    }
  };

  // One frame: hit test at the last pointer position, then write styles.
  const update = () => {
    const o = outline.current, p = pin.current;
    if (!o || !p) return;
    if (!s.ptr) {
      o.style.opacity = "0";
      p.style.opacity = "0";
      s.target = null;
      s.placed = false;
      return;
    }
    const { view: v, landing: land } = live.current;
    const a = v.appState, z = a.zoom.value;
    const sx = s.ptr.x / z - a.scrollX, sy = s.ptr.y / z - a.scrollY;
    const hit = hitTest(v.elements, sx, sy, z);
    p.style.opacity = "1";
    if (!hit) {
      o.style.opacity = "0";
      p.dataset.on = "false";
      const changed = s.target !== null;
      s.target = null;
      moveTo(s.ptr.x + FREE_OFFSET.x, s.ptr.y + FREE_OFFSET.y, changed);
      return;
    }
    const tip = land(anchorAt(hit, sx, sy));
    const f = footprint(hit, v.map, v.elements);
    const box = inflate({ x: (f.x + a.scrollX) * z, y: (f.y + a.scrollY) * z, w: f.w * z, h: f.h * z }, 4);
    const w = snap(box.w), h = snap(box.h), t = LINE;
    o.style.transform = `translate3d(${snap(box.x)}px, ${snap(box.y)}px, 0)`;
    const [fill, top, bottom, left, right] = o.children as unknown as HTMLElement[];
    fill.style.transform = `scale(${w}, ${h})`;
    top.style.transform = `scale(${w}, ${t})`;
    bottom.style.transform = `translate3d(0, ${h - t}px, 0) scale(${w}, ${t})`;
    left.style.transform = `scale(${t}, ${h})`;
    right.style.transform = `translate3d(${w - t}px, 0, 0) scale(${t}, ${h})`;
    o.style.opacity = "1";
    p.dataset.on = "true";
    // Arrows keep the pin where on the path it was pointed at, which moves with the pointer.
    const changed = s.target !== hit.id || isArrow(hit);
    s.target = hit.id;
    moveTo(tip.x, tip.y, changed);
  };
  const schedule = useRef(0);
  const request = () => {
    if (schedule.current) return;
    schedule.current = requestAnimationFrame(() => {
      schedule.current = 0;
      update();
    });
  };
  // Panning / zooming under a still pointer re-aims too.
  useEffect(request, [view]);
  useEffect(() => () => (cancelAnimationFrame(schedule.current), cancelAnimationFrame(s.frame)), []);

  // The layer's page position, read once per entry (reading it on every move would force a layout
  // right after the previous frame's style writes).
  const origin = useRef<Pt | null>(null);
  const measure = () => {
    const r = cap.current!.getBoundingClientRect();
    origin.current = { x: r.left, y: r.top };
  };
  useEffect(() => void (origin.current = null), [view.appState.width, view.appState.height]);
  const local = (e: React.PointerEvent): Pt => {
    if (!origin.current) measure();
    return { x: e.clientX - origin.current!.x, y: e.clientY - origin.current!.y };
  };
  return (
    <>
      <div
        ref={cap}
        className="capture"
        onPointerMove={(e) => {
          s.ptr = local(e);
          request();
        }}
        onPointerEnter={(e) => {
          measure();
          s.ptr = local(e);
          request();
        }}
        onPointerLeave={() => {
          s.ptr = null;
          request();
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          const at = local(e);
          const { view: v } = live.current;
          const a = v.appState, z = a.zoom.value;
          const sx = at.x / z - a.scrollX, sy = at.y / z - a.scrollY;
          const hit = hitTest(v.elements, sx, sy, z);
          if (!hit) return onMiss(at);
          s.ptr = null;
          update();
          onPick(anchorAt(hit, sx, sy));
        }}
      />
      <div ref={outline} className="aim-outline" aria-hidden>
        <i data-fill /><i /><i /><i /><i />
      </div>
      <div ref={pin} className="aim-pin" aria-hidden data-on="false">
        <span className="pin-body"><IconPlus size={14} /></span>
      </div>
    </>
  );
}
