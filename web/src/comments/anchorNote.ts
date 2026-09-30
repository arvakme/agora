// What a comment card says about where it is pinned: nothing, unless the element is gone. (The comment list names the
// element of every comment: comments/AnchorTag.tsx.)
import type { AnchorState } from "../canvas/anchors";

export function anchorNote(st: Pick<AnchorState, "status" | "names">): string | null {
  if (st.status === "ok" || st.status === "whole") return null;
  const gone = st.names.filter((n) => !n.alive).map((n) => n.name).join("、");
  return st.status === "lost" ? `钉住的元素已删除，或不在这张画布上：${gone}` : `有的元素已删除，或不在这张画布上：${gone}；其余还在`;
}
