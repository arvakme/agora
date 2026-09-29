// Which of the elements a hovered session step touched get an outline on the canvas (canvas/CanvasView.tsx `HighlightLayer`). A step that drew a whole
// diagram touches every node, arrow and label; outlining all of them stacks their boxes (an arrow's is as big as the space it crosses) into one purple mass.
// The nodes are what changed: when there are any, arrows and the labels bound to a node or an arrow are left out; a step of arrows only outlines the arrows.
type Hl = { id: string; type: string; isDeleted?: boolean; containerId?: string | null };

export function highlightBoxes<T extends Hl>(els: readonly T[]): T[] {
  const live = els.filter((e) => !e.isDeleted);
  const bound = (e: T) => e.type === "text" && !!e.containerId;
  const nodes = live.filter((e) => e.type !== "arrow" && !bound(e));
  return nodes.length ? nodes : live.filter((e) => !bound(e));
}
