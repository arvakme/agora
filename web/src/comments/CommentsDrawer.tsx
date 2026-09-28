// The comment list for one canvas: a flush column beside the drawing (D13). 进行中 / 已解决 tabs,
// the 「在画布上显示已解决」 switch (the same one as in ⋯), and a 「锚点已失效」 group for threads whose
// element is gone (never drawn on the canvas): 重新钉到… another element, or 删除. Picking a thread
// pans to its pin (if it is off screen) and opens it; a resolved one opens here, with 重新打开.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { resolveAnchor } from "../canvas/anchors";
import type { CanvasViewState } from "../canvas/CanvasView";
import { IconCheck, IconClose, IconRetry, IconTarget, IconTrash } from "../app/icons";
import { prefs, usePrefs } from "../app/prefs";
import { isOwner, useThreads, type Thread, type ThreadStore } from "./threads";
import { groupThreads } from "./visibility";
import { offerUndo } from "./undo";
import { SPRING } from "./motion";
import { AnchorTag } from "./AnchorTag";
import { ago } from "./ThreadCard";
import { GUEST } from "../guest/mode";

export function CommentsDrawer({ title, api, store, view, open, onClose, focusId, onRepin }: {
  title: string;
  api: ExcalidrawImperativeAPI;
  store: ThreadStore;
  view: CanvasViewState;
  open: boolean;
  onClose: () => void;
  /** A thread to show (a resolved pin clicked on the canvas): its tab opens and the row expands. */
  focusId?: { id: string; key: number } | null;
  /** 「重新钉到…」 a lost thread: the canvas waits for an element. */
  onRepin?: (threadId: string) => void;
}) {
  const { threads, activeId } = useThreads(store);
  const { showResolved } = usePrefs();
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
    const st = resolveAnchor(t.anchor, view.map);
    const a = view.appState;
    const sx = (st.point.x + a.scrollX) * a.zoom.value, sy = (st.point.y + a.scrollY) * a.zoom.value;
    // The column sits beside the canvas now, so the whole canvas is visible: pan only when the pin is off it.
    if (sx < 40 || sy < 40 || sx > a.width - 40 || sy > a.height - 80) {
      api.updateScene({ appState: { scrollX: a.width / 2 / a.zoom.value - st.point.x, scrollY: a.height / 2 / a.zoom.value - st.point.y } });
    }
    store.open(id);
  };

  if (!open) return null;
  const row = (t: Thread, lost = false) => {
    const st = resolveAnchor(t.anchor, view.map);
    const isOpen = expanded === t.id;
    return (
      <motion.div layout="position" key={t.id} className="ditem-wrap" data-ditem={t.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }} transition={SPRING}>
        <button className="ditem" data-active={t.id === activeId || isOpen} onClick={() => (lost ? setExpanded(isOpen ? null : t.id) : focus(t.id))} aria-expanded={t.resolved || lost ? isOpen : undefined}>
          <span className="ditem-pin" data-resolved={t.resolved} data-lost={lost || undefined}>
            {lost ? <i className="ditem-warn" data-open={!t.resolved || undefined} /> : t.resolved ? <IconCheck size={12} /> : t.n}
          </span>
          <span className="ditem-main">
            <span className="ditem-meta">
              {lost && <b className="ditem-n">#{t.n}</b>}
              <AnchorTag names={st.names} />
              <time>{ago(t.messages.at(-1)!.at)}</time>
            </span>
            <span className="ditem-text">{t.messages[0].text}</span>
            <span className="ditem-foot">
              {t.messages.length > 1 && <span>{t.messages.length - 1} 条回复</span>}
              {t.agent === "running" && <span><i className="dot" data-tone="ok" />Agent 处理中</span>}
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
  return (
    <aside className="drawer" aria-label={`「${title}」的评论`} onPointerDown={(e) => e.stopPropagation()}>
      <header className="drawer-head">
        <h2 className="drawer-title" title={title}>{title}<span> 的评论</span></h2>
        <button className="icon-btn muted" onClick={onClose} aria-label="收起评论列表" title="收起"><IconClose size={16} /></button>
      </header>
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
            {tab === "open" ? <span>没有进行中的评论。<br />按 C，再点一个元素钉一条。</span> : <span>还没有已解决的评论。</span>}
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
