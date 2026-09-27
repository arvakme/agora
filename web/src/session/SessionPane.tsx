// A session pane (design B): Pi Master's room for one canvas, as a workspace tab.
// Conversation view = turns (request → folded steps → reply); trajectory view = the
// same steps on a time axis. Every step comes from a real event recorded by runTurn.
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SPRING } from "../comments/motion";
import "./design.css";
import { Composer } from "./Composer";
import { runTurn, undoTurn } from "./runTurn";
import { sessions, useSessions, type Step, type Turn } from "./store";
import { canvases, highlight, ui } from "./ui";
import "./session.css";

const AGENTS = [
  { id: "pi", name: "Pi Master", color: "#c8b5f4", ink: "#352a50", live: true },
  { id: "claude", name: "Claude Code", color: "#f3c7a6", ink: "#5a3217", live: false },
  { id: "codex", name: "Codex", color: "#bfe3cd", ink: "#1f4a31", live: false },
];
export const AGENT_LIST = AGENTS;

const fmt = (ms: number) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const turnMs = (t: Turn, now: number) => (t.endedAt ?? now) - t.startedAt;

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(i);
  }, [active]);
  return now;
}

export function SessionPane({ sessionId, canvasTitles }: { sessionId: string; canvasTitles: Record<string, string> }) {
  const { sessions: all, turns } = useSessions();
  const session = all[sessionId];
  const [view, setView] = useState<"chat" | "trace">("chat");
  const list = session?.turnIds.map((id) => turns[id]).filter(Boolean) ?? [];
  const running = list.some((t) => t.status === "running");
  const now = useNow(running);
  const scroll = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Keep the newest turn in view; jump to a turn when asked (from a comment thread).
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
  }, [list.length]);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!session?.turnIds.includes(id)) return;
      setView("chat");
      setTimeout(() => {
        document.querySelector(`[data-turn="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setFlash(id);
        setTimeout(() => setFlash(null), 1600);
      }, 80);
    };
    addEventListener("agora:turn", on);
    return () => removeEventListener("agora:turn", on);
  }, [session]);

  if (!session) return <div className="sp-empty">会话不存在</div>;
  const cost = list.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  const time = list.reduce((a, t) => a + turnMs(t, now), 0);
  const canvasTitle = canvasTitles[session.canvasId];

  const send = async (text: string, refs: Turn["refs"], mentions: string[]) => {
    const c = canvases.get(session.canvasId) ?? (await ui.ensureCanvas(session.canvasId));
    if (!c) return;
    // History: earlier turns of this room, most recent last (already applied to the canvas).
    const history = list.slice(-6).flatMap((t) => [
      { author: "user", text: t.request },
      { author: "assistant", text: `${t.reply?.text ?? ""}${t.reply?.changes?.length ? `（${t.reply.changes.join("；")}）` : ""}${t.reply?.undone ? "（已被用户撤销）" : ""}` },
    ]);
    await runTurn({
      api: c.api,
      sessionId,
      canvasId: session.canvasId,
      request: { id: `chat-${Date.now()}`, origin: "chat", messages: [...history, { author: "user", text }], anchorIds: refs.map((r) => r.id) },
      origin: { kind: "chat" },
      text,
      refs,
      mentions,
    });
  };

  return (
    <div className="sp">
      <header className="sp-head">
        <div className="sp-title">
          <h2>Pi Master</h2>
          <p>
            <select value={session.canvasId} onChange={(e) => sessions.relink(sessionId, e.target.value)} aria-label="关联画布">
              {Object.entries(canvasTitles).map(([id, t]) => <option key={id} value={id}>{t}</option>)}
              {!canvasTitles[session.canvasId] && <option value={session.canvasId}>已删除的画布</option>}
            </select>
            <span>的房间 · {list.length} 轮 · {fmt(time)} · {usd(cost)}</span>
          </p>
        </div>
        <LayoutGroup id={`sp-${sessionId}`}>
          <div className="d-seg">
            {(["chat", "trace"] as const).map((k) => (
              <button key={k} data-on={view === k} onClick={() => setView(k)}>
                {view === k && <motion.span layoutId="seg" className="d-seg-bg" transition={SPRING} />}
                <span>{k === "chat" ? "对话" : "轨迹"}</span>
              </button>
            ))}
          </div>
        </LayoutGroup>
      </header>
      <div className="d-presence sp-presence">
        {AGENTS.map((a) => (
          <span key={a.id} className="d-presence-item" data-state={a.live ? (running ? "running" : "idle") : "offline"} title={a.live ? a.name : `${a.name} · 未接入（将来由 Pi Master 经本机宿主派发）`}>
            <Avatar a={a} size={20} state={a.live ? (running ? "running" : "idle") : "offline"} />
            <span>{a.name}</span>
          </span>
        ))}
      </div>
      <div className="d-rail-scroll sp-scroll" ref={scroll}>
        {!list.length && (
          <div className="sp-hello">
            <p>在这里和 Pi Master 对话，它会直接改「{canvasTitle ?? "画布"}」。</p>
            <p>用 <kbd>#</kbd> 引用画布元素，<kbd>@</kbd> 点名 worker；画布评论「交给 Agent」也会出现在这里。</p>
          </div>
        )}
        {view === "chat"
          ? list.map((t) => <TurnView key={t.id} t={t} now={now} canvasTitle={canvasTitles[t.canvasId]} flash={flash === t.id} />)
          : list.map((t) => <TraceTurn key={t.id} t={t} now={now} />)}
      </div>
      <Composer canvasId={session.canvasId} canvasTitle={canvasTitle} busy={running} onSend={send} />
    </div>
  );
}

function Avatar({ a, size, state }: { a: (typeof AGENTS)[number]; size: number; state: string }) {
  return (
    <span className="d-avatar" data-state={state} style={{ width: size, height: size, background: a.color, color: a.ink, fontSize: size * 0.42 }}>
      {a.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
    </span>
  );
}

const ICON: Record<Step["kind"], string> = {
  engine: "M12 3v3M12 18v3M3 12h3M18 12h3M7 12a5 5 0 1 0 10 0 5 5 0 0 0-10 0Z",
  read: "M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z",
  think: "M12 4a6 6 0 0 0-3.5 10.9V17h7v-2.1A6 6 0 0 0 12 4ZM9.5 20h5",
  tool: "M10.5 4a6.5 6.5 0 1 0 4.1 11.6L20 21M10.5 4a6.5 6.5 0 0 1 0 13",
  plan: "M8 6h12M8 12h12M8 18h8M4 6h.01M4 12h.01M4 18h.01",
  check: "M5 12.5 10 17 19 7",
  apply: "M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4",
  dispatch: "M5 12h11M12 6l6 6-6 6M5 5v14",
  error: "M12 8v5M12 16.5v.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
};
const Icon = ({ d, size = 12 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const TEAR = "M4.5 19.5V12a7.5 7.5 0 1 1 7.5 7.5Z";

function summary(t: Turn, now: number) {
  const ops = t.steps.reduce((n, s) => n + (s.ops?.length ?? 0), 0);
  const tools = t.steps.filter((s) => s.kind === "tool").length;
  const parts = [ops && `${ops} 个操作`, tools && `${tools} 次素材检索`, `${t.steps.length} 步`].filter(Boolean).join(" · ");
  const running = t.steps.findLast((s) => s.status === "running");
  const label = t.status === "running" ? `进行中 ${fmt(turnMs(t, now))}` : `用时 ${fmt(turnMs(t, now))}`;
  return { label, parts, running };
}

function TurnView({ t, now, canvasTitle, flash }: { t: Turn; now: number; canvasTitle?: string; flash: boolean }) {
  const [open, setOpen] = useState(t.status === "running");
  useEffect(() => {
    if (t.status === "running") setOpen(true);
  }, [t.status]);
  const s = summary(t, now);
  const hover = (ids: string[] | undefined) => highlight.set(ids?.length ? { canvasId: t.canvasId, ids } : null);
  const touched = t.steps.find((x) => x.kind === "apply")?.elements ?? [];
  const api = canvases.get(t.canvasId)?.api;
  return (
    <article className="d-turn sp-turn" data-status={t.status} data-turn={t.id} data-flash={flash}>
      {t.origin.kind === "comment" && (
        <button className="d-origin sp-origin" onClick={() => t.origin.kind === "comment" && ui.openThread(t.canvasId, t.origin.threadId)} title="在画布中打开这条评论">
          <span className="d-origin-pin"><Icon d={TEAR} size={12} /></span>
          来自评论 <b>#{t.origin.threadN}</b> · {canvasTitle ?? "画布"} · {t.origin.anchor}
          <span className="d-origin-link">在画布中打开</span>
        </button>
      )}
      <div className="d-user">
        <p>{t.request}</p>
        {(t.refs.length > 0 || t.mentions.length > 0) && (
          <div className="sp-chips">
            {t.refs.map((r) => (
              <span key={r.id} className="sp-chip ref" onPointerEnter={() => hover([r.id])} onPointerLeave={() => hover(undefined)}>#{r.label}</span>
            ))}
            {t.mentions.map((m) => <span key={m} className="sp-chip mention">@{AGENTS.find((a) => a.id === m)?.name ?? m}</span>)}
          </div>
        )}
        <time>{new Date(t.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
      </div>
      <button className="d-process" data-open={open} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Avatar a={AGENTS[0]} size={20} state={t.status === "running" ? "running" : "idle"} />
        <span className="d-process-label">{t.status === "running" ? <span className="d-shimmer">{s.label}</span> : s.label}</span>
        <span className="d-process-parts">{s.parts}</span>
        {s.running && !open && <span className="d-process-now">正在：{s.running.title}</span>}
        <span className="d-chevron" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="d-reveal" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SPRING}>
            <ol className="d-steps">
              <AnimatePresence initial={false}>
                {t.steps.map((st, i) => (
                  <motion.li
                    key={st.id}
                    className="d-step"
                    data-kind={st.kind === "tool" ? "read" : st.kind === "error" ? "check" : st.kind}
                    data-status={st.status === "running" ? "running" : st.status === "skipped" ? "pending" : "done"}
                    data-error={st.status === "error"}
                    data-last={i === t.steps.length - 1}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={SPRING}
                    onPointerEnter={() => hover(st.elements)}
                    onPointerLeave={() => hover(undefined)}
                  >
                    <span className="d-node"><Icon d={ICON[st.kind]} /></span>
                    <div className="d-step-main">
                      <div className="d-step-head">
                        <span className="d-step-title">{st.title}</span>
                        <time>{st.status === "skipped" ? "未接入" : st.status === "running" ? <span className="d-shimmer">{fmt(now - st.startedAt)}</span> : fmt((st.endedAt ?? now) - st.startedAt)}</time>
                      </div>
                      {st.detail && <p className="d-step-detail">{st.detail}</p>}
                      {st.ops && (
                        <div className="d-ops">{st.ops.map((o, k) => <span key={k} className="d-op"><b>{o.op}</b>{o.target}</span>)}</div>
                      )}
                      {st.candidates && st.candidates.length > 0 && (
                        <div className="d-ops">{st.candidates.map((c) => <span key={c.id} className="d-op cand" title={c.id}>{c.name}<i>{c.library}</i></span>)}</div>
                      )}
                    </div>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {t.reply && (
          <motion.div className="d-reply" data-tone={t.reply.tone} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            <p>{t.reply.text}</p>
            {t.reply.changes && <ul data-undone={!!t.reply.undone}>{t.reply.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
            {t.reply.undoError && <p className="sp-warn">{t.reply.undoError}</p>}
            <div className="d-reply-actions">
              {t.reply.batchId && (t.reply.undone ? <span className="sp-undone">已撤销</span> : <button className="d-chip-btn" disabled={!api} onClick={() => api && undoTurn(api, t.id)}>撤销这次修改</button>)}
              {touched.length > 0 && !t.reply.undone && (
                <button
                  className="d-chip-btn ghost"
                  onClick={() => {
                    ui.focusPane(t.canvasId);
                    highlight.set({ canvasId: t.canvasId, ids: touched });
                    setTimeout(() => highlight.get()?.ids === touched && highlight.set(null), 2600);
                  }}
                >
                  在画布中高亮
                </button>
              )}
              <span className="d-meta">{fmt(turnMs(t, now))}{t.costUsd != null ? ` · ${usd(t.costUsd)}` : ""}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

/** dsh-style waterfall for one turn: every step on the turn's real time axis. */
function TraceTurn({ t, now }: { t: Turn; now: number }) {
  const total = Math.max(1, turnMs(t, now));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <section className="d-trace-turn">
      <h3>
        第 {t.n} 轮 <span>{t.request}</span>
        <em>{fmt(total)}{t.costUsd != null ? ` · ${usd(t.costUsd)}` : ""}</em>
      </h3>
      <div className="d-wf">
        <div className="d-wf-axis">
          <span />
          <div>{ticks.map((f) => <span key={f} style={{ left: `${f * 100}%` }}>{fmt(f * total)}</span>)}</div>
        </div>
        {t.steps.map((s) => {
          const start = s.startedAt - t.startedAt, dur = (s.endedAt ?? now) - s.startedAt;
          return (
            <div
              key={s.id}
              className="d-wf-row"
              data-status={s.status === "running" ? "running" : s.status === "skipped" ? "pending" : "done"}
              onPointerEnter={() => s.elements?.length && highlight.set({ canvasId: t.canvasId, ids: s.elements })}
              onPointerLeave={() => highlight.set(null)}
            >
              <span className="d-wf-label">
                <span className="d-wf-dot" data-kind={s.kind} />
                {s.title}
              </span>
              <div className="d-wf-track">
                {ticks.slice(1, -1).map((f) => <i key={f} style={{ left: `${f * 100}%` }} />)}
                <span className="d-wf-bar" data-kind={s.kind} style={{ left: `${(start / total) * 100}%`, width: `max(3px, ${(Math.max(dur, 1) / total) * 100}%)` }} />
              </div>
              <time>{s.status === "skipped" ? "—" : fmt(dur)}</time>
            </div>
          );
        })}
      </div>
    </section>
  );
}
