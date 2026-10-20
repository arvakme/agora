// On the canvas whose elements 标出改动 is holding an outline on: 「已标出 · 再点取消」, and the note is the way back.
import { IconTarget } from "../app/icons";
import { highlight, usePinnedHighlight } from "./ui";
import "./stepActs.css";
import { tr } from "../i18n";

export function HighlightNote({ canvasId }: { canvasId: string }) {
  const pinned = usePinnedHighlight();
  if (pinned?.canvasId !== canvasId) return null;
  return (
    <button className="hl-note" onClick={() => highlight.unpin()} title={tr("取消标出", "Clear highlight")} aria-label={tr("已标出 · 再点取消", "Highlighted · click again to clear")}>
      <IconTarget size={14} />
      {tr("已标出 · 再点取消", "Highlighted · click again to clear")}
    </button>
  );
}
