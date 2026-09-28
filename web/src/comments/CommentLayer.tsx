// Pins over one canvas + the thread card / composer anchored to them.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence } from "motion/react";
import { useRef, useState } from "react";
import { hitTest, resolveAnchor } from "../canvas/anchors";
import { IconCheck, IconHint, IconPlus } from "../app/icons";
import { bbox, isArrow } from "../canvas/scene";
import { useThreads, type Anchor, type ThreadStore } from "./threads";
import type { CanvasViewState } from "../canvas/CanvasView";
import { Composer, ThreadCard } from "./ThreadCard";

/** An unsent comment: where it is pinned and what has been typed so far. */
export type Draft = { anchor: Anchor; text: string };
const CARD_W = 320;
const DOCK_CLEAR = 76;
const PIN_STEP = 30;
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

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const r = layer.current!.getBoundingClientRect();
    const sx = (e.clientX - r.left) / a.zoom.value - a.scrollX;
    const sy = (e.clientY - r.top) / a.zoom.value - a.scrollY;
    const hit = hitTest(view.elements, sx, sy, a.zoom.value);
    if (!hit) return setMiss({ x: e.clientX - r.left, y: e.clientY - r.top, k: Date.now() });
    const b = bbox(hit);
    const rel = isArrow(hit)
      ? { x: 0.5, y: 0.5 }
      : { x: clamp01((sx - b.x) / (b.width || 1)), y: clamp01((sy - b.y) / (b.height || 1)) };
    store.close();
    setDraft({ anchor: { ids: [hit.id], rel, last: { x: sx, y: sy } }, text: "" });
  };

  // Several threads on one box share its corner: fan them out to the right instead of stacking.
  const taken = new Map<string, number>();
  const resolved = list.map((t) => {
    const st = resolveAnchor(t.anchor, view.map);
    const key = `${Math.round(st.point.x)},${Math.round(st.point.y)}`;
    const k = taken.get(key) ?? 0;
    taken.set(key, k + 1);
    return { t, st, p: { x: toScreen(st.point).x + k * PIN_STEP, y: toScreen(st.point).y } };
  });
  const shownId = activeId ?? hoverId;
  const shown = resolved.find((r) => r.t.id === shownId);

  return (
    <div className="comment-layer" ref={layer}>
      {mode === "comment" && <div className="capture" onPointerDown={onPointerDown} />}
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
      {draft && <DraftPin draft={draft} view={view} toScreen={toScreen} />}
      <AnimatePresence>
        {draft && (
          <Composer
            key="composer"
            names={resolveAnchor(draft.anchor, view.map).names}
            pos={cardPos(toScreen(resolveAnchor(draft.anchor, view.map).point))}
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
    </div>
  );
}

function DraftPin({ draft, view, toScreen }: { draft: Draft; view: CanvasViewState; toScreen: (p: { x: number; y: number }) => { x: number; y: number } }) {
  const p = toScreen(resolveAnchor(draft.anchor, view.map).point);
  return (
    <div className="pin draft" style={{ transform: `translate3d(${p.x}px, ${p.y}px, 0)` }}>
      <span className="pin-body"><IconPlus size={14} /></span>
    </div>
  );
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
