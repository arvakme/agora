// What a comment is pinned to, written the same way everywhere (composer, thread
// header, drawer): an anchor glyph plus the element name — "Postgres 等 2 个" for
// multi-element anchors — never a verb phrase like "评论 X".
import { IconAnchor } from "../app/icons";

export type AnchorName = { id: string; name: string; alive: boolean };

export const anchorText = (names: AnchorName[]) =>
  names.length > 1 ? `${names[0].name} 等 ${names.length} 个` : names[0]?.name ?? "";

export function AnchorTag({ names }: { names: AnchorName[] }) {
  const lost = names.every((n) => !n.alive);
  return (
    <span className="anchor-tag" data-lost={lost} title={names.map((n) => n.name + (n.alive ? "" : "（已删除）")).join("、")}>
      <IconAnchor size={11} />
      <span className="anchor-tag-text">{anchorText(names)}</span>
    </span>
  );
}
