// The traced route's words (web/docs/workstation.md §11): a stop's number and its sub-diagram note said in plain
// language, the bar over the canvas while the route stays, and the legend for the numbers. Pure.

/** 「第 1 站 · 在子图「文件 · 云电脑」里」: beside a stop that went into sub-diagrams (a node's label is its first line: the second is the code path; the note ellipsizes, the title has all of it). */
export const stopEntryText = (n: number, labels: readonly string[]) => `第 ${n} 站 · 在子图「${labels.map(nodeTitle).join("、")}」里`;

/** A node's name: its first line. The geometry collapses the lines, so the code path a node also lists (「components/file · …」) is cut where it starts. */
const nodeTitle = (label: string) => {
  const first = label.split("\n")[0].replace(/\s+[\w.-]+\/\S*.*$/, "").trim();
  return first || label.trim();
};

/** The bar's words while a route is on the canvas after a replay. */
export const routeBarText = (turn: number | null) => (turn == null ? "这一轮的路线" : `第 ${turn} 轮的路线`);

export const ROUTE_LEGEND = "数字 = 这一轮先后到过的地方";
