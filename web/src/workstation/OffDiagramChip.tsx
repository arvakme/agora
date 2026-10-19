// 图外 as a state, not a place: a worker never walks out of the diagram for a file no node claims, it writes it where it
// stands. This chip, fixed to the corner of the canvas (not to the world, so it never shrinks or wraps with the zoom), says
// that some files were written out there and lists them on a tap. Mount it in the overlay; it takes no part in the camera.
import { useMemo, useState } from "react";
import type { Locate } from "./place";
import { useRuns } from "./runs/store";
import { offDiagramFiles } from "./unmapped";
import "./OffDiagramChip.css";

/** Files listed before the rest is only counted. */
const LISTED = 8;

export function OffDiagramChip({ locate }: { locate: Locate }) {
  const runs = useRuns();
  const files = useMemo(() => offDiagramFiles(runs.flat.map((f) => f.run), locate), [runs, locate]);
  const [open, setOpen] = useState(false);
  if (!files.length) return null;
  return (
    <div className="ws-off" onPointerDown={(e) => e.stopPropagation()}>
      {open && (
        <ul className="ws-off-list" aria-label="图外的文件">
          {files.slice(0, LISTED).map((f) => (
            <li key={f} title={f}>{f}</li>
          ))}
          {files.length > LISTED && <li className="ws-off-more">还有 {files.length - LISTED} 个</li>}
        </ul>
      )}
      <button className="ws-off-chip" aria-expanded={open} title="这些文件不在这张图上，agent 在原地改了它们" onClick={() => setOpen(!open)}>
        图外 · 改了 {files.length} 个文件
      </button>
    </div>
  );
}
