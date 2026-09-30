// The session head's 「画在：<画布>」: a session works on one diagram tree, so only the top-level canvases are choices —
// a sub-diagram belongs to the tree of the canvas it opens from. Pure.
import type { ParentRef } from "../nested/graph";

export type CanvasChoice = { id: string; title: string };

/** The canvas at the top of `id`'s tree (`id` itself when it has no parent). */
export function topOf(id: string, index: ReadonlyMap<string, ParentRef>): string {
  const seen = new Set<string>();
  let cur = id;
  for (let p = index.get(cur); p && !seen.has(cur); p = index.get(cur)) {
    seen.add(cur);
    cur = p.canvasId;
  }
  return cur;
}

/** The workspace's canvases that are not opened from another one, in the workspace's order. */
export const canvasChoices = (titles: Readonly<Record<string, string>>, index: ReadonlyMap<string, ParentRef>): CanvasChoice[] =>
  Object.entries(titles)
    .filter(([id]) => !(index.get(id)?.canvasId! in titles))
    .map(([id, title]) => ({ id, title }));
