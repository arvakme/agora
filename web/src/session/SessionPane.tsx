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
import { chooserView, type CatalogState } from "./chooserModel";
import { ConflictNotice } from "../multi/ConflictNotice";
import { AnimatePresence, motion } from "motion/react";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { IconChevron, IconCode, IconCommentSolid, IconCopy, IconLayers, IconLock, IconMore, IconPath, IconTarget, IconUndo } from "../app/icons";
import { panelView, replayTime, useReplay, useTick, type PanelView } from "../workstation/clock";
import { usePlay } from "../workstation/replayMode";
import { useRuns } from "../workstation/runs/store";
import { panelPlays } from "./replayStep";
import { Markdown } from "./markdown";
import { ProcessFold, TrajectoryView } from "./TrajectoryView";
import { TraceTurn } from "./TraceTurn";
import { buildTurns, fmtCost, fmtDuration, fmtTokens, sumUsage, type TrajTurn } from "./trajectoryModel";
import { SPRING } from "../comments/motion";
import { Composer } from "./Composer";
import { InputRight } from "./InputRight";
import { RequestCards } from "./RequestCards";
import { modeLabel, waitLabel } from "./requestModel";
import { canvasChoices, topOf } from "./canvasChoices";
import { useNested } from "../nested/store";
import { AGENT_NAMES, agents, effortChoices, forkHeadless, loadAdapters, sessionKinds, useAgents, type AgentKind, type Catalog, type TerminalApps } from "./agents";
import { AgentAvatar } from "./AgentAvatar";
import { Picker } from "./Picker";
import { effortGroups, modelGroups } from "./pickerModel";
import { TerminalAppIcon } from "../app/terminals/TerminalAppIcon";
import { undoTurn } from "./runTurn";
import { sessions, useSessions, type Turn } from "./store";
import { agentChoice, canvases, draftText, highlight, openSessions, ui } from "./ui";
import { JumpPill, useJumpToBottom } from "./JumpPill";
import "./session.css";

const fmt = (ms: number) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
const clock = (at: number) => new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

export function SessionPane({ sessionId, canvasTitles }: { sessionId: string; canvasTitles: Record<string, string> }) {
  // a session with an open tab: "交给 Agent" starts from the ones the person has open
  useEffect(() => (openSessions.mount(sessionId), () => void openSessions.unmount(sessionId)), [sessionId]);
  const { sessions: all } = useSessions();
  const ag = useAgents();
  const session = all[sessionId];
  if (!session) return <div className="sp-empty">会话不存在</div>;
  const binding = ag.bindings[sessionId];
  const origin = ag.origins[sessionId];
  // A session made on another machine, or whose binding is only in this machine's registry: never
  // the agent picker (that would start a new, unrelated conversation under its name).
  if (!binding && origin && origin.state !== "copy") return <OriginCard sessionId={sessionId} origin={origin} canvasTitles={canvasTitles} />;
  if (!binding) return <Chooser sessionId={sessionId} canvasTitle={canvasTitles[session.canvasId]} />;
  return <AgentSession sessionId={sessionId} canvasTitles={canvasTitles} />;
}

/** Start a new session of the same agent and model on a canvas, and open it (the old one stays as it is). */
async function freshSession(canvasId: string, agent: AgentKind, model = "", effort = "", firstText?: string) {
  const s = sessions.create(canvasId, undefined, { draft: true });
  await agents.bind(s.id, agent, model, effort);
  if (firstText) draftText.set(s.id, firstText);
  ui.openSession(s.id);
  return s.id;
}

/**
 * A listed session with no binding on this machine (server/canvas/local.py `session_origins`):
 * - recoverable: this machine's registry still has its binding (`.agora/sessions/` was lost) → 恢复;
 * - other-copy: another copy of the project here owns it → 在这里分叉继续;
 * - foreign: made on another machine → read-only card; 在这里开新会话 (same canvas and agent).
 */
function OriginCard({ sessionId, origin, canvasTitles }: { sessionId: string; origin: import("../persist").Origin; canvasTitles: Record<string, string> }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agent = (origin.agent ?? "claude") as AgentKind;
  const name = AGENT_NAMES[agent];
  const canvasId = origin.canvasId ?? sessions.get().sessions[sessionId]?.canvasId ?? "";
  const canvas = canvasTitles[canvasId];
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const restore = () => act(() => agents.bind(sessionId, agent, origin.model ?? "", origin.effort ?? "", origin.nativeId ?? null, origin.started ?? !!origin.nativeId));
  const fork = () => act(() => agents.fork(sessionId, origin));
  const fresh = () => act(() => freshSession(canvasTitles[canvasId] ? canvasId : Object.keys(canvasTitles)[0] ?? "", agent, origin.model, origin.effort));
  const [title, text] =
    origin.state === "recoverable"
      ? ["可以恢复", `这个 ${name} 会话在本机的注册表里有记录，但项目里的绑定不见了（.agora/sessions/ 被清掉？）。${origin.log === "found" ? "原生对话还在，恢复后照常续接。" : "原生对话在这台机器上没找到；恢复后只能查看 Agora 保存的轨迹。"}`]
      : origin.state === "other-copy"
        ? ["属于另一份副本", `这个 ${name} 会话由本机的另一份项目（${origin.root}）在用。两份项目不能续接同一个原生会话：可以在这里分叉一份继续（保留之前的对话）。`]
        : ["来自另一台机器", `这个 ${name} 会话是在另一台机器上（或别的位置）建的，对话记录不在这台机器上。`];
  return (
    <div className="sp">
      <div className="sp-choose sp-origin" data-state={origin.state}>
        <div className="sp-origin-head">
          <AgentAvatar kind={agent} size={40} />
          <div>
            <h2>{origin.topic ? `${name} · ${origin.topic}` : name}</h2>
            <p className="sp-meta">
              <span className="sp-lock"><IconLock size={12} />{origin.model || "默认模型"}{origin.effort ? ` · ${origin.effort}` : ""}</span>
              <span className="sp-sep" aria-hidden>·</span>
              <span>{canvas ? `画布「${canvas}」` : canvasId ? "画布不在这个工作区" : "未关联画布"}</span>
              {origin.nativeId && <code className="sp-native" title="原生会话 id">{origin.nativeId.slice(0, 8)}</code>}
            </p>
          </div>
        </div>
        <p className="notice" data-tone={origin.state === "foreign" ? "caution" : undefined}>
          <b>{title}</b>
          <span>{text}</span>
        </p>
        {err && <p className="sp-warn">{err}</p>}
        <div className="sp-choose-go">
          {origin.state === "recoverable" && <button className="btn primary" disabled={busy} onClick={() => void restore()}>恢复这个会话</button>}
          {origin.state === "other-copy" && <button className="btn primary" disabled={busy} onClick={() => void fork()}>在这里分叉继续</button>}
          <button className={origin.state === "foreign" ? "btn primary" : "btn ghost"} disabled={busy} onClick={() => void fresh()}>在这里开新会话</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 「画在：<画布>」: the diagram this session edits, draws its figure on and takes comments from. Only top-level canvases are
 * choices (a sub-diagram is in the tree of the canvas it opens from); with one there is no dropdown, only the words.
 */
function CanvasChoice({ canvasId, canvasTitles, onPick }: { canvasId: string; canvasTitles: Record<string, string>; onPick: (id: string) => void }) {
  const { index } = useNested();
  const choices = canvasChoices(canvasTitles, index);
  const top = topOf(canvasId, index);
  const gone = !canvasTitles[canvasId];
  const tip = "这个会话改图、画小人、接评论时用的图";
  if (choices.length <= 1 && !gone)
    return (
      <span className="sp-cv" title={tip}>
        <i className="sp-cv-sq" aria-hidden />
        <span className="sp-cv-t">画在：{canvasTitles[top] ?? choices[0]?.title ?? ""}</span>
      </span>
    );
  return (
    <label className="sp-cv" title={tip}>
      <i className="sp-cv-sq" aria-hidden />
      <span className="sp-cv-t">画在：</span>
      <select value={gone ? canvasId : top} onChange={(e) => onPick(e.target.value)} aria-label="这个会话画在哪张图上">
        {choices.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        {gone && <option value={canvasId}>{canvasId ? "已删除的画布" : "未关联画布"}</option>}
      </select>
    </label>
  );
}

/** Pick the session's agent, model and effort. Once started this never changes. */
function Chooser({ sessionId, canvasTitle }: { sessionId: string; canvasTitle?: string }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  // the model list: loading, failed (the session then starts on the CLI's defaults) or ready — session/chooserModel.ts
  const [catState, setCatState] = useState<CatalogState>("loading");
  const [kind, setKind] = useState<AgentKind>("claude");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = agentChoice.pending(sessionId);
  // The session agents (tier T1) from the server's adapter registry; the built-in three until it answers.
  const [kinds, setKinds] = useState<AgentKind[]>(sessionKinds());
  const loadCatalog = () => {
    setCatState("loading");
    setErr(null);
    agents.catalog().then((c) => (setCat(c), setCatState("ready")), () => setCatState("failed"));
  };
  useEffect(() => {
    loadCatalog();
    void loadAdapters().then(() => setKinds(sessionKinds()));
  }, []);
  useEffect(() => {
    if (cat?.[kind]) setModel(cat[kind].default || cat[kind].featured[0] || "");
  }, [cat, kind]);
  const c = cat?.[kind];
  // The levels this model really takes (from the CLI's own catalog); switching model starts on its default.
  const eff = effortChoices(c, model);
  const view = chooserView(catState, { hasLevels: eff.levels.length > 0 });
  useEffect(() => {
    setEffort(eff.initial);
  }, [c, model]);
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
  const models = useMemo(() => modelGroups(c), [c]);
  const efforts = useMemo(() => effortGroups(eff), [eff.levels.join(), eff.initial, eff.cliDefault]);
  const scopeNote = !c
    ? null
    : c.scope?.kind === "enabledModels"
      ? { text: `只列 Pi 设置里启用的 ${c.models.length} 个模型（enabledModels）`, title: c.scope.source ? `来自 ${c.scope.source}` : undefined }
      : kind === "pi" && c.scope?.kind === "available"
        ? { text: `Pi 没有设置 enabledModels：列出已配置凭据的 ${c.models.length} 个模型`, title: "在 ~/.pi/agent/settings.json 或项目 .pi/settings.json 里设置 enabledModels 可以收窄范围" }
        : null;
  return (
    <div className="sp">
      <div className="sp-choose sp-choose2">
        <h2>选一个 agent 来讨论「{canvasTitle ?? "这张图"}」</h2>
        <p>它会一直是这个会话的 agent：先在图上和你讨论架构，再去写代码；你在图上看得到它在哪干活。选定后不能更改。</p>
        {waiting && (
          <p className="notice" data-tone="caution">
            <b>在等你</b>
            <span>有一条画布评论在等这个会话，选好后会自动交给它。</span>
          </p>
        )}
        <div className="sp-cards" role="radiogroup" aria-label="Agent">
          {kinds.map((k) => {
            const e = cat?.[k];
            const def = e ? e.default || e.featured[0] || "默认模型" : "";
            return (
              <button key={k} role="radio" aria-checked={kind === k} data-on={kind === k} disabled={cat ? !cat[k]?.installed : false} onClick={() => setKind(k)}>
                <AgentAvatar kind={k} size={32} />
                <span className="sp-card-t">
                  <b>{AGENT_NAMES[k] ?? k}</b>
                  <span>{AGENT_BLURB[k] ?? ""}{def ? `${AGENT_BLURB[k] ? " · " : ""}${e?.names?.[def] ?? def}` : ""}</span>
                </span>
                {cat && !cat[k]?.installed && <em>未安装</em>}
              </button>
            );
          })}
        </div>
        <div className="sp-choose-row">
          <Picker label="模型" value={model} onChange={setModel} groups={view.fields ? models : []} disabled={!c || !view.fields} valueLabel={view.model} placeholder="搜索模型或 provider" />
          <Picker
            label="强度"
            value={effort}
            onChange={setEffort}
            groups={view.fields ? efforts : []}
            disabled={!c || !view.fields || !eff.levels.length}
            compact
            valueLabel={view.effort}
            title={eff.levels.length ? `${model || "默认模型"} 支持：${eff.levels.join(" / ")}` : view.fields ? "这个 CLI 不分强度：不传强度参数" : undefined}
          />
        </div>
        {view.note && (
          <p className="sp-choose-note" role="status">
            {view.note}
            {view.retry && <button className="btn sm ghost" onClick={loadCatalog}>重试</button>}
          </p>
        )}
        {scopeNote && <p className="sp-choose-note" title={scopeNote.title}>{scopeNote.text}</p>}
        {err && <p className="sp-warn">{err}</p>}
        <div className="sp-choose-go">
          <button className="btn primary" disabled={busy || !view.canStart} onClick={() => void start()}>用 {AGENT_NAMES[kind]} 开始</button>
          {waiting && <button className="btn ghost" onClick={() => agentChoice.resolve(sessionId, undefined)}>先不交</button>}
        </div>
        <p className="sp-choose-later">也可以直接在右边画，之后再开会话。</p>
      </div>
    </div>
  );
}

/** What each agent is good for, in one line (the picker's cards). */
const AGENT_BLURB: Record<string, string> = { pi: "快，适合边画边聊", claude: "擅长大改动，能派子代理", codex: "适合按清单写代码和测试", grok: "xAI 出品，读写代码，能派子代理", cursor: "多种模型可选，读写代码，能派子代理", devin: "Cognition 出品，读写代码，工具默认不用批准" };

function AgentSession({ sessionId, canvasTitles }: { sessionId: string; canvasTitles: Record<string, string> }) {
  const { sessions: all, turns: canvasTurns } = useSessions();
  const ag = useAgents();
  const session = all[sessionId];
  const binding = ag.bindings[sessionId]!;
  const status = ag.status[sessionId];
  const items = ag.items[sessionId] ?? [];
  const scroll = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [termNote, setTermNote] = useState<string | null>(null); // what the last 在终端打开 / 复制打开命令 could not do, or did: a few seconds
  const [view, setView] = useState<PanelView>("chat");
  // A turn of this session plays on the diagram (▶ on a turn): the pane goes to the trajectory, which follows the play
  // (later steps greyed, the current one marked, the controls on top), and comes back to the view it had when the play ends.
  const replay = useReplay();
  const played = usePlay().play;
  const runsNow = useRuns();
  const playing = !!played && runsNow.byId.get(played.runId)?.sessionId === sessionId;
  const savedView = useRef<PanelView | null>(null);
  useEffect(() => {
    const next = panelPlays({ view, saved: savedView.current }, playing, "trajectory");
    savedView.current = next.saved;
    if (next.view !== view) setView(next.view);
  }, [playing]);
  const waitNow = useTick(1000, !!status?.waiting); // 「等你 N 分钟」 counts on
  const playNow = useTick(250, playing && !!replay?.playing); // the play moves on the wall clock: re-read it 4 times a second
  const playAt = playing && replay ? replayTime(replay, replay.playing ? playNow : Date.now()) : null;
  const [focusTurn, setFocusTurn] = useState<{ n: number; key: number } | null>(null);
  const [focusItem, setFocusItem] = useState<{ id: string; n?: number; key: number } | null>(null);
  const canvasTitle = canvasTitles[session.canvasId];
  const inflight = ag.inflight[sessionId];
  const working = !!(status?.running || status?.busy || inflight);
  const turns = useMemo(() => buildTurns(items, { model: binding.model, effort: binding.effort }, !!(status?.running || status?.busy)), [items, binding.model, binding.effort, status?.running, status?.busy]);
  const total = useMemo(() => sumUsage(turns), [turns]);
  const changes = session.turnIds.map((id) => canvasTurns[id]).filter(Boolean);

  // 「回到最新」: at the end the chat follows new messages; scrolled up it does not, and the pill says how many came (./JumpPill.tsx)
  const jump = useJumpToBottom(scroll, items.length + changes.length, false, view);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!session.turnIds.includes(id)) return;
      setView((v) => panelView(v, "turn"));
      setTimeout(() => {
        document.querySelector(`[data-turn="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        setFlash(id);
        setTimeout(() => setFlash(null), 1600);
      }, 80);
    };
    const onTraj = (e: Event) => {
      const d = (e as CustomEvent<{ sessionId: string; turn: number }>).detail;
      if (d.sessionId !== sessionId) return;
      setView((v) => panelView(v, "trajectory"));
      setFocusTurn({ n: d.turn, key: Date.now() });
    };
    // a stop clicked on the canvas: the trajectory scrolls to its step (or the turn's head when it has none)
    const onStep = (e: Event) => {
      const d = (e as CustomEvent<{ sessionId: string; itemId: string | null; turn?: number }>).detail;
      if (d.sessionId !== sessionId) return;
      setView((v) => panelView(v, "step"));
      if (d.itemId) setFocusItem({ id: d.itemId, n: d.turn, key: Date.now() });
      else if (d.turn != null) setFocusTurn({ n: d.turn, key: Date.now() });
    };
    addEventListener("agora:turn", on);
    addEventListener("agora:trajectory", onTraj);
    addEventListener("agora:step", onStep);
    return () => (removeEventListener("agora:turn", on), removeEventListener("agora:trajectory", onTraj), removeEventListener("agora:step", onStep));
  }, [session, sessionId]);
  const send = async (text: string, refs: Turn["refs"]) => {
    const selected = Object.keys(canvases.get(session.canvasId)?.api.getAppState().selectedElementIds ?? {});
    const notes = [
      refs.length ? `引用的画布元素：${refs.map((r) => `${r.label}（${r.id}）`).join("、")}` : "",
      selected.length ? `当前选区：${selected.join(", ")}` : "",
    ].filter(Boolean);
    await agents.send(sessionId, notes.length ? `${text}\n\n（${notes.join("；")}）` : text, { canvasId: session.canvasId });
  };
  const [termMenu, setTermMenu] = useState(false);
  const [apps, setApps] = useState<TerminalApps | null>(null);
  useEffect(() => {
    if (termMenu) void agents.terminalApps().then(setApps).catch(() => setApps(null));
  }, [termMenu]);
  const openTerminal = async () => {
    setTermNote(null);
    setTermMenu(false);
    try {
      const r = await agents.openTerminal(sessionId, session.canvasId, true);
      // a window that opened says so by itself (the input-right note below); only what did not work needs words
      setTermNote(r.launched ? null : "没找到可用的终端：用「复制打开命令」在任意终端里打开");
    } catch (e) {
      setTermNote((e as Error).message);
    }
  };
  /** Fallback for any terminal: start Agora's pane, copy the attach command. */
  const copyOpen = async () => {
    setTermMenu(false);
    setTermNote(null);
    try {
      const r = await agents.openTerminal(sessionId, session.canvasId, false);
      await navigator.clipboard?.writeText(`env -u TMUX ${r.attach}`).catch(() => {});
      setTermNote("已复制命令：在任意终端里新开一个窗口粘贴运行");
    } catch (e) {
      setTermNote((e as Error).message);
    }
  };
  useEffect(() => {
    if (!termNote) return;
    const t = setTimeout(() => setTermNote(null), 6000);
    return () => clearTimeout(t);
  }, [termNote]);

  const [staleSeen, setStaleSeen] = useState(() => staleKnown(sessionId));
  // Copied along with the project (cp -r): read-only until forked here. A pending fork: the next
  // message (Claude, Pi) or the terminal (all three; Codex only there) continues it as a new native session.
  const copyOf = status?.copy ?? null;
  const fork = binding.pendingFork ?? null;
  // The native log is gone / ambiguous: read-only, no terminal, no sending (never a silent new conversation).
  const native = status?.native ?? null;
  const stuck = (!!native?.blocking && !status?.terminal.alive && !fork) || !!copyOf;
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
      {/* One line: the model (fixed at creation) and the canvas; the name is already on the tab. */}
      <header className="sp-head sp-head1">
        <span className="sp-lock" title="创建会话时选定，不能更改">
          <IconLock size={12} />
          {binding.model || "默认模型"}{binding.effort ? ` · ${binding.effort}` : ""}
        </span>
        {status?.waiting && <span className="sp-waited" title="它在等你回答；不会自动拒绝，回答或停止之前一直等">{waitLabel(status.waitingSince, waitNow)}</span>}
        {modeLabel(status?.mode) && (
          <span className="sp-mode" data-tone={modeLabel(status?.mode)!.tone} title="Claude 这一轮实际的权限模式：auto 由它自己判断哪些要问你">
            {modeLabel(status?.mode)!.text}
          </span>
        )}
        <span className="sp-sep" aria-hidden>·</span>
        <CanvasChoice canvasId={session.canvasId} canvasTitles={canvasTitles} onPick={(id) => sessions.relink(sessionId, id)} />
        <span className="grow" />
        <button className="icon-btn sm" aria-pressed={view === "trajectory"} data-on={view === "trajectory"} onClick={() => setView((v) => panelView(v, "toggle"))} title={view === "trajectory" ? "回到对话" : "轨迹：每一步做了什么"} aria-label="轨迹">
          <IconPath size={16} />
        </button>
        <button
          className="icon-btn sm"
          disabled={(!status?.terminal.alive && !!status?.running) || stuck}
          onClick={() => void openTerminal()}
          title={status?.terminal.alive ? "再开一个 Kitty 窗口连到同一个终端" : status?.running ? "这一轮结束后再打开" : "在 Kitty 中打开，直接在里面做 coding"}
          aria-label="在终端打开"
        >
          <TerminalAppIcon />
        </button>
        <div className="sp-term">
          <button className="icon-btn sm" aria-haspopup="dialog" aria-expanded={termMenu} aria-label="用量与更多" title="用量、会话 id、在哪个终端打开" onClick={() => setTermMenu((v) => !v)}>
            <IconMore size={16} />
          </button>
          <AnimatePresence>
            {termMenu && (
              <motion.div className="menu sp-term-menu sp-stats" role="dialog" aria-label="用量与更多" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2, transition: { duration: 0.1 } }} transition={SPRING}>
                <dl>
                  <dt>轮数</dt>
                  <dd>{turns.length} 轮</dd>
                  <dt>耗时</dt>
                  <dd>{totalMs != null ? fmtDuration(totalMs) : "—"}</dd>
                  <dt>花费</dt>
                  <dd>{fmtCost(total.cost)}</dd>
                  <dt>tokens</dt>
                  <dd>{fmtTokens(total.input)} 入 · {fmtTokens(total.output)} 出{total.cacheRead != null && total.input ? ` · 缓存 ${Math.round((total.cacheRead / (total.input + total.cacheRead)) * 100)}%` : ""}</dd>
                  <dt>会话 id</dt>
                  <dd className="mono">{binding.nativeId ? binding.nativeId.slice(0, 8) : "第一轮后生成"}</dd>
                </dl>
                <hr />
                <p className="menu-title">在哪里打开</p>
                <button
                  role="menuitem"
                  disabled={!status?.terminal.alive && !!status?.running}
                  title={apps && !apps.kitty ? "没装 Kitty：会改用 macOS 终端" : "在 Kitty 窗口里打开这个会话的终端"}
                  onClick={() => void openTerminal()}
                >
                  <span className="menu-check" />
                  <TerminalAppIcon />
                  在 Kitty 中打开
                  {apps && !apps.kitty && <em className="menu-note">用终端</em>}
                </button>
                <button role="menuitem" disabled={!status?.terminal.alive && !!status?.running} onClick={() => void copyOpen()} title="在任意终端里新开窗口粘贴运行">
                  <span className="menu-check" />
                  <IconCopy size={16} />
                  复制打开命令
                </button>
                {status?.terminal.alive && (
                  <button role="menuitem" onClick={() => (setTermMenu(false), void agents.closeTerminal(sessionId))} title="结束终端里的 CLI；会话可随时再续接">
                    <span className="menu-check" />
                    关闭终端
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {termMenu && <div className="menu-scrim sp-term-scrim" onPointerDown={() => setTermMenu(false)} />}
        </div>
      </header>
      <ConflictNotice sessionId={sessionId} />
      {termNote && (
        <div className="notice sp-attach" data-tone="caution" role="status">
          <span>{termNote}</span>
        </div>
      )}
      {view === "trajectory" ? (
        <div className="sp-traj">
          <TrajectoryView sessionId={sessionId} turns={turns} focusTurn={focusTurn} focusItem={focusItem} agent={binding.agent} cutoff={playAt} working={working} play={playing && played && playAt != null ? { n: played.n, at: playAt } : null} />
        </div>
      ) : (
        <div className="sp-stage">
        <div className="sp-scroll" ref={scroll}>
          {!turns.length && !changes.length && (
            <div className="sp-hello">
              <p>怎么用「{canvasTitle ?? "画布"}」：</p>
              <ol>
                <li>在这里告诉 {AGENT_NAMES[binding.agent]} 你要做什么；</li>
                <li>它干活时，左边图上的小人会带你看它在改哪里；点小人可以直接对它说话；</li>
                <li>在图上留评论，点「交给 {AGENT_NAMES[binding.agent]}」让它处理。</li>
              </ol>
            </div>
          )}
          <Conversation sessionId={sessionId} turns={turns} changes={changes} canvasTitles={canvasTitles} flash={flash} onTrajectory={(n) => (setView((v) => panelView(v, "trajectory")), setFocusTurn({ n, key: Date.now() }))} />
          {working && <LiveLine sessionId={sessionId} />}
        </div>
        <JumpPill show={jump.show} unread={jump.unread} running={working} onJump={jump.jump} />
        </div>
      )}
      {line && !(status?.running && !status?.held) && (
        <div className="notice sp-status" data-tone={status?.held ? "caution" : status?.error && !working ? "error" : undefined}>
          <i className="dot" data-tone={status?.held ? "held" : status?.error && !working ? "error" : "ok"} />
          <span>{line}</span>
          {status?.running && <button className="btn sm ghost" onClick={() => void agents.interrupt(sessionId)}>停止</button>}
        </div>
      )}
      {native && !native.blocking && (
        <div className="notice sp-lost-note" role="status">
          <span>{native.message}</span>
        </div>
      )}
      {status?.stale && !staleSeen && (
        <div className="notice sp-lost-note" role="status" data-tone="caution">
          <b>快到 30 天了</b>
          <span>这个会话 {status.stale.days} 天没有活动。Claude Code 默认 30 天后删除会话记录；要保留，在 ~/.claude/settings.json 里设 cleanupPeriodDays。Agora 已为它保存轨迹快照，记录删了也能看、能带着摘要接着聊。</span>
          <button className="btn sm ghost" onClick={() => (rememberStale(sessionId), setStaleSeen(true))}>知道了</button>
        </div>
      )}
      {fork && !copyOf && (
        <div className="notice sp-lost-note" role="status">
          <b>分叉</b>
          <span>{!forkHeadless(binding.agent) ? `${AGENT_NAMES[binding.agent] ?? binding.agent} 只能在终端里分叉：点「在终端打开」，在终端里接着说；新的原生会话会自动接到这里。` : `下一条消息会从原来的会话（${fork.from.slice(0, 8)}）分出一个新的原生会话继续，之前的对话都在。`}</span>
        </div>
      )}
      {copyOf ? (
        <CopyCard sessionId={sessionId} copy={copyOf} agent={binding.agent} />
      ) : stuck && native ? (
        <NativeMissing sessionId={sessionId} canvasId={session.canvasId} problem={native} agent={binding.agent} model={binding.model} effort={binding.effort} snapshot={!!status?.snapshot || items.length > 0} />
      ) : (
        <>
        <RequestCards sessionId={sessionId} />
        <InputRight sessionId={sessionId} />
        <Composer
          key={binding.nativeId ?? "new"}
          initial={takeDraft(sessionId)}
          canvasId={session.canvasId}
          canvasTitle={canvasTitle}
          agentName={AGENT_NAMES[binding.agent]}
          onSend={send}
          working={working}
          onStop={status?.running ? () => void agents.interrupt(sessionId) : undefined}
        />
        </>
      )}
    </div>
  );
}

/** Brought along by `cp -r`: the original copy still resumes this native session. Fork it here, or leave it to the original. */
function CopyCard({ sessionId, copy, agent }: { sessionId: string; copy: NonNullable<import("./agents").Status["copy"]>; agent: AgentKind }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fork = async () => {
    setBusy(true);
    setErr(null);
    try {
      await agents.fork(sessionId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sp-lost" role="status" data-state="copy">
      <p className="sp-lost-title"><b data-tone="caution">来自 {copy.from} 的副本</b> · 只读</p>
      <p>原来那份项目还在用这个 {AGENT_NAMES[agent]} 会话。两份项目不能续接同一个原生会话：在这里分叉一份继续（新的原生会话，之前的对话都在），或者留给原来那份。</p>
      {err && <p className="sp-warn">{err}</p>}
      <div className="sp-lost-go">
        <button className="btn primary sm" disabled={busy} onClick={() => void fork()}>在这里分叉继续</button>
        <button className="btn ghost sm" disabled={busy} onClick={() => ui.trashSession(sessionId)} title="从这份副本里移到回收站；原来那份不受影响">留给原来那份</button>
      </div>
    </div>
  );
}

/**
 * The session's native log is missing (or ambiguous, or in another directory): say what is gone,
 * keep what Agora still shows (this pane, read-only), and offer a new session — never resume
 * into a silently new conversation under the same id.
 */
function NativeMissing({ sessionId, canvasId, problem, agent, model, effort, snapshot }: { sessionId: string; canvasId: string; problem: NonNullable<import("./agents").Status["native"]>; agent: AgentKind; model: string; effort: string; snapshot: boolean }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await f();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // This same Agora session continues in a new native session; its first message carries a
  // summary of what was said (editable before sending). The old native id stays on record.
  const carryOn = () =>
    act(async () => {
      const text = await agents.summary(sessionId);
      draftText.set(sessionId, text);
      await agents.restart(sessionId);
    });
  const fresh = () => act(() => freshSession(canvasId, agent, model, effort));
  const title = problem.state === "missing" ? "原生会话缺失" : problem.state === "ambiguous" ? "找到多份原生记录" : "原生会话在别的目录";
  const lost = problem.state === "missing";
  return (
    <div className="sp-lost" role="alert" data-state={problem.state}>
      <p className="sp-lost-title"><b>{title}</b> · 只读</p>
      <p>{problem.message}</p>
      {problem.candidates.length > 0 && (
        <ul className="sp-lost-list">
          {problem.candidates.map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>
      )}
      <p className="sp-lost-hint">
        {snapshot ? "上面是 Agora 保存的轨迹快照，只读。" : "Agora 这边没有这个会话的轨迹快照。"}
        {lost ? `要接着讨论，可以带着摘要在这里开一个新的 ${AGENT_NAMES[agent]} 原生会话（同一个 Agora 会话、同样的模型；发送前可以改摘要），或者另开一个会话。` : `要接着讨论，另开一个 ${AGENT_NAMES[agent]} 会话（同一块画布、同样的模型）；这个会话保持原样。`}
      </p>
      {err && <p className="sp-warn">{err}</p>}
      <div className="sp-lost-go">
        {lost && <button className="btn primary sm" disabled={busy} onClick={() => void carryOn()} data-session={sessionId}>带着摘要开新会话</button>}
        <button className={lost ? "btn ghost sm" : "btn primary sm"} disabled={busy} onClick={() => void fresh()}>另开一个会话</button>
        <button className="btn ghost sm" disabled={busy} onClick={() => ui.trashSession(sessionId)}>移到回收站</button>
      </div>
    </div>
  );
}

/** A pre-filled message for a session's composer, taken once. */
function takeDraft(sessionId: string) {
  const t = draftText.get(sessionId);
  draftText.delete(sessionId);
  return t;
}
const STALE_KEY = "agora.staleSeen";
const staleKnown = (sid: string) => {
  try {
    return (JSON.parse(localStorage.getItem(STALE_KEY) ?? "[]") as string[]).includes(sid);
  } catch {
    return false;
  }
};
const rememberStale = (sid: string) => {
  try {
    localStorage.setItem(STALE_KEY, JSON.stringify([...(JSON.parse(localStorage.getItem(STALE_KEY) ?? "[]") as string[]), sid].slice(-200)));
  } catch {
    /* private window: shown again next time */
  }
};

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
            <button onClick={() => onTrajectory(t.n)} title="在轨迹里看这一轮">
              第 {t.n} 轮 · {clock(t.startedAt)}
              {t.running ? " · 进行中" : t.durationMs != null && t.durationMs > 20_000 ? ` · 用时 ${fmtDuration(t.durationMs)}` : ""}
            </button>
            {t.source === "terminal" && <span className="ds-tag">终端</span>}
            <TraceTurn sessionId={sessionId} turn={t} />
          </header>
          {t.user && (
            <div className="ds-user" data-source={t.user.source}>
              <p>{t.user.text}</p>
            </div>
          )}
          <ProcessFold sessionId={sessionId} turn={t} />
          {(byTurn.get(t.n) ?? []).map(card)}
          {t.reply?.text && <Markdown className="ds-say" text={t.reply.text} />}
          {t.error && !t.running && (t.error === "interrupted" ? <p className="sp-notice">这一轮已停止</p> : <p className="ds-say" data-error>这一轮出错：{t.error}</p>)}
          {(t.notices ?? []).map((n) => <p key={n.id} className="sp-notice" data-tone={n.tone}>{n.text}</p>)}
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

/**
 * A canvas change as one line: 「改了画布 · 新建子图「API 服务」：4 个节点…」. Hovering the line
 * shows 撤销 / 在画布中高亮 and lights the elements; ▸ opens the list of changes.
 */
function TurnCard({ t, canvasTitle, flash }: { t: Turn; canvasTitle?: string; flash: boolean }) {
  const [open, setOpen] = useState(false);
  const hover = (ids: string[] | undefined) => highlight.set(ids?.length ? { canvasId: t.canvasId, ids } : null);
  const touched = t.steps.find((x) => x.kind === "apply")?.elements ?? [];
  const api = canvases.get(t.canvasId)?.api;
  const detail = t.steps.map((s) => s.detail).filter(Boolean).join(" · ");
  const summary = t.reply?.changes?.length ? `${t.request}` : t.reply?.text ?? t.request;
  const undone = !!t.reply?.undone;
  return (
    <article className="sp-change sp-change1" data-status={t.status} data-turn={t.id} data-flash={flash} data-open={open} data-tone={t.reply?.tone} onPointerEnter={() => hover(touched)} onPointerLeave={() => hover(undefined)}>
      <div className="sp-line">
        <button className="sp-line-main" onClick={() => setOpen(!open)} aria-expanded={open} title={detail || summary}>
          <IconLayers size={14} />
          <b>{kindLabel(t)}</b>
          {t.origin.kind === "comment" && <span className="sp-origin-n">#{t.origin.threadN}</span>}
          <span className="sp-line-text" data-undone={undone || undefined}>{summary}</span>
        </button>
        <span className="sp-line-acts">
          {t.origin.kind === "comment" && (
            <button className="sp-line-act" onClick={() => t.origin.kind === "comment" && ui.openThread(t.canvasId, t.origin.threadId)} title={`来自「${canvasTitle ?? "画布"}」的评论 #${t.origin.threadN}：${t.origin.anchor}`}>
              <IconCommentSolid size={12} />
            </button>
          )}
          {t.reply?.batchId && !undone && (
            <button className="sp-line-act" disabled={!api} onClick={() => api && undoTurn(api, t.id)} title="撤销这次修改">
              <IconUndo size={14} />
            </button>
          )}
          {touched.length > 0 && !undone && (
            <button
              className="sp-line-act"
              title="在画布中高亮"
              onClick={() => {
                ui.focusPane(t.canvasId);
                highlight.set({ canvasId: t.canvasId, ids: touched });
                setTimeout(() => highlight.get()?.ids === touched && highlight.set(null), 2600);
              }}
            >
              <IconTarget size={14} />
            </button>
          )}
        </span>
        {undone && <span className="sp-undone">已撤销</span>}
        <IconChevron open={open} />
      </div>
      <AnimatePresence initial={false}>
        {open && t.reply && (
          <motion.div className="sp-change-body" data-tone={t.reply.tone} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0, transition: { duration: 0.12 } }} transition={SPRING}>
            {t.reply.changes ? <ul data-undone={undone}>{t.reply.changes.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p>{t.reply.text}</p>}
            {t.reply.undoError && <p className="sp-warn">{t.reply.undoError}</p>}
            <time title={detail}>{clock(t.startedAt)}{t.endedAt ? ` · ${fmt(t.endedAt - t.startedAt)}` : ""}</time>
          </motion.div>
        )}
      </AnimatePresence>
      {t.reply?.undoError && !open && <p className="sp-warn">{t.reply.undoError}</p>}
    </article>
  );
}

/** While the agent works: one line saying what it does right now (from the 工位视图's run), and where. */
function LiveLine({ sessionId }: { sessionId: string }) {
  const runs = useRuns();
  const now = useTick(500);
  const run = runs.byId.get(sessionId);
  const g = run?.segs.find((s) => s.start <= now && now < s.end) ?? run?.segs.at(-1);
  if (!g) return null;
  const wait = g.kind === "wait";
  const what = wait ? "在等你回复" : g.kind === "write" ? `正在写 ${g.path ?? ""}` : g.kind === "read" ? `正在读 ${g.path ?? ""}` : g.kind === "exec" ? `正在跑 ${g.cmd ?? ""}` : g.kind === "delegate" ? `正在${g.label}` : "正在想";
  return (
    <div className="sp-live" data-k={g.kind}>
      {g.kind === "write" ? <IconCode size={14} /> : <i className="dot" data-tone={wait ? "held" : "ok"} />}
      <span className="sp-live-text">{what}</span>
      <span className="sp-live-el">{fmtDuration(Math.max(0, now - g.start))}</span>
    </div>
  );
}
