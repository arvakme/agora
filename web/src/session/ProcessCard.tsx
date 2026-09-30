// 进行中的一轮 in the conversation (activityCard.ts has the model): 简洁 — the agent's words, then one card with the action in progress and what is
// done so far, click to open the whole list; 详细 — the row per tool call, as it always was. A finished turn is the ordinary fold either way. Failed
// calls stay outside the card; the approvals and questions are the cards above the composer (RequestCards), the undo of a canvas change is on its row.
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { IconChevron } from "../app/icons";
import { useTick } from "../workstation/clock";
import { ProcessFold, ToolRow } from "./TrajectoryView";
import { fmtDuration, type TrajTurn } from "./trajectoryModel";
import { activityModel, keepOpen, processMode, wasKeptOpen, type ProcessMode } from "./activityCard";
import "./activityCard.css";

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
        <p key={r.id} className="ds-process-say">{r.item.text}</p>
      ))}
      {failed.length > 0 && (
        <div className="ds-act-failed" role="group" aria-label="失败的动作">
          {m.failed.length > failed.length && <p className="ds-act-more">还有 {m.failed.length - failed.length} 个失败的动作在完整列表里</p>}
          {failed.map((r) => (
            <ToolRow key={r.id} sessionId={sessionId} item={r.item} open={!!tools[r.id]} onToggle={() => toggleTool(r.id)} />
          ))}
        </div>
      )}
      <section className="ds-act-card" aria-label="这一轮正在做什么">
        <button className="ds-act-head" onClick={toggle} aria-expanded={open} title={open ? "收起，只看当前动作" : "展开，看每一个动作"}>
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
                  <p key={r.id} className="ds-process-say">{r.item.text}</p>
                ) : (
                  <div key={r.id} className="ds-act-item" data-latest={i === records.length - 1 || undefined}>
                    <ToolRow sessionId={sessionId} item={r.item} open={!!tools[r.id]} onToggle={() => toggleTool(r.id)} />
                  </div>
                ),
              )}
            </div>
            <div className="ds-act-foot">
              <span>{m.stats}</span>
              <button className="ds-text-btn" aria-pressed={follow} onClick={() => setFollow(!follow)} title="新的动作出现时，列表自己滚到底">
                自动滚到底{follow ? "：开" : "：关"}
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
        <button className="sp-livebar-stop" onClick={onStop} title="打断这一轮">
          ■ 停止
        </button>
      )}
    </div>
  );
}

export const PROCESS_CHOICES: [ProcessMode, string, string][] = [
  ["brief", "简洁", "进行中的一轮只显示一张卡：当前动作和已完成几个；点开看每一个动作"],
  ["detail", "详细", "进行中逐条列出每个动作，和以前一样"],
];

/** 「过程：简洁 / 详细」 in the session panel's ⋯ menu: this session, this browser. */
export function ProcessChoice({ sessionId }: { sessionId: string }) {
  const mode = useProcessMode(sessionId);
  return (
    <div className="seg vm-seg process-choice" role="radiogroup" aria-label="过程怎么显示">
      {PROCESS_CHOICES.map(([k, label, tip]) => (
        <button key={k} role="radio" aria-checked={mode === k} data-on={mode === k} title={`${tip}。只影响这个会话，只在这个浏览器里记住`} onClick={() => processMode.set(sessionId, k)}>
          {label}
        </button>
      ))}
    </div>
  );
}
