// The window is two columns by default: canvases on the left, sessions on the right (web/docs/workspace-model.md §布局).
// A tab dropped on a column joins it as a tab — dropping never cuts a new column — and 「恢复默认布局」 puts any layout back,
// an old many-column one included. Pure.
import { columns, group, groups, moveTab, type Node } from "./layout.ts";

/** The canvas takes this much of the width, the sessions the rest (model.ts `placeDoc` splits the same way). */
export const SHARES: [number, number] = [0.6, 0.4];

/** Drop `tab` on the column `groupId` (at `index` among its tabs, or last). Never makes a column. */
export const dropTab = (root: Node, tab: string, groupId: string, index?: number): Node => moveTab(root, tab, groupId, "center", index);

/** Two columns: every canvas tab left, everything else right, each in the order it was on screen; the tab showing in a column stays the one showing. */
export function defaultLayout(root: Node, kindOf: (tab: string) => string | undefined): Node {
  const all = groups(root);
  const isCanvas = (t: string) => kindOf(t) === "canvas";
  const tabs = all.flatMap((g) => g.tabs);
  const left = tabs.filter(isCanvas);
  const right = tabs.filter((t) => !isCanvas(t));
  const shown = (mine: string[]) => all.map((g) => g.active).find((a) => mine.includes(a)) ?? mine[0];
  if (!left.length || !right.length) return group(tabs, shown(tabs));
  return columns(group(left, shown(left)), group(right, shown(right)), SHARES);
}
