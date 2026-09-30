// Where the floating shells are over one canvas pane (app/floatShell.ts, web/docs/workstation.md §15), in the frame of the layer that draws the figures: what a bubble,
// the talk box and a stop's note keep off, as they keep off the toolbar (../canvas/chrome.ts). The camera's own view of them is ./replayDom.ts `FLOATS`.
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { floatFocus } from "../app/floatShell";
import { frame } from "./frame";
import { FLOATS } from "./replayDom";
import type { Box } from "../canvas/clearance";

const NONE: Box[] = [];

/** The shells' client rects as boxes in the layer's frame, cut to the layer (a shell over another pane, or none of it over this one, does not count). Pure. */
export function floatBoxesIn(layer: { left: number; top: number; width: number; height: number }, rects: readonly { left: number; top: number; width: number; height: number }[]): Box[] {
  const out: Box[] = [];
  for (const r of rects) {
    const x = Math.max(r.left, layer.left);
    const y = Math.max(r.top, layer.top);
    const x2 = Math.min(r.left + r.width, layer.left + layer.width);
    const y2 = Math.min(r.top + r.height, layer.top + layer.height);
    if (x2 - x >= 2 && y2 - y >= 2) out.push({ x: Math.round(x - layer.left), y: Math.round(y - layer.top), w: Math.round(x2 - x), h: Math.round(y2 - y) });
  }
  return out;
}

/** The floating shells over `layer`, measured every frame while one is on the page (they glide, are dragged, fold): the same array while nothing moved. */
export function useFloatBoxes(layer: RefObject<HTMLElement | null>): Box[] {
  const [boxes, setBoxes] = useState<Box[]>(NONE);
  const last = useRef("[]");
  const any = useSyncExternalStore(floatFocus.subscribe, () => floatFocus.reach("session") !== undefined || floatFocus.reach("comments") !== undefined);
  useEffect(() => {
    const set = (out: Box[]) => {
      const k = JSON.stringify(out);
      if (k === last.current) return;
      last.current = k;
      setBoxes(out.length ? out : NONE);
    };
    if (!any) return void set(NONE);
    return frame.add(() => {
      const el = layer.current;
      if (el) set(floatBoxesIn(el.getBoundingClientRect(), [...document.querySelectorAll<HTMLElement>(FLOATS)].map((s) => s.getBoundingClientRect())));
    });
  }, [any, layer]);
  return boxes;
}
