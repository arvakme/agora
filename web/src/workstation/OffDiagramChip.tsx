// 图外 as a state, not a place: a worker never walks out of the diagram for a file no node claims, it writes it where it
// stands. This chip, fixed to the corner of the canvas (not to the world, so it never shrinks or wraps with the zoom), says
// that some files were written out there and lists them on a tap. Mount it in the overlay; it takes no part in the camera.
import { useMemo, useState } from "react";
import { tr } from "../i18n";
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
        <ul className="ws-off-list" aria-label={tr("图外的文件", "Files off the diagram")}>
          {files.slice(0, LISTED).map((f) => (
            <li key={f} title={f}>{f}</li>
          ))}
          {files.length > LISTED && <li className="ws-off-more">{tr(`还有 ${files.length - LISTED} 个`, `${files.length - LISTED} more`)}</li>}
        </ul>
      )}
      <button className="ws-off-chip" aria-expanded={open} title={tr("这些文件不在这张图上，agent 在原地改了它们", "These files aren't on this diagram; the agent edited them in place")} onClick={() => setOpen(!open)}>
        {tr(`图外 · 改了 ${files.length} 个文件`, `Off the diagram · ${files.length} ${files.length === 1 ? "file" : "files"} changed`)}
      </button>
    </div>
  );
}
