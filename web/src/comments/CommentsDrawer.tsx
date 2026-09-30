// The comment list for one canvas: a panel floating over the drawing at its top right (it takes no room from the canvas), in the shell the session panel
// floats in too (app/floatShell.ts, web/docs/workstation.md §15): dragged by its head, sized by its eight handles, folded to a tab at the window's right edge (under the
// session's), one open at a time with the session card; where it is, how big and whether it is folded stay in this browser. 进行中 / 已解决 tabs,
// the 「在画布上显示已解决」 switch (the same one as in ⋯), and a 「锚点已失效」 group for threads whose
// element is gone (never drawn on the canvas): 重新钉到… another element, or 删除. Picking a thread
// pans to its pin (if it is off screen) and opens it; a resolved one opens here, with 重新打开.
import { floatFocus, HANDLE, railTop, RAIL_H, RAIL_W, shellBox } from "../app/floatShell";
import { RailTab, ResizeHandles, useClaim, useRail, useShell, useShellGestures } from "../app/shellParts";
import { pinState } from "./handoffState";
import { useAuthorColors } from "./authorColor";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveAnchor } from "../canvas/anchors";
import type { CanvasViewState } from "../canvas/CanvasView";
import { IconCheck, IconClose, IconList, IconRetry, IconTarget, IconTrash } from "../app/icons";
import { prefs, usePrefs } from "../app/prefs";
import { isOwner, useThreads, type Thread, type ThreadStore } from "./threads";
import { groupThreads } from "./visibility";
import { offerUndo } from "./undo";
import { SPRING } from "./motion";
import { AnchorTag } from "./AnchorTag";
import { MomentChip } from "./MomentChip";
import { ago } from "./ThreadCard";
import { GUEST } from "../guest/mode";
import "./drawerFloat.css";

export function CommentsDrawer({ title, api, store, view, open, onOpen, onClose, focusId, onRepin }: {
  title: string;
  api: ExcalidrawImperativeAPI;
  store: ThreadStore;
  view: CanvasViewState;
  open: boolean;
  /** The small button was pressed: the list is open again. */
  onOpen: () => void;
  onClose: () => void;
  /** A thread to show (a resolved pin clicked on the canvas): its tab opens and the row expands. */
  focusId?: { id: string; key: number } | null;
  /** 「重新钉到…」 a lost thread: the canvas waits for an element. */
  onRepin?: (threadId: string) => void;
}) {
  const { threads, activeId } = useThreads(store);
  const colors = useAuthorColors(store);
  const { showResolved } = usePrefs();
  // the canvas pane the panel floats over: its size decides the panel's, and where a dragged panel may go
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pane, setPane] = useState({ w: view.appState.width, h: view.appState.height });
  useLayoutEffect(() => {
    const h = el?.parentElement;
    if (!h) return;
    setHost(h);
    const measure = () => setPane({ w: h.clientWidth, h: h.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(h);
    return () => ro.disconnect();
  }, [el]);
  const [shell, setShell] = useShell("comments");
  // Opening the list from the dock shows it whole; closing it (✕ or the dock) leaves nothing behind. Only a folded list
  // that was never closed stays as its rail tab, also after a reload.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open !== wasOpen.current && shell.folded) setShell({ ...shell, folded: false });
    wasOpen.current = open;
  }, [open]);
  // One card open at a time: the session card being the open one folds this one to its rail tab (what the viewer chose for it stays). The session's bar does not: they can be up together.
  const openCard = useClaim("comments", open && !shell.folded);
  const folded = shell.folded || (open && openCard === "session");
  const shown_ = open || shell.folded;
  useEffect(() => (shown_ ? floatFocus.mount("comments") : undefined), [shown_]);
  // a folded session card's rail tab is at the window's right edge: this card stays clear of it, and this list's own tab goes under that one
  const sessionRail = useRail("session");
  const cardPane = { w: pane.w - (sessionRail ? RAIL_W : 0), h: pane.h };
  const at = shellBox(shell, cardPane, "comments");
  const gestures = useShellGestures({ shell, set: setShell, pane: cardPane, kind: "comments", onFold: () => setShell({ ...shell, folded: true }) });
  const railed = shown_ && folded;
  // the bar of the session keeps clear of this card: tell it where the card is
  useEffect(() => {
    if (!shown_ || folded) return;
    floatFocus.setCard("comments", { x: at.x, y: at.y, w: at.w, h: at.h });
    return () => floatFocus.setCard("comments", null);
  }, [shown_, folded, at.x, at.y, at.w, at.h]);
  const tabTop = railed ? railTop(at.y + at.h / 2, RAIL_H, { top: 0, height: pane.h }, sessionRail ? [sessionRail] : []) : 0;
  useEffect(() => {
    if (!railed) return;
    floatFocus.setRail("comments", { top: tabTop, bottom: tabTop + RAIL_H });
    return () => floatFocus.setRail("comments", null);
  }, [railed, tabTop]);
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [expanded, setExpanded] = useState<string | null>(null);
  const g = groupThreads(threads, (t) => resolveAnchor(t.anchor, view.map));
  const shown = tab === "open" ? g.open : g.resolved;
  useEffect(() => {
    if (!focusId) return;
    const t = store.thread(focusId.id);
    if (!t) return;
    setTab(t.resolved ? "resolved" : "open");
    setExpanded(t.id);
    setTimeout(() => document.querySelector(`[data-ditem="${t.id}"]`)?.scrollIntoView({ block: "nearest" }), 60);
  }, [focusId?.key]);

  const focus = (id: string) => {
    const t = store.thread(id)!;
    if (t.resolved) return setExpanded(expanded === id ? null : id);
    if (!t.anchor) return store.open(id); // on the whole canvas: nothing to pan to, the card opens by the corner button
    const st = resolveAnchor(t.anchor, view.map);
    const a = view.appState;
    const sx = (st.point.x + a.scrollX) * a.zoom.value, sy = (st.point.y + a.scrollY) * a.zoom.value;
    // The panel floats over the canvas: pan when the pin is off the canvas or under the panel.
    const under = !folded && sx > at.x - 24 && sx < at.x + at.w && sy > at.y - 24 && sy < at.y + at.h;
    if (sx < 40 || sy < 40 || sx > a.width - 40 || sy > a.height - 80 || under) {
      api.updateScene({ appState: { scrollX: a.width / 2 / a.zoom.value - st.point.x, scrollY: a.height / 2 / a.zoom.value - st.point.y } });
    }
    store.open(id);
  };

  if (!shown_) return null;
  const row = (t: Thread, lost = false) => {
    const st = resolveAnchor(t.anchor, view.map);
    const isOpen = expanded === t.id;
    return (
      <motion.div layout="position" key={t.id} className="ditem-wrap" data-ditem={t.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }} transition={SPRING}>
        <button className="ditem" data-active={t.id === activeId || isOpen} onClick={() => (lost ? setExpanded(isOpen ? null : t.id) : focus(t.id))} aria-expanded={t.resolved || lost ? isOpen : undefined}>
          <span className="ditem-pin" data-resolved={t.resolved} data-lost={lost || undefined} data-author={colors.ofThread(t)}>
            {lost ? <i className="ditem-warn" data-open={!t.resolved || undefined} /> : t.resolved ? <IconCheck size={12} /> : t.n}
          </span>
          <span className="ditem-main">
            <span className="ditem-meta">
              {lost && <b className="ditem-n">#{t.n}</b>}
              <AnchorTag names={st.names} whole={st.status === "whole"} />
              <MomentChip t={t} canvasId={store.canvasId} />
              <time>{ago(t.messages.at(-1)!.at)}</time>
            </span>
            <span className="ditem-text">{t.messages[0].text}</span>
            <span className="ditem-foot">
              {t.messages.length > 1 && <span>{t.messages.length - 1} 条回复</span>}
              {t.agent === "running" && <span><i className="dot" data-tone="ok" />Agent 处理中</span>}
              {pinState(t) === "answered" && <span><i className="dot" data-tone="answered" />Agent 已答复</span>}
              {t.resolved && <span>已解决{t.resolvedBy ? ` · ${t.resolvedBy.name}` : ""}{t.resolvedAt ? ` · ${ago(t.resolvedAt)}` : ""}</span>}
            </span>
          </span>
        </button>
        <AnimatePresence initial={false}>
          {isOpen && !GUEST && (
            <motion.div className="ditem-acts" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0, transition: { duration: 0.12 } }} transition={SPRING}>
              {lost ? (
                <>
                  <button className="btn sm quiet" onClick={() => onRepin?.(t.id)}><IconTarget size={14} />重新钉到…</button>
                  {isOwner() && <button className="btn sm ghost danger" onClick={() => offerUndo(store.removeThread(t.id))}><IconTrash size={14} />删除</button>}
                </>
              ) : (
                <button className="btn sm quiet" onClick={() => (store.setResolved(t.id, false), setTab("open"), setExpanded(null), setTimeout(() => focus(t.id), 60))}><IconRetry size={14} />重新打开</button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    );
  };
  if (folded)
    return (
      <RailTab
        name="comments"
        top={tabTop}
        avatar={<IconList size={20} />}
        count={g.open.length}
        label="评论"
        aria={`展开「${title}」的评论列表 · ${g.open.length} 条进行中`}
        onOpen={() => (onOpen(), setShell({ ...shell, folded: false }), floatFocus.set("comments"))}
        forwardRef={setEl}
      />
    );
  return (
    <aside ref={setEl} className="drawer" data-float-shell="comments" data-float-pad={HANDLE} style={{ left: at.x, top: at.y, width: at.w, height: at.h }} aria-label={`「${title}」的评论`} onPointerDown={(e) => e.stopPropagation()}>
      <header className="drawer-head float-head" tabIndex={0} {...gestures.head} title="拖动可以挪位置 · 双击换宽度 · Alt+方向键移动 · Esc 收起">
        <h2 className="drawer-title" title={title}>{title}<span> 的评论</span></h2>
        <button className="icon-btn muted" onClick={() => setShell({ ...shell, folded: true })} aria-label="收起" title="收起（Esc）">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M6 12h12" /></svg>
        </button>
        <button className="icon-btn muted" onClick={onClose} aria-label="关闭评论列表" title="关闭"><IconClose size={16} /></button>
      </header>
      <ResizeHandles handle={gestures.handle} />
      <div className="drawer-bar">
        <div className="seg" role="tablist">
          {(["open", "resolved"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} data-on={tab === k} onClick={() => setTab(k)}>
              {tab === k && <motion.span layoutId={`seg-${view.id}`} className="seg-bg" transition={SPRING} />}
              <span>{k === "open" ? "进行中" : "已解决"}</span>
              <em>{k === "open" ? g.open.length : g.resolved.length}</em>
            </button>
          ))}
        </div>
        <button className="drawer-sw" role="switch" aria-checked={showResolved} onClick={() => prefs.set({ showResolved: !showResolved })} title="已解决的评论在画布上显示为淡色的钉">
          <span className="sw" aria-hidden />
          在画布上显示已解决
        </button>
      </div>
      <div className="drawer-list">
        <AnimatePresence initial={false} mode="popLayout">
          {shown.map((t) => row(t))}
        </AnimatePresence>
        {!shown.length && (
          <div className="drawer-empty">
            <span className="dither-field" aria-hidden />
            {tab === "open" ? <span>没有进行中的评论。<br />按 C，再点一个元素钉一条；或用左下角的「整张图」评论整张图。</span> : <span>还没有已解决的评论。</span>}
          </div>
        )}
        {g.lost.length > 0 && (
          <section className="drawer-group" aria-label="锚点已失效">
            <h3>
              锚点已失效 <em>{g.lost.length}</em>
            </h3>
            <p>评论的元素被删掉了，这些评论不再画在图上。重新钉到别的元素，或者删除。</p>
            <AnimatePresence initial={false}>{g.lost.map((t) => row(t, true))}</AnimatePresence>
          </section>
        )}
      </div>
    </aside>
  );
}
