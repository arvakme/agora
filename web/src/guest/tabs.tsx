// The tab row of a whole-project share (server/canvas/share.py `project_tree`): the project's top-level canvases; the canvases nested
// under the one being viewed follow it, every other parent only says how many it holds. Pure pieces are exported for tests.
import type { ReactNode } from "react";
import { tr } from "../i18n";

export type GuestTab = { id: string; children: { id: string; depth: number }[] };
type Info = Record<string, { title: string; open: number }>;
type Seen = { canvas: { id: string }; path?: { id: string }[]; share: { root?: string; scope?: "canvas" | "project" } };

/** The canvas a replay is of: the one the share opens at, or for a project the top-level canvas the viewed one belongs to. */
export const replayRoot = (s: Seen) => (s.share.scope === "project" ? (s.path?.[0]?.id ?? s.canvas.id) : (s.share.root ?? s.canvas.id));

export type TabItem = { id: string; depth: number; on: boolean; folded: number };

/** What the row shows: each top-level canvas; under the one holding the viewed canvas its descendants, the viewed one marked. */
export function tabItems(tabs: readonly GuestTab[], top: string | undefined, current: string): TabItem[] {
  return tabs.flatMap((t) => {
    const open = t.id === top;
    return [
      { id: t.id, depth: 0, on: t.id === current, folded: open ? 0 : t.children.length },
      ...(open ? t.children.map((c) => ({ id: c.id, depth: c.depth, on: c.id === current, folded: 0 })) : []),
    ];
  });
}

export function GuestTabs({ tabs, path, current, canvases, onGo }: { tabs: GuestTab[]; path: { id: string }[]; current: string; canvases: Info; onGo: (id: string) => void }): ReactNode {
  const items = tabItems(tabs, path[0]?.id ?? current, current);
  return (
    <nav className="guest-tabs" aria-label={tr("画布", "Canvases")}>
      {items.map((t) => {
        const info = canvases[t.id];
        return (
          <button key={t.id} className="guest-tab" data-on={t.on} data-sub={t.depth > 0 || undefined} aria-current={t.on ? "page" : undefined} onClick={() => onGo(t.id)} title={info?.title || tr("画布", "Canvas")}>
            <span>{info?.title || tr("画布", "Canvas")}</span>
            {t.folded > 0 && <em className="guest-tab-more" title={tr(`含 ${t.folded} 张子图`, `${t.folded} ${t.folded === 1 ? "sub-diagram" : "sub-diagrams"} inside`)}>+{t.folded}</em>}
            {!!info?.open && <em className="guest-tab-open" title={tr(`${info.open} 条进行中的评论`, `${info.open} open ${info.open === 1 ? "comment" : "comments"}`)}>{info.open}</em>}
          </button>
        );
      })}
    </nav>
  );
}
