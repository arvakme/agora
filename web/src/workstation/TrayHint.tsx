// 图外文件提示补节点 (web/docs/workstation.md「新想法」): inside the 图外 tray, one line when agents wrote
// more than two files in a folder the diagram does not show (./unmapped.ts) —「server/cache/ 有 3 个新
// 文件，要画进图里吗？」. Clicking copies the suggestion with its file list, to paste into a comment or
// a session; it never changes the diagram. Mount it inside the tray (Overlay).
import { useMemo, useState } from "react";
import { IconCopy } from "../app/icons";
import type { Locate } from "./place";
import { useRuns } from "./runs/store";
import { drawInHints } from "./unmapped";
import "./TrayHint.css";

export function TrayHint({ locate }: { locate: Locate }) {
  const runs = useRuns();
  const hints = useMemo(() => drawInHints(runs.flat.map((f) => f.run), locate), [runs, locate]);
  const [note, setNote] = useState<string | null>(null);
  if (!hints.length) return null;
  const h = hints[0];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${h.text}\n${h.files.map((f) => `- ${f}`).join("\n")}`);
      setNote("已复制，可以贴进评论或会话");
    } catch {
      setNote("没能复制（浏览器不让）");
    }
    setTimeout(() => setNote(null), 1800);
  };
  return (
    <button className="ws-tray-hint" title={h.files.join("\n")} onPointerDown={(e) => e.stopPropagation()} onClick={() => void copy()}>
      <IconCopy size={12} />
      <span>{note ?? h.text}</span>
      {!note && hints.length > 1 && <em>+{hints.length - 1}</em>}
    </button>
  );
}
