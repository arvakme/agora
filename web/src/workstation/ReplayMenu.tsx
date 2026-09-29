// 「▶ PR 回放」 (web/docs/workstation.md「PR 回放」): the strip's button and the list it opens — one row
// per merged PR (number, title, author, date, commits, files, where the commits come from), and on top
// 「连播最近 N 个」: the latest N one after another, earliest merged first. Mounted in the strip (./Timeline.tsx).
import { useEffect, useRef, useState } from "react";
import { IconPlay } from "../app/icons";
import { replays, useReplays } from "./replayMode";
import { countOf } from "./replay";
import "./replay.css";

const day = (iso: string) => (iso ? iso.slice(0, 10) : "");
const SERIES = [3, 5, 10];

export function ReplayButton({ canvasId, quiet = false }: { canvasId?: string; quiet?: boolean }) {
  const st = useReplays();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ right: number; bottom: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => replays.load(), []);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".ws-pr-list, .ws-pr-btn")) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    addEventListener("pointerdown", off, true);
    addEventListener("keydown", key, true);
    return () => (removeEventListener("pointerdown", off, true), removeEventListener("keydown", key, true));
  }, [open]);
  const items = st.items ?? [];
  if (!items.length || st.id) return null;
  const list = [...items].reverse(); // newest first
  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ right: Math.max(8, innerWidth - r.right), bottom: innerHeight - r.top + 6 });
    setOpen((o) => !o);
  };
  const go = (f: () => void) => (setOpen(false), f());
  const counts = SERIES.filter((n) => n < items.length);
  return (
    <>
      <button ref={btn} className="ws-pr-btn" data-quiet={quiet || undefined} onClick={toggle} aria-haspopup="dialog" aria-expanded={open} title="按 git 提交回放一个已合并的 PR">
        <IconPlay size={14} />
        PR 回放
      </button>
      {open && at && (
        <div className="ws-pr-list" role="dialog" aria-label="PR 回放" style={{ right: at.right, bottom: at.bottom }}>
          <header>
            <b>PR 回放</b>
            <span>按 git 提交生成，不是 agent 的真实操作</span>
          </header>
          <div className="ws-pr-series">
            <span>连播最近</span>
            {[...counts, items.length].map((n, i) => (
              <button key={n} onClick={() => go(() => replays.playLatest(n, canvasId))}>{i === counts.length && counts.length ? `全部 ${n}` : n} 个</button>
            ))}
          </div>
          <ul>
            {list.map((x) => (
              <li key={x.id}>
                <button onClick={() => go(() => replays.open(x.id, canvasId))}>
                  <span className="n">#{x.number}</span>
                  <span className="t">{x.title}</span>
                  <span className="m">
                    {x.author} · {day(x.mergedAt)} · {countOf(x.commits)} 个提交 · {countOf(x.files)} 个文件 · {x.source}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
