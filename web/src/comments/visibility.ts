// Which comment threads show where (web/docs/workbench-focus.md §评论):
//   - on the canvas: open threads; resolved ones only when 「显示已解决的评论」 is on (as quiet pins,
//     drawn under the open ones); a thread whose anchor is lost is never drawn, toggle or not;
//   - in the comment list: 进行中 / 已解决, and a 「锚点已失效」 group (open ones first).
// Pure (type-only imports).
import type { AnchorState } from "../canvas/anchors";
import type { Thread } from "./threads";

type Resolve = (t: Thread) => AnchorState;

/** Threads to pin on the canvas, resolved ones first so the open ones sit above them. */
export function pinnable(threads: readonly Thread[], resolve: Resolve, showResolved: boolean): Thread[] {
  const keep = threads.filter((t) => resolve(t).status !== "lost" && (!t.resolved || showResolved));
  return [...keep.filter((t) => t.resolved), ...keep.filter((t) => !t.resolved)];
}

export type Groups = { open: Thread[]; resolved: Thread[]; lost: Thread[] };
/** The comment list's groups. Lost anchors are listed on their own, open ones first. */
export function groupThreads(threads: readonly Thread[], resolve: Resolve): Groups {
  const lost: Thread[] = [];
  const open: Thread[] = [];
  const resolved: Thread[] = [];
  for (const t of threads) {
    if (resolve(t).status === "lost") lost.push(t);
    else if (t.resolved) resolved.push(t);
    else open.push(t);
  }
  lost.sort((a, b) => Number(a.resolved) - Number(b.resolved) || a.n - b.n);
  return { open, resolved, lost };
}
