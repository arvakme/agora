// The traced route's words (web/docs/workstation.md §11): a stop's number and its sub-diagram note said in plain
// language, the bar over the canvas while the route stays, and the legend for the numbers. Pure.
import { tr } from "../i18n";

/** 「第 1 站 · 在子图「文件 · 云电脑」里」: beside a stop that went into sub-diagrams (a node's label is its first line: the second is the code path; the note ellipsizes, the title has all of it). */
export const stopEntryText = (n: number, labels: readonly string[]) => tr(`第 ${n} 站 · 在子图「${labels.map(nodeTitle).join("、")}」里`, `Stop ${n} · in sub-diagram “${labels.map(nodeTitle).join(", ")}”`);

/** The same in a sentence for the hover text and screen readers: what this number is, and what the little note beside it says. */
export const stopEntryNote = (n: number, labels: readonly string[]) => tr(`第 ${n} 站：小人在这里进了子图「${labels.map(nodeTitle).join("、")}」`, `Stop ${n}: the avatar went into sub-diagram “${labels.map(nodeTitle).join(", ")}” here`);

/** A node's name: its first line. The geometry collapses the lines, so the code path a node also lists (「components/file · …」) is cut where it starts. */
const nodeTitle = (label: string) => {
  const first = label.split("\n")[0].replace(/\s+[\w.-]+\/\S*.*$/, "").trim();
  return first || label.trim();
};

/** The bar's words while a route is on the canvas after a replay. */
export const routeBarText = (turn: number | null) => (turn == null ? tr("这一轮的路线", "This turn's route") : tr(`第 ${turn} 轮的路线`, `Route of turn ${turn}`));

export const ROUTE_LEGEND = tr("数字 = 这一轮先后到过的地方", "Numbers = the places this turn visited, in order");
