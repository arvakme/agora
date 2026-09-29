// Comments on the whole canvas — pinned to nothing (web/docs/share-build-replay.md §7): a button in the canvas's lower right corner
// opens the list of them and a box to write one; picking one shows its card next to the button, like a pin's card. The same for the
// owner and a share guest. A comment made while watching the build replay carries its moment (./MomentChip.tsx).
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { AnchorState } from "../canvas/anchors";
import { IconClose, IconComment, IconPlus } from "../app/icons";
import { GUEST } from "../guest/mode";
import { handOff } from "../ops/agent";
import type { CardPos } from "./CommentLayer";
import { threadAuthorName } from "./authorColor";
import { routeMessage } from "./mention";
import { MomentChip } from "./MomentChip";
import { SPRING } from "./motion";
import { ago, Composer, ThreadCard } from "./ThreadCard";
import { useThreads, type Thread, type ThreadStore } from "./threads";
import "./whole.css";

const WHOLE: AnchorState = { point: { x: 0, y: 0 }, names: [], status: "whole" };
/** Above the corner button, clear of the dock. */
const CARD_BOTTOM = 56;
const CARD_W = 320;

export const isWhole = (t: Thread) => !t.anchor && !t.deleted && t.messages.some((m) => !m.deleted);

export function WholeCanvas({ api, store, width, height }: { api: ExcalidrawImperativeAPI; store: ThreadStore; width: number; height: number }) {
  const { threads, activeId } = useThreads(store);
  const whole = threads.filter(isWhole);
  const open = whole.filter((t) => !t.resolved);
  const done = whole.filter((t) => t.resolved);
  const active = whole.find((t) => t.id === activeId);
  const [panel, setPanel] = useState<null | "list" | "write">(null);
  const [text, setText] = useState("");
  // a thread picked (here or in the comment list) shows as its card; the list steps aside
  useEffect(() => void (active && setPanel(null)), [active?.id]);
  useEffect(() => {
    if (!panel) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (setPanel(null), setText(""));
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [panel]);
  const pos: CardPos = { left: Math.max(8, width - CARD_W - 12), bottom: CARD_BOTTOM, maxH: Math.max(160, height - CARD_BOTTOM - 12), flip: true, up: true };
  const submit = (v: string, mention: Parameters<typeof routeMessage>[0]["mention"]) => {
    const t = store.create(null, v);
    const route = routeMessage({ guest: GUEST, mention, handoff: undefined });
    if (route.kind === "hand") void handOff(api, store, t.id, route.to, { bound: false, ...(mention?.type === "session" && { name: mention.label }), ...(mention && { mention: mention.label }) });
    setPanel(null);
    setText("");
  };
  return (
    <div className="whole" onPointerDown={(e) => e.stopPropagation()}>
      <button className="whole-btn" data-on={panel !== null || !!active} aria-expanded={panel !== null} onClick={() => (store.close(), setPanel(panel ? null : "list"))} title="评论整张图：不钉在元素上">
        <IconComment size={16} />
        <span>整张图</span>
        {open.length > 0 && <em>{open.length}</em>}
      </button>
      <AnimatePresence>
        {panel === "list" && (
          <motion.section key="list" className="whole-panel" aria-label="整张图的评论" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }} transition={SPRING}>
            <header>
              <h2>整张图的评论</h2>
              <button className="icon-btn sm muted" onClick={() => setPanel(null)} aria-label="关闭" title="关闭（Esc）"><IconClose size={16} /></button>
            </header>
            <div className="whole-list">
              {[...open, ...done].map((t) => (
                <button key={t.id} className="whole-row" data-resolved={t.resolved || undefined} onClick={() => store.open(t.id)}>
                  <span className="whole-row-meta">
                    <b>{threadAuthorName(t)}</b>
                    <time>{ago(t.messages.at(-1)!.at)}</time>
                    {t.resolved && <span>已解决</span>}
                  </span>
                  <span className="whole-row-text">{t.messages.find((m) => !m.deleted)?.text}</span>
                  <span className="whole-row-foot">
                    {t.messages.length > 1 && <span>{t.messages.length - 1} 条回复</span>}
                    <MomentChip t={t} canvasId={store.canvasId} />
                  </span>
                </button>
              ))}
              {!whole.length && <p className="whole-empty">还没有人评论整张图。</p>}
            </div>
            <button className="btn sm primary whole-write" onClick={() => setPanel("write")}><IconPlus size={14} />写一条</button>
          </motion.section>
        )}
        {panel === "write" && (
          <Composer key="write" canvasId={store.canvasId} pos={pos} text={text} onText={setText} onCancel={() => (setPanel(null), setText(""))} onSubmit={submit} />
        )}
        {active && (
          <ThreadCard key={active.id} t={active} st={WHOLE} mode="full" api={api} store={store} pos={pos} />
        )}
      </AnimatePresence>
    </div>
  );
}
