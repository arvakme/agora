// Where each comment pin sits on screen (shared by the comment layer, comment mode's aim and the
// progress pointer, which keeps its label off the pins).
//
// A pin's tip wants to be on its element's top-right corner (resolveAnchor); several threads on
// one corner fan out to the right. It stays off the drawing: when that spot would cover another
// node, an icon or a caption it moves to the nearest clear spot, and a pin whose element is gone
// (it stays where the element was) searches further, so it doesn't sit on whatever is there now.
import { resolveAnchor, type AnchorState } from "../canvas/anchors";
import { footprint, freeSpot, obstacles, overlaps, pinBox, type Box } from "../canvas/clearance";
import type { CanvasViewState } from "../canvas/CanvasView";
import type { Anchor, Thread } from "./threads";

export const PIN = 28;
const PIN_STEP = 32; // pin width + the 4px gap freeSpot keeps between pins
type Pt = { x: number; y: number };

export type PinLayout = {
  pins: { t: Thread; st: AnchorState; p: Pt }[];
  /** Screen boxes of all placed pins. */
  boxes: Box[];
  /** Where a new pin for `anchor` would land (the next one on its corner). */
  landing: (anchor: Anchor) => Pt;
};

export function layoutPins(threads: readonly Thread[], view: CanvasViewState, blocks?: Box[]): PinLayout {
  const a = view.appState, z = a.zoom.value;
  const toScreen = (p: Pt) => ({ x: (p.x + a.scrollX) * z, y: (p.y + a.scrollY) * z });
  const screenBox = (b: Box): Box => ({ x: (b.x + a.scrollX) * z, y: (b.y + a.scrollY) * z, w: b.w * z, h: b.h * z });
  const all = blocks ?? sceneBlocks(view);
  const spotFor = (tip: Pt, anchor: Anchor, lost: boolean, taken: Box[]) => {
    const own = anchor.ids.map((id) => view.map.get(id)).filter((e) => e && !e.isDeleted).map((e) => screenBox(footprint(e!, view.map, view.elements)));
    const others = own.length ? all.filter((b) => !own.some((o) => overlaps(b, o, -6))) : all;
    return freeSpot(tip, PIN, [...others, ...taken], { maxRings: lost ? 8 : 2 });
  };
  const taken = new Map<string, number>();
  const boxes: Box[] = [];
  const keyOf = (st: AnchorState) => `${Math.round(st.point.x)},${Math.round(st.point.y)}`;
  const pins = threads.map((t) => {
    const st = resolveAnchor(t.anchor, view.map);
    const k = taken.get(keyOf(st)) ?? 0;
    taken.set(keyOf(st), k + 1);
    const tip = toScreen(st.point);
    const p = spotFor({ x: tip.x + k * PIN_STEP, y: tip.y }, t.anchor, st.status === "lost", boxes);
    boxes.push(pinBox(p, PIN));
    return { t, st, p };
  });
  const landing = (anchor: Anchor) => {
    const st = resolveAnchor(anchor, view.map);
    const tip = toScreen(st.point);
    return spotFor({ x: tip.x + (taken.get(keyOf(st)) ?? 0) * PIN_STEP, y: tip.y }, anchor, false, boxes);
  };
  return { pins, boxes, landing };
}

/** The drawing's obstacles in screen px. */
export function sceneBlocks(view: CanvasViewState): Box[] {
  const a = view.appState, z = a.zoom.value;
  return obstacles(view.elements, view.map).map((b) => ({ x: (b.x + a.scrollX) * z, y: (b.y + a.scrollY) * z, w: b.w * z, h: b.h * z }));
}
