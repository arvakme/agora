// A session pane: one native coding-agent session (Pi, Claude Code or Codex), picked when the
// session starts and fixed after that. The conversation is the CLI's own log (followed live
// by the server), so what is said here, in a headless turn, or in the terminal after
// "在终端打开" all shows up in one transcript; the canvas changes the agent made through the
// agora-canvas skill appear in it as cards with undo.
//
// Two views of the same turns (trajectory.ts): 对话 — each turn's process folded into one line
// with the answer below it — and 轨迹 — timeline overview plus turn → step → record ledger
// (Trajectory.tsx; structure from DeepSeek Harness, MIT). Every tool call opens to its input and
// output; every turn shows model, effort, tokens, time and cost when the log has them.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconCommentSolid, IconCopy, IconGauge, IconLock, IconMessage, IconPath, IconTarget, IconTerminal, IconUndo } from "../app/icons";
import { Markdown } from "./markdown";
import { ProcessFold, TrajectoryView, UsageMeta } from "./TrajectoryView";
import { buildTurns, sumUsage, type TrajTurn } from "./trajectoryModel";
import { SPRING } from "../comments/motion";
import { Composer } from "./Composer";
import { AGENT_KINDS, AGENT_NAMES, agents, useAgents, type AgentKind, type Catalog } from "./agents";
import { undoTurn } from "./runTurn";
import { sessions, useSessions, type Turn } from "./store";
import { agentChoice, canvases, highlight, ui } from "./ui";
import "./session.css";

const fmt = (ms: number) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export function SessionPane({ sessionId, canvasTitles }: { sessionId: string; canvasTitles: Record<string, string> }) {
  const { sessions: all } = useSessions();
  const ag = useAgents();
  const session = all[sessionId];
  if (!session) return <div className="sp-empty">会话不存在</div>;
  const binding = ag.bindings[sessionId];
  if (!binding) return <Chooser sessionId={sessionId} canvasTitle={canvasTitles[session.canvasId]} />;
  return <AgentSession sessionId={sessionId} canvasTitles={canvasTitles} />;
}

/** An agent is its initials in a neutral circle, like a person (no colour per vendor, no sparkle). */
function AgentMark({ kind, small }: { kind: AgentKind; small?: boolean }) {
  return (
    <span className={small ? "avatar sm" : "avatar"} aria-hidden>
      {AGENT_NAMES[kind].split(" ").map((w) => w[0]).join("").slice(0, 2)}
    </span>
  );
}

/** Pick the session's agent, model and effort. Once started this never changes. */
function Chooser({ sessionId, canvasTitle }: { sessionId: string; canvasTitle?: string }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [kind, setKind] = useState<AgentKind>("claude");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = agentChoice.pending(sessionId);
  useEffect(() => {
    void agents.catalog().then(setCat).catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    if (cat) (setModel(cat[kind].default || cat[kind].featured[0] || ""), setEffort(""));
  }, [cat, kind]);
  const c = cat?.[kind];
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await agents.bind(sessionId, kind, model, effort);
      agentChoice.resolve(sessionId, sessionId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const more = c ? c.models.filter((m) => !c.featured.includes(m)) : [];
  return (
    <div className="sp">
      <div className="sp-choose">
        <h2>这个会话用哪个 Agent？</h2>
        <p>会话就是它自己的原生会话：在这里讨论「{canvasTitle ?? "画布"}」，也能随时在终端里接着做 coding。选定后不能更改。</p>
        {waiting && (
          <p className="notice" data-tone="caution">
            <b>在等你</b>
            <span>有一条画布评论在等这个会话，选好后会自动交给它。</span>
          </p>
        )}
        <div className="sp-agents" role="radiogroup" aria-label="Agent">
          {AGENT_KINDS.map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} data-on={kind === k} disabled={cat ? !cat[k].installed : false} onClick={() => setKind(k)}>
              <AgentMark kind={k} />
              <span>{AGENT_NAMES[k]}</span>
              {cat && !cat[k].installed && <em>未安装</em>}
            </button>
          ))}
        </div>
        <div className="sp-choose-row">
          <label>
            模型
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!c} aria-label="模型">
              {!c?.default && <option value="">CLI 默认</option>}
              {c?.featured.map((m) => <option key={m} value={m}>{m}{m === c.default ? "（默认）" : ""}</option>)}
              {more.length > 0 && (
                <optgroup label="更多">
                  {more.map((m) => <option key={m} value={m}>{m}</option>)}
                </optgroup>
              )}
            </select>
          </label>
          <label>
            强度
            <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={!c} aria-label="强度">
              <option value="">默认{c?.defaultEffort ? `（${c.defaultEffort}）` : ""}</option>
              {c?.efforts.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
        </div>
        {err && <p className="sp-warn">{err}</p>}
        <div className="sp-choose-go">
          <button className="btn primary" disabled={busy || !cat} onClick={() => void start()}>用 {AGENT_NAMES[kind]} 开始</button>
          {waiting && <button className="btn ghost" onClick={() => agentChoice.resolve(sessionId, undefined)}>先不交</button>}
        </div>
      </div>
    </div>
  );
}

function AgentSession({ sessionId, canvasTitles }: { sessionId: string; canvasTitles: Record<string, string> }) {
  const { sessions: all, turns: canvasTurns } = useSessions();
  const ag = useAgents();
  const session = all[sessionId];
  const binding = ag.bindings[sessionId]!;
  const status = ag.status[sessionId];
  const items = ag.items[sessionId] ?? [];
  const scroll = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [termMsg, setTermMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"chat" | "trajectory">("chat");
  const [focusTurn, setFocusTurn] = useState<{ n: number; key: number } | null>(null);
  const canvasTitle = canvasTitles[session.canvasId];
  const inflight = ag.inflight[sessionId];
  const working = !!(status?.running || status?.busy || inflight);
  const turns = useMemo(() => buildTurns(items, { model: binding.model, effort: binding.effort }, !!(status?.running || status?.busy)), [items, binding.model, binding.effort, status?.running, status?.busy]);
  const total = useMemo(() => sumUsage(turns), [turns]);
  const changes = session.turnIds.map((id) => canvasTurns[id]).filter(Boolean);

  useEffect(() => {
    if (view === "chat") scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
  }, [items.length, changes.length, view]);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!session.turnIds.includes(id)) return;
      setView("chat");
      setTimeout(() => {
        document.querySelector(`[data-turn="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setFlash(id);
        setTimeout(() => setFlash(null), 1600);
      }, 80);
    };
    const onTraj = (e: Event) => {
      const d = (e as CustomEvent<{ sessionId: string; turn: number }>).detail;
      if (d.sessionId !== sessionId) return;
      setView("trajectory");
      setFocusTurn({ n: d.turn, key: Date.now() });
    };
    addEventListener("agora:turn", on);
    addEventListener("agora:trajectory", onTraj);
    return () => (removeEventListener("agora:turn", on), removeEventListener("agora:trajectory", onTraj));
  }, [session, sessionId]);
  const send = async (text: string, refs: Turn["refs"]) => {
    const selected = Object.keys(canvases.get(session.canvasId)?.api.getAppState().selectedElementIds ?? {});
    const notes = [
      refs.length ? `引用的画布元素：${refs.map((r) => `${r.label}（${r.id}）`).join("、")}` : "",
      selected.length ? `当前选区：${selected.join(", ")}` : "",
    ].filter(Boolean);
    await agents.send(sessionId, notes.length ? `${text}\n\n（${notes.join("；")}）` : text, { canvasId: session.canvasId });
  };
  const openTerminal = async () => {
    setTermMsg(null);
    try {
      const r = await agents.openTerminal(sessionId, session.canvasId, true);
      setTermMsg(r.launched ? `已在 ${r.launched === "kitty" ? "Kitty" : "终端"} 中打开` : "没找到可用的终端：复制下面的命令自己打开");
    } catch (e) {
      setTermMsg((e as Error).message);
    }
  };
  const copy = async () => {
    await navigator.clipboard?.writeText(status?.terminal.attach ?? "").catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const line = status?.held
    ? `排队中：${status.held}`
    : status?.running
      ? `${AGENT_NAMES[binding.agent]} 正在处理${status.activity ? ` · ${status.activity}` : ""}`
      : status?.busy
        ? `${AGENT_NAMES[binding.agent]} 正在回复${status.terminal.alive ? "（终端）" : ""}`
        : inflight
          ? "已发送，等待开始…"
          : status?.error
            ? `上一轮出错：${status.error}`
            : null;

  const totalMs = turns.some((t) => t.durationMs != null) ? turns.reduce((n, t) => n + (t.durationMs ?? 0), 0) : null;
  return (
    <div className="sp" data-agent={binding.agent}>
      <header className="sp-head">
        <AgentMark kind={binding.agent} />
        <div className="sp-title">
          <h2 title={binding.nativeId ? `原生会话 ${binding.nativeId}` : "原生会话 id 在第一轮后生成"}>{AGENT_NAMES[binding.agent]}</h2>
          <p className="sp-meta">
            <span className="sp-lock" title="创建会话时选定，不能更改">
              <IconLock size={12} />
              {binding.model || "默认模型"}{binding.effort ? ` · ${binding.effort}` : ""}
            </span>
            <span className="sp-sep" aria-hidden>·</span>
            <select value={session.canvasId} onChange={(e) => sessions.relink(sessionId, e.target.value)} aria-label="关联画布" title="这个会话默认改的画布">
              {Object.entries(canvasTitles).map(([id, t]) => <option key={id} value={id}>{t}</option>)}
              {!canvasTitles[session.canvasId] && <option value={session.canvasId}>已删除的画布</option>}
            </select>
            {binding.nativeId && <code className="sp-native" title="原生会话 id">{binding.nativeId.slice(0, 8)}</code>}
          </p>
        </div>
        {status?.terminal.alive ? (
          <button className="btn sm quiet sp-term-btn" onClick={() => void openTerminal()} title="再开一个窗口连到同一个终端">
            <IconTerminal size={16} /><span className="sp-btn-label">新窗口</span>
          </button>
        ) : (
          <button className="btn sm quiet sp-term-btn" disabled={!!status?.running} onClick={() => void openTerminal()} title={status?.running ? "这一轮结束后再打开" : "用终端打开这个会话，直接在里面做 coding"}>
            <IconTerminal size={16} /><span className="sp-btn-label">在终端打开</span>
          </button>
        )}
      </header>
      {(status?.terminal.alive || termMsg) && (
        <div className="notice sp-attach" data-tone={status?.terminal.alive ? undefined : "caution"}>
          {status?.terminal.alive ? (
            <>
              <i className="dot" data-tone="ok" />
              <b>终端已接管</b>
              <code title="在任意终端里运行，连到这个会话">{status.terminal.attach}</code>
              <button className="icon-btn sm" onClick={() => void copy()} aria-label={copied ? "已复制" : "复制命令"} title={copied ? "已复制" : "复制命令"}><IconCopy size={16} /></button>
              <button className="btn sm ghost" onClick={() => void agents.closeTerminal(sessionId)} title="结束终端里的 CLI；会话可随时再续接">关闭终端</button>
            </>
          ) : (
            <span>{termMsg}</span>
          )}
          {status?.terminal.alive && termMsg && <span className="sp-attach-msg">{termMsg}{status.terminal.clients ? ` · ${status.terminal.clients} 个窗口` : ""}</span>}
        </div>
      )}
      <div className="sp-bar">
        <div className="seg" role="radiogroup" aria-label="视图">
          <button role="radio" aria-checked={view === "chat"} data-on={view === "chat"} onClick={() => setView("chat")}>
            {view === "chat" && <motion.span layoutId={`sp-view-${sessionId}`} className="seg-bg" transition={SPRING} />}
            <IconMessage size={14} />
            <span>对话</span>
          </button>
          <button role="radio" aria-checked={view === "trajectory"} data-on={view === "trajectory"} onClick={() => setView("trajectory")}>
            {view === "trajectory" && <motion.span layoutId={`sp-view-${sessionId}`} className="seg-bg" transition={SPRING} />}
            <IconPath size={14} />
            <span>轨迹</span>
          </button>
        </div>
        {turns.length > 0 && (
          <p className="sp-total" title="这个会话累计（只算日志里记下的）">
            <IconGauge size={14} />
            <span>{turns.length} 轮</span>
            <UsageMeta usage={total} durationMs={totalMs} compact />
          </p>
        )}
      </div>
      {view === "trajectory" ? (
        <div className="sp-traj">
          <TrajectoryView sessionId={sessionId} turns={turns} focusTurn={focusTurn} />
        </div>
      ) : (
        <div className="sp-scroll" ref={scroll}>
          {!turns.length && !changes.length && (
            <div className="sp-hello">
              <p>和 {AGENT_NAMES[binding.agent]} 讨论「{canvasTitle ?? "画布"}」的架构；它用 agora-canvas skill 读图、改图、做算法动画。</p>
              <p>画布评论「交给 Agent」也会来到这里。想直接写代码时点「在终端打开」，两边说的话会同步。</p>
            </div>
          )}
          <Conversation sessionId={sessionId} turns={turns} changes={changes} canvasTitles={canvasTitles} flash={flash} onTrajectory={(n) => (setView("trajectory"), setFocusTurn({ n, key: Date.now() }))} />
        </div>
      )}
      {line && (
        <div className="notice sp-status" data-tone={status?.held ? "caution" : status?.error && !working ? "error" : undefined}>
          <i className="dot" data-tone={status?.held ? "held" : status?.error && !working ? "error" : "ok"} />
          <span>{line}</span>
          {status?.running && <button className="btn sm ghost" onClick={() => void agents.interrupt(sessionId)}>停止</button>}
        </div>
      )}
      <Composer
        canvasId={session.canvasId}
        canvasTitle={canvasTitle}
        agentName={AGENT_NAMES[binding.agent]}
        route={status?.terminal.alive ? "terminal" : "headless"}
        onSend={send}
      />
    </div>
  );
}

/** 对话 view: per turn — header with usage, the person's message, the process folded into one line, canvas changes, the answer. */
function Conversation({ sessionId, turns, changes, canvasTitles, flash, onTrajectory }: { sessionId: string; turns: TrajTurn[]; changes: Turn[]; canvasTitles: Record<string, string>; flash: string | null; onTrajectory: (n: number) => void }) {
  // Canvas changes belong to the turn they happened in (by time); ones before any turn stand alone.
  const byTurn = new Map<number, Turn[]>();
  const loose: Turn[] = [];
  for (const c of changes) {
    const t = [...turns].reverse().find((t) => t.startedAt <= c.startedAt);
    if (t) byTurn.set(t.n, [...(byTurn.get(t.n) ?? []), c]);
    else loose.push(c);
  }
  const card = (c: Turn) => <TurnCard key={c.id} t={c} canvasTitle={canvasTitles[c.canvasId]} flash={flash === c.id} />;
  return (
    <div className="ds-convo">
      {loose.map(card)}
      {turns.map((t) => (
        <article key={t.n} className="ds-convo-turn">
          <header className="ds-convo-head">
            <b>第 {t.n} 轮</b>
            {t.source === "terminal" && <span className="ds-tag">终端</span>}
            <time>{clock(t.startedAt)}</time>
            <UsageMeta model={t.model} effort={t.effort} usage={t.usage} durationMs={t.durationMs} compact />
            <button onClick={() => onTrajectory(t.n)} title="在轨迹里看这一轮">轨迹</button>
          </header>
          {t.user && (
            <div className="ds-user" data-source={t.user.source}>
              <p>{t.user.text}</p>
            </div>
          )}
          <ProcessFold sessionId={sessionId} turn={t} />
          {(byTurn.get(t.n) ?? []).map(card)}
          {t.reply?.text && <Markdown className="ds-say" text={t.reply.text} />}
          {t.error && !t.running && <p className="ds-say" data-error>这一轮出错：{t.error}</p>}
        </article>
      ))}
    </div>
  );
}

const kindLabel = (t: Turn) => {
  const anim = t.request.startsWith("动画「");
  if (t.status === "running") return anim ? "正在挂载动画" : "正在改画布";
  if (t.status === "applied") return anim ? "加了动画" : "改了画布";
  return anim ? "动画未挂载" : "改图未执行";
};

function TurnCard({ t, canvasTitle, flash }: { t: Turn; canvasTitle?: string; flash: boolean }) {
  const hover = (ids: string[] | undefined) => highlight.set(ids?.length ? { canvasId: t.canvasId, ids } : null);
  const touched = t.steps.find((x) => x.kind === "apply")?.elements ?? [];
  const api = canvases.get(t.canvasId)?.api;
  const detail = t.steps.map((s) => s.detail).filter(Boolean).join(" · ");
  return (
    <article className="sp-change" data-status={t.status} data-turn={t.id} data-flash={flash} onPointerEnter={() => hover(touched)} onPointerLeave={() => hover(undefined)}>
      {t.origin.kind === "comment" && (
        <button className="chip sp-origin" onClick={() => t.origin.kind === "comment" && ui.openThread(t.canvasId, t.origin.threadId)} title={`来自「${canvasTitle ?? "画布"}」的评论 #${t.origin.threadN}，点击在画布中打开`}>
          <IconCommentSolid size={12} />
          <span>#{t.origin.threadN} · {t.origin.anchor}</span>
        </button>
      )}
      <div className="sp-change-head">
        <span className="sp-change-kind">{kindLabel(t)}</span>
        <span className="sp-change-title">{t.request}</span>
        <time>{clock(t.startedAt)}</time>
      </div>
      <AnimatePresence>
        {t.reply && (
          <motion.div className="sp-change-body" data-tone={t.reply.tone} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            {t.reply.changes ? <ul data-undone={!!t.reply.undone}>{t.reply.changes.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p>{t.reply.text}</p>}
            {t.reply.undoError && <p className="sp-warn">{t.reply.undoError}</p>}
            <div className="sp-change-actions">
              {t.reply.batchId && (t.reply.undone ? <span className="sp-undone">已撤销</span> : <button className="btn sm ghost" disabled={!api} onClick={() => api && undoTurn(api, t.id)}><IconUndo size={14} />撤销这次修改</button>)}
              {touched.length > 0 && !t.reply.undone && (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    ui.focusPane(t.canvasId);
                    highlight.set({ canvasId: t.canvasId, ids: touched });
                    setTimeout(() => highlight.get()?.ids === touched && highlight.set(null), 2600);
                  }}
                >
                  <IconTarget size={14} />在画布中高亮
                </button>
              )}
              <time title={detail}>{t.endedAt ? fmt(t.endedAt - t.startedAt) : ""}</time>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}
