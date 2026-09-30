// On the canvas whose elements 标出改动 is holding an outline on: 「已标出 · 再点取消」, and the note is the way back.
import { IconTarget } from "../app/icons";
import { highlight, usePinnedHighlight } from "./ui";
import "./stepActs.css";

export function HighlightNote({ canvasId }: { canvasId: string }) {
  const pinned = usePinnedHighlight();
  if (pinned?.canvasId !== canvasId) return null;
  return (
    <button className="hl-note" onClick={() => highlight.unpin()} title="取消标出" aria-label="已标出 · 再点取消">
      <IconTarget size={14} />
      已标出 · 再点取消
    </button>
  );
}
