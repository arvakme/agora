// 进行中的一轮 in the conversation (activityCard.ts has the model): 简洁 — the agent's words, then one card with the action in progress and what is
// done so far, click to open the whole list; 详细 — the row per tool call, as it always was. A finished turn is the ordinary fold either way. Failed
// calls stay outside the card; the approvals and questions are the cards above the composer (RequestCards), the undo of a canvas change is on its row.
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { IconChevron } from "../app/icons";
import { useTick } from "../workstation/clock";
import { Markdown } from "./markdown";
import { ProcessFold, ToolRow } from "./TrajectoryView";
import { fmtDuration, type TrajTurn } from "./trajectoryModel";
import { activityModel, keepOpen, processMode, wasKeptOpen, type ProcessMode } from "./activityCard";
import "./activityCard.css";
import { tr } from "../i18n";

export const useProcessMode = (sessionId: string) => useSyncExternalStore(processMode.subscribe, () => processMode.get(sessionId));

const FAILED_SHOWN = 3;

/** One turn's process in the conversation, by the session's 过程 choice. */
export function ProcessBlock({ sessionId, turn, waiting }: { sessionId: string; turn: TrajTurn; waiting: boolean }) {
  const mode = useProcessMode(sessionId);
  return mode === "brief" && turn.running ? <ActivityCard sessionId={sessionId} turn={turn} waiting={waiting} /> : <KeptFold sessionId={sessionId} turn={turn} />;
}

/**
 * The finished turn's fold. One the person had the card open on opens again when the turn ends and stays as they leave it (ProcessFold keeps its own state, so
 * this reads it from the button: the click that toggles it tells what it will become).
 */
function KeptFold({ sessionId, turn }: { sessionId: string; turn: TrajTurn }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!turn.running && wasKeptOpen(sessionId, turn.n)) box.current?.querySelector<HTMLButtonElement>(".ds-process-line")?.click();
  }, []);
  const remember = (e: MouseEvent) => {
    const line = (e.target as HTMLElement).closest<HTMLButtonElement>(".ds-process-line");
    if (line && !line.disabled) keepOpen(sessionId, turn.n, line.getAttribute("aria-expanded") !== "true");
  };
  return (
    <div ref={box} style={{ display: "contents" }} onClickCapture={remember}>
      <ProcessFold sessionId={sessionId} turn={turn} />
    </div>
  );
}

function ActivityCard({ sessionId, turn, waiting }: { sessionId: string; turn: TrajTurn; waiting: boolean }) {
  const m = activityModel(turn, { waiting });
  const now = useTick(1000);
  const [open, setOpen] = useState(() => wasKeptOpen(sessionId, turn.n));
  const [follow, setFollow] = useState(true);
  const [tools, setTools] = useState<Record<string, boolean>>({});
  const list = useRef<HTMLDivElement>(null);
  const records = turn.steps.filter((s) => s.n > 0).flatMap((s) => s.records);
  useLayoutEffect(() => {
    if (open && follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [open, follow, records.length]);
  const toggle = () => (keepOpen(sessionId, turn.n, !open), setOpen(!open));
  const toggleTool = (id: string) => setTools((t) => ({ ...t, [id]: !t[id] }));
  const failed = m.failed.slice(-FAILED_SHOWN);
  const says = records.filter((r) => r.kind === "message");
  return (
    <div className="ds-act" data-open={open} data-wait={m.waiting || undefined}>
      {says.map((r) => (
        <Markdown key={r.id} className="ds-process-say" text={r.item.text ?? ""} />
      ))}
      {failed.length > 0 && (
        <div className="ds-act-failed" role="group" aria-label={tr("失败的动作", "Failed actions")}>
          {m.failed.length > failed.length && <p className="ds-act-more">{tr(`还有 ${m.failed.length - failed.length} 个失败的动作在完整列表里`, `${m.failed.length - failed.length} more failed action${m.failed.length - failed.length === 1 ? "" : "s"} in the full list`)}</p>}
          {failed.map((r) => (
            <ToolRow key={r.id} sessionId={sessionId} item={r.item} open={!!tools[r.id]} onToggle={() => toggleTool(r.id)} />
          ))}
        </div>
      )}
      <section className="ds-act-card" aria-label={tr("这一轮正在做什么", "What this turn is doing")}>
        <button className="ds-act-head" onClick={toggle} aria-expanded={open} title={open ? tr("收起，只看当前动作", "Collapse to the current action") : tr("展开，看每一个动作", "Expand to see every action")}>
          <span className="ds-act-spin" aria-hidden />
          <b>{m.title}</b>
          <time>{fmtDuration(now - turn.startedAt)}</time>
          <IconChevron open={open} />
        </button>
        {open ? (
          <>
            <div className="ds-act-list" ref={list}>
              {records.map((r, i) =>
                r.kind === "message" ? (
                  <Markdown key={r.id} className="ds-process-say" text={r.item.text ?? ""} />
                ) : (
                  <div key={r.id} className="ds-act-item" data-latest={i === records.length - 1 || undefined}>
                    <ToolRow sessionId={sessionId} item={r.item} open={!!tools[r.id]} onToggle={() => toggleTool(r.id)} />
                  </div>
                ),
              )}
            </div>
            <div className="ds-act-foot">
              <span>{m.stats}</span>
              <button className="ds-text-btn" aria-pressed={follow} onClick={() => setFollow(!follow)} title={tr("新的动作出现时，列表自己滚到底", "Scroll to the bottom when a new action appears")}>
                {tr("自动滚到底", "Auto-scroll")}{follow ? tr("：开", ": on") : tr("：关", ": off")}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="ds-act-now" title={m.now}>
              <span className="ds-act-dot" aria-hidden />
              <code>{m.now}</code>
            </div>
            <p className="ds-act-stats">{m.stats}</p>
          </>
        )}
      </section>
    </div>
  );
}

/** Above the composer while the agent works: what it does right now, for how long, and 停止 (the same interrupt as the composer's). */
export function LiveBar({ text, since, waiting, onStop }: { text: string; since: number | null; waiting: boolean; onStop?: () => void }) {
  const now = useTick(1000, since != null);
  return (
    <div className="sp-livebar" role="status" data-wait={waiting || undefined}>
      <span className="ds-act-spin" aria-hidden />
      <span className="sp-livebar-text" title={text}>{text}</span>
      {since != null && <time>{fmtDuration(Math.max(0, now - since))}</time>}
      {onStop && (
        <button className="sp-livebar-stop" onClick={onStop} title={tr("打断这一轮", "Interrupt this turn")}>
          ■ {tr("停止", "Stop")}
        </button>
      )}
    </div>
  );
}

export const PROCESS_CHOICES: [ProcessMode, string, string][] = [
  ["brief", tr("简洁", "Brief"), tr("进行中的一轮只显示一张卡：当前动作和已完成几个；点开看每一个动作", "A running turn shows one card: the current action and how many are done; open it to see every action")],
  ["detail", tr("详细", "Detailed"), tr("进行中逐条列出每个动作，和以前一样", "A running turn lists every action, one by one, as before")],
];

/** 「过程：简洁 / 详细」 in the session panel's ⋯ menu: this session, this browser. */
export function ProcessChoice({ sessionId }: { sessionId: string }) {
  const mode = useProcessMode(sessionId);
  return (
    <div className="seg vm-seg process-choice" role="radiogroup" aria-label={tr("过程怎么显示", "How the process is shown")}>
      {PROCESS_CHOICES.map(([k, label, tip]) => (
        <button key={k} role="radio" aria-checked={mode === k} data-on={mode === k} title={tr(`${tip}。只影响这个会话，只在这个浏览器里记住`, `${tip}. Only this session, remembered in this browser only`)} onClick={() => processMode.set(sessionId, k)}>
          {label}
        </button>
      ))}
    </div>
  );
}
