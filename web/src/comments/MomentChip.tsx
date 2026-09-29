// 「回放第 N 步」: a comment that was made while watching the build replay says which moment; a click goes back there
// (web/docs/share-build-replay.md §7). Owner and guest alike: the store opens the replay wherever this page has one.
// A span with the button role, not a button: it sits inside rows that are buttons themselves.
import { buildReplay } from "../buildreplay/store";
import { IconPlay } from "../app/icons";
import type { Thread } from "./threads";

export function MomentChip({ t, canvasId }: { t: Pick<Thread, "moment">; canvasId: string }) {
  if (!t.moment) return null;
  const step = t.moment.step;
  return (
    <span
      role="button"
      tabIndex={0}
      className="moment-chip"
      onClick={(e) => (e.stopPropagation(), buildReplay.open(canvasId, step))}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), e.stopPropagation(), buildReplay.open(canvasId, step))}
      onPointerDown={(e) => e.stopPropagation()}
      title="回到搭建回放里评论时看到的那一刻"
      aria-label={`回放里的第 ${step + 1} 步`}
    >
      <IconPlay size={12} />
      回放第 {step + 1} 步
    </span>
  );
}
