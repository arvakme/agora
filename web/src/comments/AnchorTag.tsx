// What a comment is pinned to, in the comment list (the card beside the element does not say: it is right there, and
// only speaks when the element is gone, comments/anchorNote.ts): an anchor glyph plus the element name — "Postgres 等 2 个"
// for multi-element anchors — with the words 钉在：in front, so a cut-off name is never a mystery; hovering shows the full name.
import { IconComment, IconPin } from "../app/icons";

export type AnchorName = { id: string; name: string; alive: boolean };

export const anchorText = (names: AnchorName[]) =>
  names.length > 1 ? `${names[0].name} 等 ${names.length} 个` : names[0]?.name ?? "";

export function AnchorTag({ names, whole = false }: { names: AnchorName[]; /** A comment on the whole canvas: nothing to be pinned to. */ whole?: boolean }) {
  if (whole)
    return (
      <span className="anchor-tag" title="这条评论是对整张图的，没有钉在元素上">
        <IconComment size={12} />
        <span className="anchor-tag-text">整张图</span>
      </span>
    );
  const lost = names.every((n) => !n.alive);
  return (
    <span className="anchor-tag" data-lost={lost} title={names.map((n) => n.name + (n.alive ? "" : "（已删除）")).join("、")}>
      <IconPin size={12} />
      <span className="anchor-tag-lead">钉在：</span>
      <span className="anchor-tag-text">{anchorText(names)}</span>
    </span>
  );
}
