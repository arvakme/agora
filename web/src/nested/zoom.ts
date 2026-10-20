// Semantic zoom between a canvas and its sub-diagrams (docs/nested-canvas.md §2 缩放进出): the numbers and the camera math, pure
// (no DOM, no Excalidraw) so they run under vitest. The page side is ./ZoomLayer.tsx (the thumbnail in the node, the veil, the wheel)
// and ./zoomNav.ts (the flights and the switches).
//
// A view is a similarity from a canvas's scene to the page (client px): `client = p * k + (x, y)`. Excalidraw's camera is that
// similarity seen from its pane (`zoom = k`, `scrollX = (x - pane.left) / k`): the parent's pane and the child's are not at the
// same place on the page (a child canvas has the breadcrumb strip over it), so the hand-off between them is done on the page.
import type { Box } from "../canvas/clearance";

export type Pt = { x: number; y: number };
/** Scene → page: `client = p * k + (x, y)`. */
export type Sim = { k: number; x: number; y: number };
/** Excalidraw's camera. */
export type Cam = { scrollX: number; scrollY: number; zoom: number };
export type Pane = { w: number; h: number };

/** Excalidraw's zoom range (its `getNormalizedZoom`). */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 30;

/**
 * How big a node is on screen: the larger of its width and height as a share of the pane's (1: it just fits). One number on
 * both sides of the switch — in a child canvas it is the node's size in the parent's view that shows the child where it is.
 */
export const fillOf = (box: Pick<Box, "w" | "h">, k: number, pane: Pane) => Math.max((box.w * k) / Math.max(1, pane.w), (box.h * k) / Math.max(1, pane.h));

/** The thumbnail of the sub-diagram fades in over the node between these fills. */
export const THUMB_FROM = 0.2;
export const THUMB_TO = 0.45;
/** The rest of the parent canvas fades out (behind a veil the colour of the canvas) between these: at the switch only the sub-diagram is left. */
export const VEIL_FROM = 0.4;
export const VEIL_TO = 0.6;
/** Zooming in: the switch into the sub-diagram. */
export const ENTER_FILL = 0.78;
/** Zooming out in a sub-diagram: back to the parent (hysteresis: well below ENTER_FILL, and at VEIL_TO, where the parent looks the same). */
export const LEAVE_FILL = VEIL_TO;
/** No switch back within this long of the last one. */
export const COOLDOWN_MS = 350;
/** A zoom gesture has ended this long after its last wheel event. */
export const IDLE_MS = 260;
/** The thumbnail sits this far inside the node (share of the node's smaller side). */
export const INSET = 0.08;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const thumbAlpha = (fill: number) => smooth(THUMB_FROM, THUMB_TO, fill);
export const veilAlpha = (fill: number) => smooth(VEIL_FROM, VEIL_TO, fill);

/** Where the thumbnail goes in the node (parent scene). */
export function innerBox(node: Box): Box {
  const d = Math.min(node.w, node.h) * INSET;
  return { x: node.x + d, y: node.y + d, w: Math.max(1, node.w - 2 * d), h: Math.max(1, node.h - 2 * d) };
}

/** Child scene → parent scene, `P = q * s + t`: the child's drawing (`content`) contained and centred in the node's inner box. */
export type Nest = { s: number; tx: number; ty: number };
export function nestOf(node: Box, content: Box): Nest {
  const n = innerBox(node);
  const s = Math.min(n.w / Math.max(1, content.w), n.h / Math.max(1, content.h));
  return { s, tx: n.x + n.w / 2 - (content.x + content.w / 2) * s, ty: n.y + n.h / 2 - (content.y + content.h / 2) * s };
}
/** A child box placed in the parent's scene. */
export const nestBox = (m: Nest, b: Box): Box => ({ x: b.x * m.s + m.tx, y: b.y * m.s + m.ty, w: b.w * m.s, h: b.h * m.s });

/** The child's view that shows the child exactly where the parent's view shows its thumbnail. */
export const childSim = (parent: Sim, m: Nest): Sim => ({ k: parent.k * m.s, x: m.tx * parent.k + parent.x, y: m.ty * parent.k + parent.y });
/** The parent's view that shows the thumbnail exactly where the child's view shows the child. */
export function parentSim(child: Sim, m: Nest): Sim {
  const k = child.k / m.s;
  return { k, x: child.x - m.tx * k, y: child.y - m.ty * k };
}

/** A pane at `origin` (its top-left on the page): its camera ↔ the view. */
export const simOf = (c: Cam, origin: Pt): Sim => ({ k: c.zoom, x: c.scrollX * c.zoom + origin.x, y: c.scrollY * c.zoom + origin.y });
export const camOf = (s: Sim, origin: Pt): Cam => ({ zoom: s.k, scrollX: (s.x - origin.x) / s.k, scrollY: (s.y - origin.y) / s.k });

/** A scene box on the page (or in a pane, with a pane-local view). */
export const onPage = (s: Sim, b: Box): Box => ({ x: b.x * s.k + s.x, y: b.y * s.k + s.y, w: b.w * s.k, h: b.h * s.k });

/** The view a canvas fits itself to (CanvasView `fit`): the drawing centred, zoom in [0.3, 1] with room round it. */
export function fitCam(content: Box, pane: Pane): Cam {
  const zoom = Math.max(0.3, Math.min(1, (pane.w - 48) / Math.max(1, content.w), (pane.h - 120) / Math.max(1, content.h)));
  return { zoom, scrollX: pane.w / 2 / zoom - (content.x + content.w / 2), scrollY: pane.h / 2 / zoom - (content.y + content.h / 2) };
}

/** Held to Excalidraw's zoom range, about the page point `at` (the point stays put). */
export function clampSim(s: Sim, at: Pt): Sim {
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.k));
  if (k === s.k) return s;
  // the scene point under `at` stays under it
  const px = (at.x - s.x) / s.k;
  const py = (at.y - s.y) / s.k;
  return { k, x: at.x - px * k, y: at.y - py * k };
}

/** The flights: ease-in-out, a little longer the further the zoom goes. */
export const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
export function flightMs(from: Sim, to: Sim, min = 480, max = 700): number {
  const zoomRatio = Math.abs(Math.log(to.k / from.k));
  return Math.round(Math.min(max, min + zoomRatio * 70));
}

/**
 * The view `u` of the way (0..1, already eased) from `a` to `b`. The zoom goes geometrically; the motion is a zoom about the one
 * scene point both views put at the same place on the page (into a node: the node grows where it is and the rest moves out
 * round it). With no such point near (almost no zoom change) it is a straight pan.
 */
export function flyAt(a: Sim, b: Sim, u: number): Sim {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const r = b.k / a.k;
  const k = a.k * r ** u;
  if (Math.abs(Math.log(r)) < 0.05) return { k, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  // fixed point F: F*a.k + a.o = F*b.k + b.o
  const fx = (a.x - b.x) / (b.k - a.k);
  const fy = (a.y - b.y) / (b.k - a.k);
  const cx = fx * a.k + a.x;
  const cy = fy * a.k + a.y;
  return { k, x: cx - fx * k, y: cy - fy * k };
}

/** What a zoom gesture does now. `dir`: +1 zooming in, -1 out (the last wheel or pinch step). */
export type ZoomInput = {
  /** "parent": a canvas showing a node with a sub-diagram; "child": a sub-diagram (fill is its node's, in the parent's view). */
  side: "parent" | "child";
  fill: number;
  dir: 1 | -1 | 0;
  /** ms since the last switch. */
  since: number;
  /** The gesture is over (no wheel for IDLE_MS). */
  idle: boolean;
  /** Text being edited, something dragged or resized, a turn playing, a flight on: no switch. */
  blocked: boolean;
  /** A sub-diagram already at Excalidraw's smallest zoom, still zoomed out. */
  atMin?: boolean;
};
export function zoomStep(i: ZoomInput): "enter" | "leave" | null {
  if (i.blocked || i.since < COOLDOWN_MS) return null;
  if (i.side === "parent") {
    // through the threshold while zooming in; or the gesture stopped where only the sub-diagram is left to see
    if (i.dir > 0 && (i.fill >= ENTER_FILL || (i.idle && i.fill >= VEIL_TO))) return "enter";
    return null;
  }
  if (i.dir < 0 && !i.idle && (i.fill <= LEAVE_FILL || i.atMin)) return "leave";
  return null;
}
