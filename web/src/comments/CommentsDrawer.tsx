// "所有评论" drawer for one canvas: open/resolved lists; picking a thread pans to its pin and opens it.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { resolveAnchor } from "../canvas/anchors";
import type { CanvasViewState } from "../canvas/CanvasView";
import { IconAlert, IconCheck, IconClose, IconSpark } from "../app/icons";
import { useThreads, type ThreadStore } from "./threads";
import { SPRING } from "./motion";
import { AnchorTag } from "./AnchorTag";
import { ago } from "./ThreadCard";

export function CommentsDrawer({ title, api, store, view, open, onClose }: {
  title: string;
  api: ExcalidrawImperativeAPI;
  store: ThreadStore;
  view: CanvasViewState;
  open: boolean;
  onClose: () => void;
}) {
  const { threads, activeId } = useThreads(store);
  const [tab, setTab] = useState<"open" | "resolved">("open");
  const shown = threads.filter((t) => (tab === "open" ? !t.resolved : t.resolved));
  const counts = { open: threads.filter((t) => !t.resolved).length, resolved: threads.filter((t) => t.resolved).length };

  const focus = (id: string) => {
    const t = store.thread(id)!;
    const st = resolveAnchor(t.anchor, view.map);
    const a = view.appState;
    const sx = (st.point.x + a.scrollX) * a.zoom.value, sy = (st.point.y + a.scrollY) * a.zoom.value;
    // Pan only when the pin is outside the visible part of the canvas (left of the drawer).
    if (sx < 40 || sy < 40 || sx > a.width - 360 || sy > a.height - 80) {
      api.updateScene({ appState: { scrollX: (a.width - 320) / 2 / a.zoom.value - st.point.x, scrollY: a.height / 2 / a.zoom.value - st.point.y } });
    }
    store.open(id);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          className="drawer"
          initial={{ x: 24, opacity: 0, scale: 0.98 }}
          animate={{ x: 0, opacity: 1, scale: 1 }}
          exit={{ x: 24, opacity: 0, scale: 0.98, transition: { duration: 0.16 } }}
          transition={SPRING}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="drawer-title">{title}<span>的评论</span></div>
          <header className="drawer-head">
            <div className="seg" role="tablist">
              {(["open", "resolved"] as const).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} data-on={tab === k} onClick={() => setTab(k)}>
                  {tab === k && <motion.span layoutId={`seg-${view.id}`} className="seg-bg" transition={SPRING} />}
                  <span>{k === "open" ? "进行中" : "已解决"}</span>
                  <em>{counts[k]}</em>
                </button>
              ))}
            </div>
            <button className="tbtn" onClick={onClose} aria-label="收起评论列表"><IconClose size={15} /></button>
          </header>
          <div className="drawer-list">
            <AnimatePresence initial={false} mode="popLayout">
              {shown.map((t) => {
                const st = resolveAnchor(t.anchor, view.map);
                return (
                  <motion.button
                    layout
                    key={t.id}
                    className="ditem"
                    data-active={t.id === activeId}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14 } }}
                    transition={SPRING}
                    onClick={() => focus(t.id)}
                  >
                    <span className="ditem-pin" data-resolved={t.resolved} data-status={st.status}>
                      {st.status === "lost" ? <IconAlert size={11} /> : t.resolved ? <IconCheck size={11} /> : t.n}
                    </span>
                    <span className="ditem-main">
                      <span className="ditem-meta">
                        <b><AnchorTag names={st.names} /></b>
                        <time>{ago(t.messages.at(-1)!.at)}</time>
                      </span>
                      <span className="ditem-text">{t.messages[0].text}</span>
                      <span className="ditem-foot">
                        {t.messages.length > 1 && <span>{t.messages.length - 1} 条回复</span>}
                        {t.agent === "running" && <span className="agent"><IconSpark size={11} /> 处理中</span>}
                        {st.status !== "ok" && <span className="warn">锚点已失效</span>}
                      </span>
                    </span>
                  </motion.button>
                );
              })}
            </AnimatePresence>
            {!shown.length && <p className="drawer-empty">{tab === "open" ? "没有进行中的评论。按 C 后点击元素钉一条。" : "还没有已解决的评论。"}</p>}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
