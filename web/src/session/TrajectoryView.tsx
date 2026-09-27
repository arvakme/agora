// Session trajectory views: the conversation's per-turn process fold and the trajectory
// (timeline overview + turn → step → record ledger with an inline inspector).
//
// Structure and interaction follow DeepSeek Harness (github.com/deepseek-ai/deepseek-harness,
// MIT, commit 477b4f4), rewritten in Agora's stack without its dependencies:
//   ProcessFold      ← ui-chat/src/client/chat/TurnProcessNodeView.tsx (one-line "用时 …"
//                      disclosure per turn; live and failed turns stay open) and
//                      ui-chat/src/client/chat/ChatGroupSeat.tsx (process title from activity)
//   TrajectoryView   ← ui-trajectory/src/client/TrajectoryView.tsx (toolbar + overview + ledger)
//   Timeline         ← ui-trajectory/src/client/TrajectoryTimeline.tsx (Chrome-Network-style
//                      lanes, turn boundaries, drag an interval to focus the ledger)
//   TurnSection      ← TrajectoryTurn.tsx + TrajectoryTurnHeader.tsx (sticky "第 N 轮" header
//                      with usage columns)
//   GroupHeader      ← TrajectoryGroupHeader.tsx ("消息" / "第 N 步" + description)
//   RecordRow        ← TrajectoryCell.tsx (#index, kind tag, one-line text, time) and the
//                      record inspector (input / output / timing / usage)
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { IconChevron, IconCopy, IconSearch } from "../app/icons";
import { agents, type Item } from "./agents";
import {
  ACTIVITY_NOW,
  activityOf,
  deriveTimeline,
  fmtCost,
  fmtDuration,
  fmtTokens,
  focusIndexes,
  processTitle,
  type TimelineMode,
  type TrajRecord,
  type TrajStep,
  type TrajTurn,
  type UsageSum,
} from "./trajectoryModel";
import "./trajectory.css";

const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const KIND: Record<TrajRecord["kind"], string> = { user: "用户", message: "消息", tool: "工具" };
const OP: Record<string, string> = { edit: "改", write: "写", add: "新建", delete: "删" };

/** Model · effort · tokens · time · cost, only the parts that are known (nothing is made up). */
export function UsageMeta({ model, effort, usage, durationMs, compact = false }: { model?: string | null; effort?: string | null; usage: UsageSum; durationMs?: number | null; compact?: boolean }) {
  const parts: { k: string; v: string; title: string }[] = [];
  if (model) parts.push({ k: "model", v: model, title: "模型" });
  if (effort) parts.push({ k: "effort", v: effort, title: "强度" });
  if (usage.input != null) parts.push({ k: "in", v: `输入 ${fmtTokens(usage.input)}`, title: `输入 tokens（不含缓存）：${usage.input}` });
  if (usage.output != null) parts.push({ k: "out", v: `输出 ${fmtTokens(usage.output)}`, title: `输出 tokens：${usage.output}` });
  if (usage.cacheRead != null || usage.cacheWrite != null)
    parts.push({ k: "cache", v: `缓存 ${fmtTokens(usage.cacheRead ?? 0)}${usage.cacheWrite ? ` / 写 ${fmtTokens(usage.cacheWrite)}` : ""}`, title: `缓存读 ${usage.cacheRead ?? 0} · 缓存写 ${usage.cacheWrite ?? 0}` });
  if (durationMs != null) parts.push({ k: "time", v: fmtDuration(durationMs), title: "耗时" });
  if (usage.cost != null) parts.push({ k: "cost", v: fmtCost(usage.cost), title: "花费（美元）" });
  if (!parts.length) return null;
  return (
    <span className="ds-usage" data-compact={compact}>
      {parts.map((p) => (
        <span key={p.k} data-k={p.k} title={p.title}>
          {p.v}
        </span>
      ))}
    </span>
  );
}

// ——— tool record: input and output, expandable, full text on demand ———
function Payload({ sessionId, item, field, label }: { sessionId: string; item: Item; field: "args" | "output"; label: string }) {
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = item.tool ?? {};
  const text = full ?? t[field];
  const total = field === "args" ? t.argsLen : t.outputLen;
  if (text === undefined || text === "") return (
    <div className="ds-payload">
      <div className="ds-payload-head">{label}</div>
      <p className="ds-empty">{field === "output" ? (item.endAt || t.isError !== undefined ? "无输出" : "还在运行…") : "未捕获参数"}</p>
    </div>
  );
  const more = !full && total && total > text.length;
  const loadFull = async () => {
    setLoading(true);
    setErr(null);
    try {
      const it = await agents.item(sessionId, item.id);
      setFull(it.tool?.[field] ?? "");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="ds-payload">
      <div className="ds-payload-head">
        {label}
        <span>{(total ?? text.length).toLocaleString()} 字</span>
        <button className="ds-text-btn" onClick={() => void navigator.clipboard?.writeText(text)} title="复制" aria-label={`复制${label}`}>
          <IconCopy size={14} />
        </button>
      </div>
      <pre data-error={field === "output" && !!t.isError}>{text}</pre>
      {more && (
        <button className="ds-text-btn" disabled={loading} onClick={() => void loadFull()}>
          {loading ? "载入中…" : `已截断，展开全文（共 ${total!.toLocaleString()} 字）`}
        </button>
      )}
      {err && <p className="ds-warn">{err}</p>}
    </div>
  );
}

export function ToolDetail({ sessionId, item }: { sessionId: string; item: Item }) {
  const t = item.tool ?? {};
  return (
    <div className="ds-inspector">
      {!!t.files?.length && (
        <ul className="ds-files">
          {t.files.map((f) => (
            <li key={f.path}>
              <em>{OP[f.op] ?? f.op}</em>
              <code>{f.path}</code>
            </li>
          ))}
        </ul>
      )}
      <Payload sessionId={sessionId} item={item} field="args" label="输入" />
      <Payload sessionId={sessionId} item={item} field="output" label="输出" />
      <p className="ds-timing">
        开始 {clock(item.at)}
        {item.endAt ? ` · 结束 ${clock(item.endAt)} · ${fmtDuration(item.endAt - item.at)}` : ""}
      </p>
    </div>
  );
}

/** One tool call in the conversation: name + one-line input; click to see input and output. */
export function ToolRow({ sessionId, item, open, onToggle }: { sessionId: string; item: Item; open: boolean; onToggle: () => void }) {
  const t = item.tool ?? {};
  const running = t.output === undefined && !item.endAt;
  return (
    <div className="ds-tool" data-open={open} data-error={!!t.isError}>
      <button className="ds-tool-line" onClick={onToggle} aria-expanded={open}>
        <IconChevron open={open} />
        <b>{t.name || "tool"}</b>
        <span className="ds-mono">{t.input}</span>
        {running ? <em className="ds-dot" data-tone="run">运行中</em> : t.isError ? <em className="ds-dot" data-tone="error">失败</em> : item.endAt ? <time>{fmtDuration(item.endAt - item.at)}</time> : null}
      </button>
      {open && <ToolDetail sessionId={sessionId} item={item} />}
    </div>
  );
}

// ——— conversation view: one turn's process folded into a line ———
export function ProcessFold({ sessionId, turn, children }: { sessionId: string; turn: TrajTurn; children?: React.ReactNode }) {
  const alwaysOpen = turn.running || !!turn.error;
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!turn.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [turn.running]);
  const process = turn.steps.filter((s) => s.n > 0).map((s) => ({ ...s, records: s.records.filter((r) => r.item !== turn.reply) })).filter((s) => s.records.length);
  if (!process.length && !turn.running && !turn.error) return null;
  const shown = open || alwaysOpen;
  const lastTool = [...process.flatMap((s) => s.records)].reverse().find((r) => r.kind === "tool");
  const elapsed = turn.durationMs ?? (turn.running ? now - turn.startedAt : null);
  const label = turn.running
    ? `${lastTool ? ACTIVITY_NOW[activityOf(lastTool.item.tool?.name)] : ACTIVITY_NOW.thinking}${elapsed != null ? `，用时 ${fmtDuration(elapsed)}` : ""}`
    : turn.error
      ? `处理失败：${turn.error}`
      : `${processTitle(turn.activity)}${elapsed != null ? ` · 用时 ${fmtDuration(elapsed)}` : ""}`;
  const counts = [turn.toolCount ? `${turn.toolCount} 次工具调用` : "", turn.messageCount > 1 ? `${turn.messageCount - (turn.reply ? 1 : 0)} 条过程消息` : ""].filter(Boolean).join(" · ");
  return (
    <div className="ds-process" data-open={shown} data-running={turn.running} data-error={!!turn.error}>
      <button className="ds-process-line" onClick={() => setOpen(!open)} disabled={alwaysOpen} aria-expanded={shown}>
        {turn.running && <span className="ds-live" aria-hidden />}
        <span className="ds-process-title">{label}</span>
        {counts && <span className="ds-process-count">{counts}</span>}
        {!alwaysOpen && <IconChevron open={shown} />}
      </button>
      {shown && (
        <div className="ds-process-body">
          {process.map((s) =>
            s.records.map((r) =>
              r.kind === "message" ? (
                <p key={r.id} className="ds-process-say">{r.item.text}</p>
              ) : (
                <ToolRow key={r.id} sessionId={sessionId} item={r.item} open={!!tools[r.id]} onToggle={() => setTools({ ...tools, [r.id]: !tools[r.id] })} />
              ),
            ),
          )}
          {children}
        </div>
      )}
    </div>
  );
}

// ——— trajectory view ———
export function TrajectoryView({ sessionId, turns, focusTurn }: { sessionId: string; turns: TrajTurn[]; focusTurn?: { n: number; key: number } | null }) {
  const [mode, setMode] = useState<TimelineMode>("sequence");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [query, setQuery] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const model = useMemo(() => deriveTimeline(turns, mode), [turns, mode]);
  const focus = useMemo(() => (model && range ? focusIndexes(model, range[0], range[1]) : null), [model, range]);
  const q = query.trim().toLowerCase();
  const visible = (r: TrajRecord) => (!focus || focus.has(r.index)) && (!q || r.text.toLowerCase().includes(q) || (r.item.tool?.output ?? "").toLowerCase().includes(q));
  const records = turns.reduce((n, t) => n + t.steps.reduce((m, s) => m + s.records.length, 0), 0);
  const calls = turns.reduce((n, t) => n + t.toolCount, 0);

  // Stay at the tail while new records arrive, until the person scrolls up (DSH ledger).
  useEffect(() => {
    const el = scroll.current;
    if (el && follow.current && !focusTurn) el.scrollTop = el.scrollHeight;
  }, [records]);
  useEffect(() => {
    if (!focusTurn) return;
    setCollapsed((c) => {
      const next = new Set(c);
      next.delete(focusTurn.n);
      return next;
    });
    setTimeout(() => scroll.current?.querySelector(`[data-traj-turn="${focusTurn.n}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
  }, [focusTurn?.key]);

  const allOpen = collapsed.size === 0;
  return (
    <div className="ds-traj">
      <div className="ds-traj-bar" role="toolbar" aria-label="轨迹工具栏">
        <span className="ds-traj-count">
          {turns.length} 轮 · {records} 条记录 · {calls} 次调用
        </span>
        <div className="seg" data-static role="radiogroup" aria-label="时间轴">
          {(["sequence", "duration"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} data-on={mode === m} onClick={() => (setMode(m), setRange(null))} title={m === "sequence" ? "每条记录等宽" : "按记录的实际开始时间与时长（去掉空闲间隔）"}>
              {m === "sequence" ? "等宽" : "实际时长"}
            </button>
          ))}
        </div>
        <button className="ds-text-btn" onClick={() => setCollapsed(allOpen ? new Set(turns.map((t) => t.n)) : new Set())}>
          {allOpen ? "收起所有轮次" : "展开所有轮次"}
        </button>
        <label className="ds-search">
          <IconSearch size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索" aria-label="搜索轨迹" />
        </label>
      </div>
      {model ? <Timeline model={model} mode={mode} range={range} onRange={setRange} onPick={(i) => setSelected(recordId(turns, i))} /> : <div className="ds-timeline ds-empty-line">还没有记录</div>}
      {range && (
        <div className="ds-traj-focus">
          只看时间轴选中区间内的 {focus?.size ?? 0} 条记录
          <button className="ds-text-btn" onClick={() => setRange(null)}>
            清除选择
          </button>
        </div>
      )}
      <div
        className="ds-ledger"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {turns.map((t) => {
          const steps = t.steps.map((s) => ({ ...s, records: s.records.filter(visible) })).filter((s) => s.records.length);
          if ((focus || q) && !steps.length) return null;
          return (
            <TurnSection key={t.n} turn={t} open={!collapsed.has(t.n)} onToggle={() => setCollapsed((c) => (c.has(t.n) ? (c.delete(t.n), new Set(c)) : new Set(c).add(t.n)))}>
              {steps.map((s) => (
                <StepGroup key={s.n} step={s}>
                  {s.records.map((r) => (
                    <RecordRow key={r.id} sessionId={sessionId} r={r} selected={selected === r.id} onSelect={() => setSelected(selected === r.id ? null : r.id)} />
                  ))}
                </StepGroup>
              ))}
            </TurnSection>
          );
        })}
      </div>
    </div>
  );
}

const recordId = (turns: TrajTurn[], index: number) => turns.flatMap((t) => t.steps.flatMap((s) => s.records)).find((r) => r.index === index)?.id ?? null;

function TurnSection({ turn, open, onToggle, children }: { turn: TrajTurn; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className="ds-turn" data-traj-turn={turn.n} data-running={turn.running}>
      <button className="ds-turn-head" onClick={onToggle} aria-expanded={open}>
        <IconChevron open={open} />
        <b>第 {turn.n} 轮</b>
        {turn.source === "terminal" && <span className="ds-tag">终端</span>}
        {turn.running && <span className="ds-dot" data-tone="run">进行中</span>}
        {turn.error && <span className="ds-dot" data-tone="error">出错</span>}
        <time>{clock(turn.startedAt)}</time>
        <UsageMeta model={turn.model} effort={turn.effort} usage={turn.usage} durationMs={turn.durationMs} compact />
      </button>
      {open && <div className="ds-turn-body">{children}</div>}
    </section>
  );
}

function StepGroup({ step, children }: { step: TrajStep; children: React.ReactNode }) {
  return (
    <div className="ds-group">
      <div className="ds-group-head">
        <span>{step.n === 0 ? "消息" : `第 ${step.n} 步`}</span>
        {step.description && <em>{step.description}</em>}
      </div>
      {children}
    </div>
  );
}

function RecordRow({ sessionId, r, selected, onSelect }: { sessionId: string; r: TrajRecord; selected: boolean; onSelect: () => void }) {
  return (
    <div className="ds-rec" data-selected={selected} data-kind={r.kind} data-error={r.isError}>
      <button className="ds-rec-line" onClick={onSelect} aria-expanded={selected}>
        <span className="ds-rec-i">#{r.index}</span>
        <span className="ds-rec-kind">{KIND[r.kind]}</span>
        <span className="ds-rec-text">{r.kind === "tool" ? <span className="ds-mono">{r.text}</span> : r.text || "（空）"}</span>
        <span className="ds-rec-time">{r.running ? "…" : r.durationMs != null ? fmtDuration(r.durationMs) : clock(r.at)}</span>
      </button>
      {selected &&
        (r.kind === "tool" ? (
          <ToolDetail sessionId={sessionId} item={r.item} />
        ) : (
          <div className="ds-inspector">
            <div className="ds-payload">
              <div className="ds-payload-head">
                {r.kind === "user" ? (r.item.source === "terminal" ? "终端输入" : "来自 Agora") : "回复"}
                <span>{clock(r.at)}</span>
              </div>
              <pre className="ds-prose">{r.item.text}</pre>
            </div>
          </div>
        ))}
    </div>
  );
}

// ——— overview timeline (DSH TrajectoryTimeline: three lanes, turn marks, drag to focus) ———
function Timeline({ model, mode, range, onRange, onPick }: { model: NonNullable<ReturnType<typeof deriveTimeline>>; mode: TimelineMode; range: [number, number] | null; onRange: (r: [number, number] | null) => void; onPick: (index: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; moved: boolean } | null>(null);
  const [live, setLive] = useState<[number, number] | null>(null);
  const span = model.end - model.start || 1;
  const frac = (v: number) => (v - model.start) / span;
  const valueAt = (clientX: number) => {
    const b = track.current!.getBoundingClientRect();
    return model.start + Math.min(1, Math.max(0, (clientX - b.left) / b.width)) * span;
  };
  const down = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x0: e.clientX, moved: false };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x0) >= 3) d.moved = true;
    if (d.moved) {
      const a = valueAt(d.x0), b = valueAt(e.clientX);
      setLive([Math.min(a, b), Math.max(a, b)]);
    }
  };
  const up = (e: RPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && live) onRange(live);
    else if (!d?.moved) {
      const hit = (e.target as HTMLElement).closest("[data-index]") as HTMLElement | null;
      if (hit) onPick(Number(hit.dataset.index));
    }
    setLive(null);
  };
  const sel = live ?? range;
  return (
    <div className="ds-timeline" aria-label="轨迹时间轴">
      <div className="ds-timeline-labels" aria-hidden>
        <span>用户</span>
        <span>消息</span>
        <span>工具</span>
      </div>
      <div
        className="ds-timeline-track"
        ref={track}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onContextMenu={(e) => {
          e.preventDefault();
          onRange(null);
        }}
        title="拖动选择一段时间，只看这段里的记录；右键清除"
      >
        {model.turnBoundaries.map((b) => (
          <span key={b.turn} className="ds-timeline-turn" style={{ left: `${frac(b.at) * 100}%` }}>
            <i>{b.turn}</i>
          </span>
        ))}
        {model.spans.map((s) => (
          <span
            key={s.index}
            data-index={s.index}
            data-kind={s.kind}
            data-error={s.isError}
            className="ds-timeline-span"
            title={`#${s.index} ${KIND[s.kind]} · 第 ${s.turn} 轮\n${s.label.slice(0, 160)}${mode === "duration" && s.end > s.start ? `\n${fmtDuration(s.end - s.start)}` : ""}`}
            style={{ left: `${frac(s.start) * 100}%`, width: `max(3px, ${((s.end - s.start) / span) * 100}%)`, top: 6 + s.lane * 14 }}
          />
        ))}
        {sel && <span className="ds-timeline-sel" style={{ left: `${frac(sel[0]) * 100}%`, width: `${((sel[1] - sel[0]) / span) * 100}%` }} />}
      </div>
    </div>
  );
}
