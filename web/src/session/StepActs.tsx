// The two buttons of a canvas change, drawn once for every place that has them (a step in the session, a reply in a
// comment thread): 撤销 / 重做 and 标出改动. An icon alone was read as 运行, so each says its word next to the icon
// (the word drops out when the row is narrow, the sentence stays in the tooltip and the accessible name); the words
// and the reason a button is off come from ./stepUi.ts.
import { IconTarget, IconUndo } from "../app/icons";
import { markView, undoView } from "./stepUi";
import "./stepActs.css";

/** 已撤销 — also used alone: a row keeps it in view while its buttons only show on hover. */
export function UndoStatus({ undone, canRedo }: { undone: boolean; canRedo: boolean }) {
  const v = undoView({ undone, canRedo, canAct: true });
  return v.status ? <span className="act-status" title={v.statusHint}>{v.status}</span> : null;
}

export function UndoButtons({ undone, canRedo, canAct, onUndo, onRedo }: { undone: boolean; canRedo: boolean; canAct: boolean; onUndo: () => void; onRedo: () => void }) {
  const b = undoView({ undone, canRedo, canAct }).button;
  return (
    <>
      <UndoStatus undone={undone} canRedo={canRedo} />
      {b && (
        <button className="act" data-kind={b.kind} disabled={b.disabled} onClick={b.kind === "undo" ? onUndo : onRedo} aria-label={b.hint} title={b.hint}>
          <span className="act-icon"><IconUndo size={14} /></span>
          <span className="act-label">{b.label}</span>
        </button>
      )}
    </>
  );
}

export function MarkButton({ touched, live, undone, on, onToggle }: { touched: readonly string[]; live: number | null; undone: boolean; on: boolean; onToggle: () => void }) {
  const v = markView({ touched, live, undone, on });
  return (
    <button className="act" data-kind="mark" data-on={v.pressed || undefined} disabled={v.disabled} aria-pressed={v.pressed} aria-label={v.hint} title={v.hint} onClick={onToggle}>
      <span className="act-icon"><IconTarget size={14} /></span>
      <span className="act-label">{v.label}</span>
    </button>
  );
}
