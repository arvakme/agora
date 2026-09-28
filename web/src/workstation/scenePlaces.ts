// The places ./place.ts takes from the picture besides files (web/docs/workstation.md §评论联动与进出子图):
// where a canvas comment is worked on (`Ctx.anchor`), and the doors — on a child canvas, the entrance a
// worker comes in by from the canvas above (`Ctx.door`). Pure (clearance.ts is pure; the rest are type
// imports), built with the geometry: once per scene version.
import { footprint, type Box } from "../canvas/clearance";
import type { El } from "../canvas/scene";
import { OUTSIDE, type Ctx, type Located } from "./place";

/**
 * A comment pinned to these elements (the first carries the pin) → where its work happens on this
 * canvas: the linked node the first live one is, or lies in (its label, a note written on it, a part of
 * its icon: the smallest node box around the element's middle); else the node nearest it; with no nodes
 * at all, the 图外 tray. Null when none of them is on this canvas.
 */
export function anchorPlace(boxes: ReadonlyMap<string, Box>, map: Map<string, El>): (ids: readonly string[]) => Located | null {
  const memo = new Map<string, Located | null>();
  return (ids) => {
    const key = ids.join("\u0000");
    let out = memo.get(key);
    if (out === undefined) {
      const e = ids.map((id) => map.get(id)).find((x) => x && !x.isDeleted);
      memo.set(key, (out = e ? { place: nodeOf(e, boxes, map) } : null));
    }
    return out;
  };
}

function nodeOf(e: El, boxes: ReadonlyMap<string, Box>, map: Map<string, El>): string {
  if (boxes.has(e.id)) return e.id;
  const b = footprint(e, map);
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  let best: string | undefined;
  let area = Infinity;
  for (const [id, n] of boxes)
    if (c.x >= n.x && c.x <= n.x + n.w && c.y >= n.y && c.y <= n.y + n.h && n.w * n.h < area) {
      best = id;
      area = n.w * n.h;
    }
  if (best) return best;
  let d = Infinity;
  for (const [id, n] of boxes) {
    const dn = Math.hypot(Math.max(n.x - c.x, 0, c.x - n.x - n.w), Math.max(n.y - c.y, 0, c.y - n.y - n.h));
    if (dn < d) {
      best = id;
      d = dn;
    }
  }
  return best ?? OUTSIDE;
}

/** A child canvas's entrance: its node nearest the top left of all its nodes (where one starts reading a diagram). */
export function entranceOf(boxes: ReadonlyMap<string, Box>): string | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  for (const b of boxes.values()) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
  }
  let best: string | undefined;
  let d = Infinity;
  for (const [id, b] of boxes) {
    const dn = Math.hypot(b.x - x0, b.y - y0);
    if (dn < d) {
      best = id;
      d = dn;
    }
  }
  return best;
}

/** What a canvas's overlay context adds to its files: where comments are worked on, and doors.
 * `child`: the canvas is a node's sub-diagram (nested/store `index`), so it has an entrance. */
export function scenePlaces(boxes: ReadonlyMap<string, Box>, map: Map<string, El>, child: boolean): Pick<Ctx, "anchor" | "door"> {
  const entrance = child ? entranceOf(boxes) : undefined;
  return { anchor: anchorPlace(boxes, map), door: entrance ? { entrance } : {} };
}
