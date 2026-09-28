// Pins over one canvas + the thread card / composer anchored to them.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import { resolveAnchor } from "../canvas/anchors";
import { layoutPins, sceneBlocks } from "./pinLayout";
import { IconCheck, IconClose, IconHint, IconPlus } from "../app/icons";
import { useThreads, type Anchor, type ThreadStore } from "./threads";
import type { CanvasViewState } from "../canvas/CanvasView";
import { Composer, ThreadCard } from "./ThreadCard";
import { Aim, snap } from "./Aim";
import { dismissUndo, runUndo, useUndo } from "./undo";
import { SPRING } from "./motion";

/** An unsent comment: where it is pinned and what has been typed so far. */
export type Draft = { anchor: Anchor; text: string };
const CARD_W = 320;
const DOCK_CLEAR = 76;
export type CardPos = { left: number; top?: number; bottom?: number; maxH: number; flip: boolean; up: boolean };

type Props = {
  api: ExcalidrawImperativeAPI;
  store: ThreadStore;
  view: CanvasViewState;
  mode: "browse" | "comment";
  draft: Draft | null;
  setDraft: (d: Draft | null) => void;
  onCreated: () => void;
};

export function CommentLayer({ api, store, view, mode, draft, setDraft, onCreated }: Props) {
  const { threads: list, activeId } = useThreads(store);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [miss, setMiss] = useState<{ x: number; y: number; k: number } | null>(null);
  const leaveTimer = useRef(0);
  const layer = useRef<HTMLDivElement>(null);
  const a = view.appState;
  const W = a.width, H = a.height;
  const toScreen = (p: { x: number; y: number }) => ({ x: (p.x + a.scrollX) * a.zoom.value, y: (p.y + a.scrollY) * a.zoom.value });
  // Cards open beside the pin; pins in the lower half open upward so the card clears the dock.
  const cardPos = (p: { x: number; y: number }): CardPos => {
    const flip = p.x + 28 + CARD_W > W - 8 && p.x - CARD_W - 12 > 8;
    // Neither side fits (narrow pane): stay inside the pane.
    const left = Math.max(8, Math.min(flip ? p.x - CARD_W - 12 : p.x + 28, W - CARD_W - 8));
    if (p.y > H * 0.5) {
      const bottom = Math.max(DOCK_CLEAR, H - p.y - 6);
      return { left, bottom, maxH: H - bottom - 12, flip, up: true };
    }
    const top = Math.max(8, p.y - 34);
    return { left, top, maxH: H - top - DOCK_CLEAR, flip, up: false };
  };
  const hover = (id: string | null) => {
    clearTimeout(leaveTimer.current);
    if (id) setHoverId(id);
    else leaveTimer.current = window.setTimeout(() => setHoverId(null), 140);
  };

  const blocks = useMemo(() => sceneBlocks(view), [view.elements, view.map, a.scrollX, a.scrollY, a.zoom.value]);
  const { pins, landing } = layoutPins(list, view, blocks);
  const resolved = pins.map((r) => ({ ...r, p: { x: snap(r.p.x), y: snap(r.p.y) } }));
  const shownId = activeId ?? hoverId;
  const shown = resolved.find((r) => r.t.id === shownId);

  return (
    <div className="comment-layer" ref={layer}>
      {mode === "comment" && (
        <Aim
          view={view}
          landing={landing}
          onMiss={(at) => setMiss({ ...at, k: Date.now() })}
          onPick={(anchor) => {
            store.close();
            setDraft({ anchor, text: "" });
          }}
        />
      )}
      {miss && (
        <div key={miss.k} className="miss" style={{ left: miss.x, top: miss.y }} onAnimationEnd={() => setMiss(null)}>
          点在一个元素上
        </div>
      )}
      {resolved.map(({ t, st, p }) => {
        return (
          <button
            key={t.id}
            className="pin"
            data-active={t.id === activeId}
            data-resolved={t.resolved}
            data-status={st.status}
            data-running={t.agent === "running"}
            style={{ transform: `translate3d(${p.x}px, ${p.y}px, 0)` }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerEnter={() => hover(t.id)}
            onPointerLeave={() => hover(null)}
            onClick={() => store.open(t.id)}
            aria-label={`线程 ${t.n}${t.resolved ? "（已解决）" : ""}${st.status === "lost" ? "（锚点已失效）" : ""}`}
          >
            <span className="pin-body">
              {st.status === "lost" ? <IconHint size={14} /> : t.resolved ? <IconCheck size={14} /> : t.n}
            </span>
            {t.agent === "running" && <span className="pin-orbit" />}
          </button>
        );
      })}
      <AnimatePresence>
        {shown && !draft && (
          <ThreadCard
            key={shown.t.id}
            t={shown.t}
            st={shown.st}
            mode={shown.t.id === activeId ? "full" : "preview"}
            api={api}
            store={store}
            pos={cardPos(shown.p)}
            onHover={(inside) => shown.t.id !== activeId && hover(inside ? shown.t.id : null)}
          />
        )}
      </AnimatePresence>
      {draft && <DraftPin at={landing(draft.anchor)} />}
      <AnimatePresence>
        {draft && (
          <Composer
            key="composer"
            names={resolveAnchor(draft.anchor, view.map).names}
            pos={cardPos(landing(draft.anchor))}
            text={draft.text}
            onText={(text) => setDraft({ ...draft, text })}
            onCancel={() => setDraft(null)}
            onSubmit={(text) => {
              store.create(draft.anchor, text);
              setDraft(null);
              onCreated();
            }}
          />
        )}
      </AnimatePresence>
      <UndoToast canvasId={store.canvasId} />
    </div>
  );
}

function DraftPin({ at }: { at: { x: number; y: number } }) {
  return (
    <div className="pin draft" style={{ transform: `translate3d(${snap(at.x)}px, ${snap(at.y)}px, 0)` }}>
      <span className="pin-body"><IconPlus size={14} /></span>
    </div>
  );
}

/** "已删除… · 撤销" for the last deletion on this canvas. */
function UndoToast({ canvasId }: { canvasId: string }) {
  const u = useUndo();
  return (
    <AnimatePresence>
      {u && u.canvasId === canvasId && (
        <motion.div key={u.key} className="toast undo-toast" role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }} transition={SPRING}>
          <span>{u.label}</span>
          <button className="btn sm ghost" onClick={runUndo}>撤销</button>
          <button className="icon-btn sm muted" aria-label="关闭提示" onClick={dismissUndo}><IconClose size={14} /></button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
