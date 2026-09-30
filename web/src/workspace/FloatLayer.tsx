// What the workspace draws for a floating session panel (web/docs/workstation.md §15), around the panes that stay in the flat layer: the card or the bottom bar with its title bar and
// resize handles, the rail tab a folded card leaves at the window's right edge, the pill a folded bar leaves beside the 「浏览 / 评论」 bar, and the preview of where a dragged card
// would snap. Geometry and gestures come from ./useFloat.ts.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { applySnap, floatFocus, HANDLE, railTop, RAIL_H, shellBox } from "../app/floatShell";
import { Avatar, BarPill, BarStrip, FloatHead, RailTab, ResizeHandles, SnapPreview, type SessionItem } from "../app/shellParts";
import type { FloatSpec } from "../app/useSessionFloat";
import type { useFloat } from "./useFloat";

const box = (r: { x: number; y: number; w: number; h: number }) => ({ left: r.x, top: r.y, width: Math.max(0, r.w), height: Math.max(0, r.h) });

type F = ReturnType<typeof useFloat>;
type Group = { id: string; tabs: string[]; active: string };

/** The group's section while it floats: the title bar (or the bar's strip) and the handles; the pane itself is the slot the workspace draws over it. */
export function FloatSection({ flt, F, g, titles, marks, focused, onPick, onNew }: {
  flt: FloatSpec;
  F: F;
  g: Group;
  titles: Record<string, string>;
  marks: Record<string, ReactNode>;
  focused: boolean;
  onPick: (tab: string) => void;
  onNew: () => void;
}) {
  const items: SessionItem[] = g.tabs.map((t) => ({ id: t, title: titles[t] ?? "", mark: marks[t] ?? <span className="wm-tab-dot" /> }));
  const common = { items, active: g.active, status: flt.status, onPick, onNew, onDock: flt.onDock, onFold: flt.onFold };
  const attrs = { className: "wm-group", "data-group": g.id, "data-focused": focused, "data-float": flt.mode, style: box(F.frame!), "data-float-shell": "session", "data-float-pad": HANDLE } as const;
  if (flt.mode === "card")
    return (
      <section {...attrs}>
        <FloatHead variant="card" {...common} head={F.card.head} />
        <ResizeHandles handle={F.card.handle} />
      </section>
    );
  const esc = (e: React.KeyboardEvent) => e.key === "Escape" && (e.preventDefault(), e.stopPropagation(), flt.bar.expanded ? flt.onShrink() : flt.onFold());
  return (
    <section {...attrs} data-bar={flt.bar.expanded ? "half" : "strip"} onKeyDown={esc}>
      {flt.bar.expanded ? <FloatHead variant="half" {...common} onShrink={flt.onShrink} /> : <BarStrip kind={flt.kind} status={flt.status} said={flt.said} onExpand={flt.onExpand} onFold={flt.onFold} />}
      {(["w", "e", "n"] as const).map((e) => (
        <div key={e} className="float-h" data-h={e} data-bar aria-hidden {...F.bar.handle(e)} />
      ))}
    </section>
  );
}

/** Around the section: the rail tab or the pill of a folded shell, and the snap preview of a card being dragged. */
export function FloatExtras({ flt, F, header, ws }: { flt: FloatSpec; F: F; header: number; ws: { w: number; h: number } }) {
  useEffect(() => floatFocus.mount("session"), []);
  const [railEl, setRailEl] = useState<HTMLButtonElement | null>(null);
  const [pillEl, setPillEl] = useState<HTMLButtonElement | null>(null);
  const railed = flt.mode === "card" && flt.folded;
  // the folded card's tab stands where the card's middle was, inside the canvas; the comment list's tab goes under it
  const top = railed && F.cardBox ? railTop(F.cardBox.y + F.cardBox.h / 2, RAIL_H, { top: 0, height: F.body.h }, []) : 0;
  useEffect(() => {
    if (!railed) return;
    floatFocus.setRail("session", { top, bottom: top + RAIL_H });
    return () => floatFocus.setRail("session", null);
  }, [railed, top]);
  // fold or unfold by keyboard: focus goes to the other form
  const was = useRef(flt.folded);
  useEffect(() => {
    if (was.current === flt.folded) return;
    was.current = flt.folded;
    if (document.activeElement && document.activeElement !== document.body) return;
    (flt.folded ? railEl ?? pillEl : document.querySelector<HTMLElement>('.wm-group[data-float] .float-head, .wm-group[data-float] .bar-strip button'))?.focus();
  }, [flt.folded, railEl, pillEl]);
  const live = F.card.live;
  const preview = flt.mode === "card" && live?.kind === "move" && F.cardBox && live.snap ? shellBox(applySnap(flt.shell, live.snap, F.cardPane), F.cardPane, "session") : null;
  const news = flt.dot ? "（有新消息）" : "";
  return (
    <>
      {railed && (
        <RailTab name="session" top={top + header} avatar={<Avatar kind={flt.kind} size={20} />} label={flt.label} dot={flt.dot} aria={`展开「${flt.label}」的会话面板${news}`} onOpen={flt.onUnfold} forwardRef={setRailEl} />
      )}
      {flt.mode === "bar" && flt.folded && F.pill && (
        <BarPill box={F.pill} kind={flt.kind} status={flt.status} dot={flt.dot} aria={`展开「${flt.label}」的会话条${news}`} onOpen={flt.onUnfold} forwardRef={setPillEl} />
      )}
      {flt.mode === "card" && !flt.folded && (live?.dock || preview) && (
        <SnapPreview box={preview ? { ...preview, y: preview.y + header } : null} dock={!!live?.dock} dockBox={{ x: ws.w * 0.6, y: 0, w: ws.w * 0.4, h: ws.h }} />
      )}
    </>
  );
}
