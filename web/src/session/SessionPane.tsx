// A session pane: one native coding-agent session (Pi, Claude Code or Codex), picked when the
// session starts and fixed after that. The conversation is the CLI's own log (followed live
// by the server), so what is said here, in a headless turn, or in the terminal after
// "在终端打开" all shows up in one transcript; the canvas changes the agent made through the
// agora-canvas skill appear in it as cards with undo.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { SPRING } from "../comments/motion";
import "./design.css";
import { Composer } from "./Composer";
import { AGENT_KINDS, AGENT_NAMES, agents, useAgents, type AgentKind, type Catalog, type Item } from "./agents";
import { undoTurn } from "./runTurn";
import { sessions, useSessions, type Turn } from "./store";
import { agentChoice, canvases, highlight, ui } from "./ui";
import "./session.css";

const fmt = (ms: number) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const COLORS: Record<AgentKind, { bg: string; ink: string }> = {
  pi: { bg: "#c8b5f4", ink: "#352a50" },
  claude: { bg: "#f3c7a6", ink: "#5a3217" },
  codex: { bg: "#bfe3cd", ink: "#1f4a31" },
};

export function SessionPane({ sessionId, canvasTitles }: { sessionId: string; canvasTitles: Record<string, string> }) {
  const { sessions: all } = useSessions();
  const ag = useAgents();
  const session = all[sessionId];
  if (!session) return <div className="sp-empty">会话不存在</div>;
  const binding = ag.bindings[sessionId];
  if (!binding) return <Chooser sessionId={sessionId} canvasTitle={canvasTitles[session.canvasId]} />;
  return <AgentSession sessionId={sessionId} canvasTitles={canvasTitles} />;
}

function AgentMark({ kind, size = 22 }: { kind: AgentKind; size?: number }) {
  const c = COLORS[kind];
  return (
    <span className="d-avatar" style={{ width: size, height: size, background: c.bg, color: c.ink, fontSize: size * 0.42 }}>
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
        {waiting && <p className="sp-choose-wait">有一条画布评论在等这个会话，选好后会自动交给它。</p>}
        <div className="sp-agents" role="radiogroup" aria-label="Agent">
          {AGENT_KINDS.map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} data-on={kind === k} disabled={cat ? !cat[k].installed : false} onClick={() => setKind(k)}>
              <AgentMark kind={k} size={26} />
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
          <button className="d-chip-btn" disabled={busy || !cat} onClick={() => void start()}>用 {AGENT_NAMES[kind]} 开始</button>
          {waiting && <button className="d-chip-btn ghost" onClick={() => agentChoice.resolve(sessionId, undefined)}>先不交</button>}
        </div>
      </div>
    </div>
  );
}

type Entry = { at: number; key: string } & ({ item: Item } | { turn: Turn });

function AgentSession({ sessionId, canvasTitles }: { sessionId: string; canvasTitles: Record<string, string> }) {
  const { sessions: all, turns } = useSessions();
  const ag = useAgents();
  const session = all[sessionId];
  const binding = ag.bindings[sessionId]!;
  const status = ag.status[sessionId];
  const items = ag.items[sessionId] ?? [];
  const scroll = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [termMsg, setTermMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canvasTitle = canvasTitles[session.canvasId];
  const inflight = ag.inflight[sessionId];
  const working = !!(status?.running || status?.busy || inflight);

  const entries: Entry[] = [
    ...items.map((item) => ({ at: item.at, key: `i-${item.id}`, item })),
    ...session.turnIds.map((id) => turns[id]).filter(Boolean).map((turn) => ({ at: turn.startedAt, key: `t-${turn.id}`, turn })),
  ].sort((a, b) => a.at - b.at);

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
  }, [entries.length]);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!session.turnIds.includes(id)) return;
      setTimeout(() => {
        document.querySelector(`[data-turn="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setFlash(id);
        setTimeout(() => setFlash(null), 1600);
      }, 80);
    };
    addEventListener("agora:turn", on);
    return () => removeEventListener("agora:turn", on);
  }, [session]);

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

  return (
    <div className="sp" data-agent={binding.agent}>
      <header className="sp-head">
        <AgentMark kind={binding.agent} />
        <div className="sp-title">
          <h2>
            {AGENT_NAMES[binding.agent]}
            <span className="sp-lock" title="创建会话时选定，不能更改">{binding.model || "默认模型"}{binding.effort ? ` · ${binding.effort}` : ""}</span>
          </h2>
          <p>
            <select value={session.canvasId} onChange={(e) => sessions.relink(sessionId, e.target.value)} aria-label="关联画布">
              {Object.entries(canvasTitles).map(([id, t]) => <option key={id} value={id}>{t}</option>)}
              {!canvasTitles[session.canvasId] && <option value={session.canvasId}>已删除的画布</option>}
            </select>
            <span title={binding.nativeId ?? "第一轮后生成"}>· 原生会话 {binding.nativeId ? binding.nativeId.slice(0, 8) : "（第一轮后生成）"}</span>
          </p>
        </div>
        {status?.terminal.alive ? (
          <span className="sp-term">
            <button className="d-chip-btn ghost" onClick={() => void openTerminal()} title="再开一个窗口连到同一个终端">终端已接管{status.terminal.clients ? ` · ${status.terminal.clients} 个窗口` : ""}</button>
            <button className="d-chip-btn ghost" onClick={() => void agents.closeTerminal(sessionId)} title="结束终端里的 CLI；会话可随时再续接">关闭终端</button>
          </span>
        ) : (
          <button className="d-chip-btn" disabled={!!status?.running} onClick={() => void openTerminal()} title={status?.running ? "这一轮结束后再打开" : "用终端打开这个会话，直接在里面做 coding"}>
            在终端打开
          </button>
        )}
      </header>
      {(status?.terminal.alive || termMsg) && (
        <div className="sp-attach">
          {termMsg && <span>{termMsg}</span>}
          {status?.terminal.alive && (
            <>
              <code title="在任意终端里运行，连到这个会话">{status.terminal.attach}</code>
              <button className="d-chip-btn ghost" onClick={() => void copy()}>{copied ? "已复制" : "复制"}</button>
            </>
          )}
        </div>
      )}
      <div className="d-rail-scroll sp-scroll" ref={scroll}>
        {!entries.length && (
          <div className="sp-hello">
            <p>和 {AGENT_NAMES[binding.agent]} 讨论「{canvasTitle ?? "画布"}」的架构；它用 agora-canvas skill 读图、改图、做算法动画。</p>
            <p>画布评论「交给 Agent」也会来到这里。想直接写代码时点「在终端打开」，两边说的话会同步。</p>
          </div>
        )}
        {entries.map((e) =>
          "item" in e ? <ItemView key={e.key} it={e.item} /> : <TurnCard key={e.key} t={e.turn} canvasTitle={canvasTitles[e.turn.canvasId]} flash={flash === e.turn.id} />,
        )}
      </div>
      {line && (
        <div className="sp-status" data-tone={status?.held ? "held" : status?.error && !working ? "error" : "run"}>
          {working && <span className="sp-dot" />}
          <span>{line}</span>
          {status?.running && <button className="d-chip-btn ghost" onClick={() => void agents.interrupt(sessionId)}>停止</button>}
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

function ItemView({ it }: { it: Item }) {
  if (it.kind === "user")
    return (
      <div className="d-user sp-user" data-source={it.source}>
        <p>{it.text}</p>
        <time>{it.source === "terminal" ? "终端 · " : ""}{clock(it.at)}</time>
      </div>
    );
  if (it.kind === "assistant")
    return (
      <div className="d-reply sp-say">
        <p>{it.text}</p>
      </div>
    );
  const t = it.tool ?? {};
  return (
    <details className="sp-tool" data-error={!!t.isError}>
      <summary>
        <b>{t.name || "tool"}</b>
        <span>{t.input}</span>
      </summary>
      {t.output && <pre>{t.output}</pre>}
    </details>
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
    <article className="d-turn sp-turn sp-change" data-status={t.status} data-turn={t.id} data-flash={flash} onPointerEnter={() => hover(touched)} onPointerLeave={() => hover(undefined)}>
      {t.origin.kind === "comment" && (
        <button className="d-origin sp-origin" onClick={() => t.origin.kind === "comment" && ui.openThread(t.canvasId, t.origin.threadId)} title="在画布中打开这条评论">
          来自评论 <b>#{t.origin.threadN}</b> · {canvasTitle ?? "画布"} · {t.origin.anchor}
          <span className="d-origin-link">在画布中打开</span>
        </button>
      )}
      <div className="sp-change-head">
        <span className="sp-change-kind">{kindLabel(t)}</span>
        <span className="sp-change-title">{t.request}</span>
        <time>{clock(t.startedAt)}</time>
      </div>
      <AnimatePresence>
        {t.reply && (
          <motion.div className="d-reply" data-tone={t.reply.tone} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
            {t.reply.changes ? <ul data-undone={!!t.reply.undone}>{t.reply.changes.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p>{t.reply.text}</p>}
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
              <span className="d-meta" title={detail}>{t.endedAt ? fmt(t.endedAt - t.startedAt) : ""}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}
