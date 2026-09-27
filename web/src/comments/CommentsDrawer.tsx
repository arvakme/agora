// "所有评论" for one canvas: a flush column beside the drawing (D13), open/resolved lists; picking a
// thread pans to its pin (if it is off screen) and opens it.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { resolveAnchor } from "../canvas/anchors";
import type { CanvasViewState } from "../canvas/CanvasView";
import { IconCheck, IconClose, IconHint } from "../app/icons";
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
    // The column sits beside the canvas now, so the whole canvas is visible: pan only when the pin is off it.
    if (sx < 40 || sy < 40 || sx > a.width - 40 || sy > a.height - 80) {
      api.updateScene({ appState: { scrollX: a.width / 2 / a.zoom.value - st.point.x, scrollY: a.height / 2 / a.zoom.value - st.point.y } });
    }
    store.open(id);
  };

  if (!open) return null;
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
              <em>{counts[k]}</em>
            </button>
          ))}
        </div>
      </div>
      <div className="drawer-list">
        <AnimatePresence initial={false} mode="popLayout">
          {shown.map((t) => {
            const st = resolveAnchor(t.anchor, view.map);
            return (
              <motion.button
                layout="position"
                key={t.id}
                className="ditem"
                data-active={t.id === activeId}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.12 } }}
                transition={SPRING}
                onClick={() => focus(t.id)}
              >
                <span className="ditem-pin" data-resolved={t.resolved} data-status={st.status}>
                  {st.status === "lost" ? <IconHint size={12} /> : t.resolved ? <IconCheck size={12} /> : t.n}
                </span>
                <span className="ditem-main">
                  <span className="ditem-meta">
                    <AnchorTag names={st.names} />
                    <time>{ago(t.messages.at(-1)!.at)}</time>
                  </span>
                  <span className="ditem-text">{t.messages[0].text}</span>
                  <span className="ditem-foot">
                    {t.messages.length > 1 && <span>{t.messages.length - 1} 条回复</span>}
                    {t.agent === "running" && <span><i className="dot" data-tone="ok" />Agent 处理中</span>}
                    {st.status !== "ok" && <span className="warn">锚点已失效</span>}
                  </span>
                </span>
              </motion.button>
            );
          })}
        </AnimatePresence>
        {!shown.length && (
          <div className="drawer-empty">
            <span className="dither-field" aria-hidden />
            {tab === "open" ? <span>没有进行中的评论。<br />按 C，再点一个元素钉一条。</span> : <span>还没有已解决的评论。</span>}
          </div>
        )}
      </div>
    </aside>
  );
}
