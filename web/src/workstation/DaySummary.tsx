// 今日小结 (web/docs/workstation.md「新想法」): today's numbers, from the runs alone (./summary.ts) —
// agents, walks between nodes, files written, commands run, how long someone waited on you, the
// busiest node — up to the time shown (the playhead in a replay). Line style, purple marks. The
// timeline shows it while the pointer is over the strip's count: pass that element as `anchor`; the
// card sits above it, right-aligned (a portal, so no pane clips it). Not interactive.
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconCode, IconMessage, IconPath, IconTarget, IconTerminal, IconUser } from "../app/icons";
import { hhmmss } from "./axis";
import { useReplayAt } from "./clock";
import { canvasWhere } from "./place";
import { useRuns } from "./runs/store";
import { summarize } from "./summary";
import "./DaySummary.css";

const span = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分${s % 60 ? ` ${s % 60} 秒` : "钟"}` : `${Math.floor(s / 3600)} 小时 ${Math.round((s % 3600) / 60)} 分`;
};

export function DaySummary({ canvasId, anchor }: { canvasId: string; anchor: HTMLElement }) {
  const runs = useRuns();
  const replayAt = useReplayAt();
  const t = replayAt ?? runs.at;
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    setPos({ right: Math.max(8, innerWidth - r.right), bottom: innerHeight - r.top + 8 });
  }, [anchor]);
  const where = canvasWhere.get(canvasId);
  if (!where) return null;
  const s = summarize(runs.flat.map((f) => f.run), where.ctx, new Date(t).setHours(0, 0, 0, 0), t);
  const row = (icon: React.ReactNode, text: React.ReactNode, k?: string) => (
    <li data-k={k}>
      {icon}
      <span>{text}</span>
    </li>
  );
  return createPortal(
    <div className="ws-day" role="status" aria-label="今日小结" style={pos ?? { visibility: "hidden" }}>
      <p className="ws-day-h">
        <b>今日小结</b>
        <span>{replayAt != null ? `回放到 ${hhmmss(t)}` : `截至 ${hhmmss(t).slice(0, 5)}`}</span>
      </p>
      {s.agents === 0 ? (
        <p className="ws-day-none">今天还没有动静</p>
      ) : (
        <ul>
          {row(<IconUser size={14} />, <><b>{s.agents}</b> 个 agent{s.subs ? `，其中 ${s.subs} 个子代理` : ""}</>)}
          {row(<IconPath size={14} />, <>走了 <b>{s.steps}</b> 步</>)}
          {row(<IconCode size={14} />, <>改了 <b>{s.files}</b> 个文件</>)}
          {row(<IconTerminal size={14} />, <>跑了 <b>{s.commands}</b> 次命令</>)}
          {row(<IconMessage size={14} />, s.waited ? <>等了你 <b>{span(s.waited)}</b></> : "没让你等", s.waited ? "wait" : undefined)}
          {s.busiest && row(<IconTarget size={14} />, <>最忙 <b className="ws-day-node">{where.label(s.busiest.place)}</b> · {span(s.busiest.ms)}</>, "busy")}
        </ul>
      )}
    </div>,
    document.body,
  );
}
