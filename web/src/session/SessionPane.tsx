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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { IconChevron, IconCommentSolid, IconCopy, IconLayers, IconLock, IconMore, IconPath, IconPencil, IconTerminal } from "../app/icons";
import { panelView, replayTime, useReplay, useTick, type PanelView } from "../workstation/clock";
import { usePlay } from "../workstation/replayMode";
import { useRuns } from "../workstation/runs/store";
import { panelPlays } from "./replayStep";
import { Markdown } from "./markdown";
import { CardMessage } from "./AgoraCard";
import { cardTurnLabel, messageCard, quietReply } from "./agentMessage";
import { captureSelection } from "./selection";
import { SelectionAttachment } from "./SelectionAttachment";
import { TrajectoryView } from "./TrajectoryView";
import { LiveBar, ProcessBlock, ProcessChoice } from "./ProcessCard";
import { activityModel } from "./activityCard";
import { TraceTurn } from "./TraceTurn";
import { CONTINUE_WORD, stopText, stoppedForTime } from "./turnStop";
import { buildTurns, fmtCost, fmtDuration, fmtTokens, sumUsage, type TrajTurn } from "./trajectoryModel";
import { SPRING } from "../comments/motion";
import { Composer } from "./Composer";
import { InputRight } from "./InputRight";
import { RequestCards } from "./RequestCards";
import { modeLabel, waitLabel } from "./requestModel";
import { canvasChoices, topOf } from "./canvasChoices";
import { agents, effortChoices, forkHeadless, loadAdapters, sessionKinds, steerOf, useAgentName, useAgents, type AgentKind, type Catalog, type TerminalApps } from "./agents";
import { planSend, type SendMode } from "./steerModel";
import { copyText, windowsLine } from "./terminalModel";
import { useNarrow } from "../workspace/narrow";
import { FIRST_DRAW_MARK } from "./pageMessage";
import { AgentAvatar } from "./AgentAvatar";
import { Picker } from "./Picker";
import { kindShown, recommendAgent } from "./recommend";
import { drawPlan, isEmptyCanvas } from "./firstDraw";
import { useNested } from "../nested/store";
import "./recommend.css";
import { effortGroups, modelGroups } from "./pickerModel";
import { TerminalAppIcon } from "../app/terminals/TerminalAppIcon";
import { canRedoTurn, redoTurn, undoTurn } from "./runTurn";
import { MarkButton, UndoButtons, UndoStatus } from "./StepActs";
import { byId, live, type Scene } from "../canvas/scene";
import { sessions, useSessions, type Turn } from "./store";
import { agentChoice, canvases, draftText, highlight, openSessions, ui } from "./ui";
import { JumpPill, useJumpToBottom } from "./JumpPill";
import { FloatChoice } from "../app/FloatChoice";
import "./session.css";
import { tr, langTag } from "../i18n";

const fmt = (ms: number) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
const clock = (at: number) => new Date(at).toLocaleTimeString(langTag(), { hour: "2-digit", minute: "2-digit" });

/** `onRename`: starts renaming this session's tab (a phone has no double-click or right-click to do it by). */
export function SessionPane({ sessionId, canvasTitles, onRename }: { sessionId: string; canvasTitles: Record<string, string>; onRename?: () => void }) {
  // a session with an open tab: "交给 Agent" starts from the ones the person has open
  useEffect(() => (openSessions.mount(sessionId), () => void openSessions.unmount(sessionId)), [sessionId]);
  const { sessions: all } = useSessions();
  const ag = useAgents();
  const session = all[sessionId];
  if (!session) return <div className="sp-empty">{tr("会话不存在", "Session not found")}</div>;
  const binding = ag.bindings[sessionId];
  const origin = ag.origins[sessionId];
  // A session made on another machine, or whose binding is only in this machine's registry: never
  // the agent picker (that would start a new, unrelated conversation under its name).
  if (!binding && origin && origin.state !== "copy") return <OriginCard sessionId={sessionId} origin={origin} canvasTitles={canvasTitles} />;
  if (!binding) return <Chooser sessionId={sessionId} canvasTitle={canvasTitles[session.canvasId]} />;
  return <AgentSession sessionId={sessionId} canvasTitles={canvasTitles} onRename={onRename} />;
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
  const nameOf = useAgentName();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agent = (origin.agent ?? "claude") as AgentKind;
  const name = nameOf(agent);
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
      ? [tr("可以恢复", "Can be restored"), tr(`这个 ${name} 会话在本机的注册表里有记录，但项目里的绑定不见了（.agora/sessions/ 被清掉？）。`, `This machine's registry has a record of this ${name} session, but the project's binding is gone (was .agora/sessions/ cleared?). `) + (origin.log === "found" ? tr("原生对话还在，恢复后照常续接。", "The native conversation is still here; after restoring it resumes as usual.") : tr("原生对话在这台机器上没找到；恢复后只能查看 Agora 保存的轨迹。", "The native conversation isn't on this machine; after restoring you can only view the trajectory Agora saved."))]
      : origin.state === "other-copy"
        ? [tr("属于另一份副本", "Belongs to another copy"), tr(`这个 ${name} 会话由本机的另一份项目（${origin.root}）在用。两份项目不能续接同一个原生会话：可以在这里分叉一份继续（保留之前的对话）。`, `Another copy of this project on this machine (${origin.root}) is using this ${name} session. Two copies can't resume the same native session: you can fork it here and continue (the earlier conversation is kept).`)]
        : [tr("来自另一台机器", "From another machine"), tr(`这个 ${name} 会话是在另一台机器上（或别的位置）建的，对话记录不在这台机器上。`, `This ${name} session was created on another machine (or in another location); its conversation log isn't on this machine.`)];
  return (
    <div className="sp">
      <div className="sp-choose sp-origin" data-state={origin.state}>
        <div className="sp-origin-head">
          <AgentAvatar kind={agent} size={40} />
          <div>
            <h2>{origin.topic ? `${name} · ${origin.topic}` : name}</h2>
            <p className="sp-meta">
              <span className="sp-lock"><IconLock size={12} />{origin.model || tr("默认模型", "Default model")}{origin.effort ? ` · ${origin.effort}` : ""}</span>
              <span className="sp-sep" aria-hidden>·</span>
              <span>{canvas ? tr(`画布「${canvas}」`, `Canvas “${canvas}”`) : canvasId ? tr("画布不在这个工作区", "Canvas not in this workspace") : tr("未关联画布", "No canvas linked")}</span>
              {origin.nativeId && <code className="sp-native" title={tr("原生会话 id", "Native session id")}>{origin.nativeId.slice(0, 8)}</code>}
            </p>
          </div>
        </div>
        <p className="notice" data-tone={origin.state === "foreign" ? "caution" : undefined}>
          <b>{title}</b>
          <span>{text}</span>
        </p>
        {err && <p className="sp-warn">{err}</p>}
        <div className="sp-choose-go">
          {origin.state === "recoverable" && <button className="btn primary" disabled={busy} onClick={() => void restore()}>{tr("恢复这个会话", "Restore")}</button>}
          {origin.state === "other-copy" && <button className="btn primary" disabled={busy} onClick={() => void fork()}>{tr("在这里分叉继续", "Fork here and continue")}</button>}
          <button className={origin.state === "foreign" ? "btn primary" : "btn ghost"} disabled={busy} onClick={() => void fresh()}>{tr("在这里开新会话", "Start a new session here")}</button>
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
  const tip = tr("这个会话改图、画小人、接评论时用的图", "The diagram this session edits, shows its avatar on and takes comments from");
  if (choices.length <= 1 && !gone)
    return (
      <span className="sp-cv" title={tip}>
        <i className="sp-cv-sq" aria-hidden />
        <span className="sp-cv-t">{tr("画在：", "Canvas: ")}{canvasTitles[top] ?? choices[0]?.title ?? ""}</span>
      </span>
    );
  return (
    <label className="sp-cv" title={tip}>
      <i className="sp-cv-sq" aria-hidden />
      <span className="sp-cv-t">{tr("画在：", "Canvas: ")}</span>
      <select value={gone ? canvasId : top} onChange={(e) => onPick(e.target.value)} aria-label={tr("这个会话画在哪张图上", "Which diagram this session draws on")}>
        {choices.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
        {gone && <option value={canvasId}>{canvasId ? tr("已删除的画布", "Deleted canvas") : tr("未关联画布", "No canvas linked")}</option>}
      </select>
    </label>
  );
}

/** Pick the session's agent, model and effort. Once started this never changes. */
function Chooser({ sessionId, canvasTitle }: { sessionId: string; canvasTitle?: string }) {
  const nameOf = useAgentName();
  const [cat, setCat] = useState<Catalog | null>(null);
  // the model list: loading, failed (the session then starts on the CLI's defaults) or ready — session/chooserModel.ts
  const [catState, setCatState] = useState<CatalogState>("loading");
  const [picked, setPicked] = useState<AgentKind | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const waiting = agentChoice.pending(sessionId);
  // The session agents (tier T1) from the server's adapter registry; the built-in three until it answers.
  const [kinds, setKinds] = useState<AgentKind[]>(sessionKinds());
  // Selected until the person picks another: the recommended agent (session/recommend.ts, the same one the @ list recommends).
  const ag = useAgents();
  const canvasId = useSessions().sessions[sessionId]?.canvasId;
  const onCanvas = canvasId ? sessions.onCanvas(canvasId).map((x) => x.id) : undefined;
  const rec = recommendAgent({ kinds: cat ? kinds.filter((k) => cat[k]?.installed) : kinds, bindings: ag.bindings, activeAt: ag.activeAt, canvas: onCanvas });
  const kind = kindShown(picked, rec);
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
  // The main button of an empty canvas: the recommended agent, started with the written prompt (session/firstDraw.ts).
  const empty = isEmptyCanvas(useNested().scenes.get(canvasId ?? ""));
  const draw = async () => {
    setBusy(true);
    setErr(null);
    try {
      const plan = drawPlan(rec);
      const e = cat?.[plan.kind];
      const m = e ? e.default || e.featured[0] || "" : "";
      await agents.bind(sessionId, plan.kind, m, effortChoices(e, m).initial);
      agentChoice.resolve(sessionId, sessionId);
      await agents.send(sessionId, plan.prompt, { ...(canvasId && { canvasId }), page: FIRST_DRAW_MARK });
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
      ? { text: tr(`只列 Pi 设置里启用的 ${c.models.length} 个模型（enabledModels）`, `Only the ${c.models.length} models enabled in Pi's settings (enabledModels)`), title: c.scope.source ? tr(`来自 ${c.scope.source}`, `From ${c.scope.source}`) : undefined }
      : kind === "pi" && c.scope?.kind === "available"
        ? { text: tr(`Pi 没有设置 enabledModels：列出已配置凭据的 ${c.models.length} 个模型`, `Pi has no enabledModels set: listing the ${c.models.length} models with credentials`), title: tr("在 ~/.pi/agent/settings.json 或项目 .pi/settings.json 里设置 enabledModels 可以收窄范围", "Set enabledModels in ~/.pi/agent/settings.json or the project's .pi/settings.json to narrow the list") }
        : null;
  return (
    <div className="sp">
      <div className="sp-choose sp-choose2">
        {empty && (
          <div className="sp-draw">
            <button className="btn primary" disabled={busy || catState === "loading"} onClick={() => void draw()}>{tr("画出这个项目的架构", "Draw this project's architecture")}</button>
            <p>{tr(`用 ${nameOf(rec)} 看一遍这个项目，把整体架构画到这张图上，主要的子系统各做一张子图；画完用两三句话告诉你。`, `${nameOf(rec)} reads through the project and draws its overall architecture on this diagram, with a sub-diagram for each main subsystem, then sums it up in a few sentences.`)}</p>
          </div>
        )}
        <h2>{tr(`选一个 agent 来讨论「${canvasTitle ?? "这张图"}」`, canvasTitle ? `Pick an agent to discuss “${canvasTitle}”` : "Pick an agent to discuss this diagram")}</h2>
        <p>{tr("它会一直是这个会话的 agent：先在图上和你讨论架构，再去写代码；你在图上看得到它在哪干活。选定后不能更改。", "It stays this session's agent: it talks the architecture through with you on the diagram, then writes the code, and the diagram shows where it's working. It can't be changed once picked.")}</p>
        {waiting && (
          <p className="notice" data-tone="caution">
            <b>{tr("在等你", "Waiting for you")}</b>
            <span>{tr("有一条画布评论在等这个会话，选好后会自动交给它。", "A canvas comment is waiting for this session; it's handed over as soon as you pick.")}</span>
          </p>
        )}
        <div className="sp-cards" role="radiogroup" aria-label="Agent">
          {kinds.map((k) => {
            const e = cat?.[k];
            const def = e ? e.default || e.featured[0] || tr("默认模型", "Default model") : "";
            return (
              <button key={k} role="radio" aria-checked={kind === k} data-on={kind === k} disabled={cat ? !cat[k]?.installed : false} onClick={() => setPicked(k)}>
                <AgentAvatar kind={k} size={32} />
                <span className="sp-card-t">
                  <div className="sp-card-h">
                    <b>{nameOf(k)}</b>
                    {k === rec && <i className="rec-tag">{tr("推荐", "Recommended")}</i>}
                  </div>
                  <span>{AGENT_BLURB[k] ?? ""}{def ? `${AGENT_BLURB[k] ? " · " : ""}${e?.names?.[def] ?? def}` : ""}</span>
                </span>
                {cat && !cat[k]?.installed && <em>{tr("未安装", "Not installed")}</em>}
              </button>
            );
          })}
        </div>
        <div className="sp-choose-row">
          <Picker label={tr("模型", "Model")} value={model} onChange={setModel} groups={view.fields ? models : []} disabled={!c || !view.fields} valueLabel={view.model} placeholder={tr("搜索模型或 provider", "Search models or providers")} />
          <Picker
            label={tr("强度", "Effort")}
            value={effort}
            onChange={setEffort}
            groups={view.fields ? efforts : []}
            disabled={!c || !view.fields || !eff.levels.length}
            compact
            valueLabel={view.effort}
            title={eff.levels.length ? tr(`${model || "默认模型"} 支持：${eff.levels.join(" / ")}`, `${model || "Default model"} supports: ${eff.levels.join(" / ")}`) : view.fields ? tr("这个 CLI 不分强度：不传强度参数", "This CLI has no effort levels: no effort flag is passed") : undefined}
          />
        </div>
        {view.note && (
          <p className="sp-choose-note" role="status">
            {view.note}
            {view.retry && <button className="btn sm ghost" onClick={loadCatalog}>{tr("重试", "Retry")}</button>}
          </p>
        )}
        {scopeNote && <p className="sp-choose-note" title={scopeNote.title}>{scopeNote.text}</p>}
        {err && <p className="sp-warn">{err}</p>}
        <div className="sp-choose-go">
          <button className="btn primary" disabled={busy || !view.canStart} onClick={() => void start()}>{tr(`用 ${nameOf(kind)} 开始`, `Start with ${nameOf(kind)}`)}</button>
          {waiting && <button className="btn ghost" onClick={() => agentChoice.resolve(sessionId, undefined)}>{tr("先不交", "Not now")}</button>}
        </div>
        <p className="sp-choose-later">{tr("也可以直接在画布上画，之后再开会话。", "You can also just draw on the canvas and start a session later.")}</p>
      </div>
    </div>
  );
}

/** What each agent is good for, in one line (the picker's cards). */
const AGENT_BLURB: Record<string, string> = {
  pi: tr("快，适合边画边聊", "Fast, good for drawing while you talk"),
  claude: tr("擅长大改动，能派子代理", "Good at big changes, can dispatch sub-agents"),
  codex: tr("适合按清单写代码和测试", "Good at code and tests from a checklist"),
  grok: tr("xAI 出品，读写代码，能派子代理", "By xAI; reads and writes code, can dispatch sub-agents"),
  cursor: tr("多种模型可选，读写代码，能派子代理", "Many models; reads and writes code, can dispatch sub-agents"),
  devin: tr("Cognition 出品，读写代码，工具默认不用批准", "By Cognition; reads and writes code, tools need no approval by default"),
};

function AgentSession({ sessionId, canvasTitles, onRename }: { sessionId: string; canvasTitles: Record<string, string>; onRename?: () => void }) {
  const nameOf = useAgentName();
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
  const send = async (text: string, refs: Turn["refs"], mode?: SendMode) => {
    // what is selected goes as names with ids in the footer and as a picture (./selection.ts); the words stay the person's own
    const api = canvases.get(session.canvasId)?.api;
    const selection = api ? await captureSelection(api, session.canvasId) : null;
    await agents.send(sessionId, text, { canvasId: session.canvasId, refs: refs.map((r) => ({ id: r.id, name: r.label })), ...(selection && { selection }), ...(mode && { mode }) });
  };
  const plan = planSend({ running: !!status?.running, terminalAlive: !!status?.terminal.alive, ...steerOf(binding.agent, status) });
  const [termMenu, setTermMenu] = useState(false);
  const [cmdText, setCmdText] = useState<string | null>(null);
  const narrow = useNarrow(); // a phone: the terminal that opens is the Mac's, so the way in is the copied command
  const [apps, setApps] = useState<TerminalApps | null>(null);
  useEffect(() => {
    void agents.terminalApps().then(setApps).catch(() => setApps(null));
  }, []);
  const termName = apps?.name ?? tr("终端", "Terminal"); // which terminal「在终端打开」uses on this machine (AGORA_TERMINAL, else Ghostty > Kitty > Terminal)
  const termIcon = apps?.chosen === "kitty" ? <TerminalAppIcon /> : <IconTerminal size={16} />;
  const openTerminal = async () => {
    setTermNote(null);
    setTermMenu(false);
    try {
      const r = await agents.openTerminal(sessionId, session.canvasId, true);
      // a window that opened says so by itself (the input-right note below); only what did not work needs words
      setTermNote(r.launched ? null : tr("没找到可用的终端：用「复制打开命令」在任意终端里打开", "No terminal app found: use “Copy open command” to open it in any terminal"));
    } catch (e) {
      setTermNote((e as Error).message);
    }
  };
  /** Fallback for any terminal (the way on a phone): start Agora's pane, copy the attach command. A copy the browser refuses is said so, and the command is shown to copy by hand. */
  const copyOpen = async () => {
    setTermNote(null);
    setCmdText(null);
    try {
      const r = await agents.openTerminal(sessionId, session.canvasId, false);
      const cmd = `env -u TMUX ${r.attach}`;
      if (await copyText(cmd)) {
        setTermMenu(false);
        setTermNote(narrow ? tr("已复制命令：粘贴到手机的终端 App 里运行（要先 SSH 到这台 Mac）", "Command copied: paste it into your phone's terminal app (SSH into this Mac first)") : tr("已复制命令：在任意终端里新开一个窗口粘贴运行", "Command copied: paste it into a new window of any terminal"));
      } else {
        setCmdText(cmd);
        setTermNote(tr("没能复制：长按菜单里的命令自己复制", "Couldn't copy: long-press the command in the menu to copy it yourself"));
      }
    } catch (e) {
      setTermNote((e as Error).message);
    }
  };
  useEffect(() => {
    if (!termMenu) setCmdText(null);
  }, [termMenu]);
  const openItem = (
    <button
      role="menuitem"
      disabled={!status?.terminal.alive && !!status?.running}
      title={apps && !apps.chosen ? tr("没找到 Ghostty、Kitty 或 macOS 终端：用「复制打开命令」", "No Ghostty, Kitty or macOS Terminal found: use “Copy open command”") : tr(`在 ${termName} 窗口里打开这个会话的终端`, `Open this session's terminal in a ${termName} window`)}
      onClick={() => void openTerminal()}
    >
      <span className="menu-check" />
      {termIcon}
      {apps && !apps.chosen ? tr("在终端打开", "Open in terminal") : tr(`用 ${termName} 打开`, `Open in ${termName}`)}
    </button>
  );
  const copyItem = (
    <button role="menuitem" disabled={!status?.terminal.alive && !!status?.running} onClick={() => void copyOpen()} title={tr("在任意终端里新开窗口粘贴运行", "Paste and run it in a new window of any terminal")}>
      <span className="menu-check" />
      <IconCopy size={16} />
      {narrow ? tr("复制命令，到手机终端里接着跑", "Copy command for your phone's terminal") : tr("复制打开命令", "Copy open command")}
    </button>
  );
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
  const replying = tr(`${nameOf(binding.agent)} 正在回复${status?.terminal.alive ? "（终端）" : ""}`, `${nameOf(binding.agent)} is replying${status?.terminal.alive ? " (terminal)" : ""}`);
  const line = status?.held
    ? tr(`排队中：${status.held}`, `Queued: ${status.held}`)
    : status?.running
      ? tr(`${nameOf(binding.agent)} 正在处理`, `${nameOf(binding.agent)} is working`) + (status.activity ? ` · ${status.activity}` : "")
      : status?.busy
        ? replying
        : inflight
          ? tr("已发送，等待开始…", "Sent, waiting to start…")
          : status?.error
            ? stoppedForTime(status.error)
              ? stopText(status.error)
              : tr(`上一轮出错：${status.error}`, `The last turn failed: ${status.error}`)
            : null;

  // the bar above the composer reads the same model as the turn's card (./activityCard.ts)
  const liveTurn = turns.at(-1)?.running ? turns.at(-1)! : null;
  const liveText = liveTurn ? activityModel(liveTurn, { waiting: !!status?.waiting }).now : status?.busy ? replying : tr("已发送，等待开始…", "Sent, waiting to start…");
  const totalMs = turns.some((t) => t.durationMs != null) ? turns.reduce((n, t) => n + (t.durationMs ?? 0), 0) : null;
  return (
    <div className="sp" data-agent={binding.agent} data-playing={playing || undefined}>
      {/* One line: the model (fixed at creation) and the canvas; the name is already on the tab. */}
      <header className="sp-head sp-head1">
        <span className="sp-lock" title={tr("创建会话时选定，不能更改", "Chosen when the session was created; can't be changed")}>
          <IconLock size={12} />
          {binding.model || tr("默认模型", "Default model")}{binding.effort ? ` · ${binding.effort}` : ""}
        </span>
        {status?.waiting && <span className="sp-waited" title={tr("它在等你回答；不会自动拒绝，回答或停止之前一直等", "It's waiting for your answer; it never declines on its own and waits until you answer or stop it")}>{waitLabel(status.waitingSince, waitNow)}</span>}
        {modeLabel(status?.mode) && (
          <span className="sp-mode" data-tone={modeLabel(status?.mode)!.tone} title={tr("Claude 这一轮实际的权限模式：auto 由它自己判断哪些要问你", "Claude's actual permission mode this turn: in auto it decides itself what to ask you")}>
            {modeLabel(status?.mode)!.text}
          </span>
        )}
        <span className="sp-sep" aria-hidden>·</span>
        <CanvasChoice canvasId={session.canvasId} canvasTitles={canvasTitles} onPick={(id) => sessions.relink(sessionId, id)} />
        <span className="grow" />
        <button className="icon-btn sm" aria-pressed={view === "trajectory"} data-on={view === "trajectory"} onClick={() => setView((v) => panelView(v, "toggle"))} title={view === "trajectory" ? tr("回到对话", "Back to conversation") : tr("轨迹：每一步做了什么", "Trajectory: what each step did")} aria-label={tr("轨迹", "Trajectory")}>
          <IconPath size={16} />
        </button>
        {!narrow && <button
          className="icon-btn sm"
          disabled={(!status?.terminal.alive && !!status?.running) || stuck}
          onClick={() => void openTerminal()}
          title={status?.terminal.alive ? tr(`再开一个 ${termName} 窗口连到同一个终端`, `Open another ${termName} window on the same terminal`) : status?.running ? tr("这一轮结束后再打开", "Open it after this turn ends") : tr(`用 ${termName} 打开，直接在里面做 coding`, `Open in ${termName} and code there directly`)}
          aria-label={tr("在终端打开", "Open in terminal")}
        >
          {termIcon}
        </button>}
        <div className="sp-term">
          <button className="icon-btn sm" aria-haspopup="dialog" aria-expanded={termMenu} aria-label={tr("用量与更多", "Usage and more")} title={tr("用量、会话 id、在哪个终端打开", "Usage, session id, which terminal to open in")} onClick={() => setTermMenu((v) => !v)}>
            <IconMore size={16} />
          </button>
          <AnimatePresence>
            {termMenu && (
              <motion.div className="menu sp-term-menu sp-stats" role="dialog" aria-label={tr("用量与更多", "Usage and more")} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2, transition: { duration: 0.1 } }} transition={SPRING}>
                <dl>
                  <dt>{tr("轮数", "Turns")}</dt>
                  <dd>{tr(`${turns.length} 轮`, `${turns.length}`)}</dd>
                  <dt>{tr("耗时", "Time")}</dt>
                  <dd>{totalMs != null ? fmtDuration(totalMs) : "—"}</dd>
                  <dt>{tr("花费", "Cost")}</dt>
                  <dd>{fmtCost(total.cost)}</dd>
                  <dt>{tr("tokens", "Tokens")}</dt>
                  <dd>{fmtTokens(total.input)} {tr("入", "in")} · {fmtTokens(total.output)} {tr("出", "out")}{total.cacheRead != null && total.input ? ` · ${tr("缓存", "cached")} ${Math.round((total.cacheRead / (total.input + total.cacheRead)) * 100)}%` : ""}</dd>
                  <dt>{tr("会话 id", "Session id")}</dt>
                  <dd className="mono">{binding.nativeId ? binding.nativeId.slice(0, 8) : tr("第一轮后生成", "After the first turn")}</dd>
                </dl>
                <hr />
                {onRename && (
                  <button role="menuitem" onClick={() => (setTermMenu(false), onRename())} title={tr("给这个会话起个名字，@ 它和切标签时更好认", "Name this session so it's easier to find when you @ it or switch tabs")}>
                    <span className="menu-check" />
                    <IconPencil size={16} />
                    {tr("重命名", "Rename")}
                  </button>
                )}
                <p className="menu-title">{tr("在哪里打开", "Open in")}</p>
                {status && <p className="sp-term-line" role="status">{windowsLine(status.terminal)}</p>}
                {narrow ? copyItem : <>{openItem}{copyItem}</>}
                {cmdText && <code className="sp-term-cmd">{cmdText}</code>}
                {status?.terminal.alive && (
                  <button role="menuitem" onClick={() => (setTermMenu(false), void agents.closeTerminal(sessionId))} title={tr("结束终端里的 CLI；会话可随时再续接", "End the CLI in the terminal; the session can be resumed any time")}>
                    <span className="menu-check" />
                    {tr("关闭终端", "Close terminal")}
                  </button>
                )}
                <hr />
                <p className="menu-title">{tr("会话面板", "Session panel")}</p>
                <FloatChoice />
                <p className="menu-title">{tr("过程", "Process")}</p>
                <ProcessChoice sessionId={sessionId} />
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
      {status?.steerWhy && (
        <div className="notice sp-steer-why" data-tone="caution" role="status">
          <span>{tr(`${nameOf(binding.agent)} 的常驻进程没起来，这个会话现在用一次性跑法，中途不能插话：`, `${nameOf(binding.agent)}'s resident process didn't start, so this session runs one-shot and can't take messages mid-turn: `)}{status.steerWhy}</span>
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
              <p>{canvasTitle ? tr(`怎么用「${canvasTitle}」：`, `How to use “${canvasTitle}”:`) : tr("怎么用「画布」：", "How to use the canvas:")}</p>
              <ol>
                <li>{tr(`在这里告诉 ${nameOf(binding.agent)} 你要做什么；`, `Tell ${nameOf(binding.agent)} here what you want done.`)}</li>
                <li>{tr("它干活时，左边图上的小人会带你看它在改哪里；点小人可以直接对它说话；", "While it works, its avatar on the diagram to the left shows you where it's making changes; click the avatar to talk to it directly.")}</li>
                <li>{tr(`在图上留评论，在评论框里输入 @ 选 ${nameOf(binding.agent)}（或别的 agent、别的对话）让它处理。`, `Leave a comment on the diagram and type @ in the comment box to pick ${nameOf(binding.agent)} (or another agent or conversation) to handle it.`)}</li>
              </ol>
            </div>
          )}
          <Conversation sessionId={sessionId} canvasId={session.canvasId} waiting={!!status?.waiting} turns={turns} changes={changes} canvasTitles={canvasTitles} flash={flash} onTrajectory={(n) => (setView((v) => panelView(v, "trajectory")), setFocusTurn({ n, key: Date.now() }))} />
        </div>
        <JumpPill show={jump.show} unread={jump.unread} running={working} onJump={jump.jump} />
        </div>
      )}
      {line && !(status?.running && !status?.held) && (
        <div className="notice sp-status" data-tone={status?.held ? "caution" : status?.error && !working ? "error" : undefined}>
          <i className="dot" data-tone={status?.held ? "held" : status?.error && !working ? "error" : "ok"} />
          <span>{line}</span>
          {status?.running && <button className="btn sm ghost" onClick={() => void agents.interrupt(sessionId)}>{tr("停止", "Stop")}</button>}
          {!working && !stuck && stoppedForTime(status?.error) && <button className="btn sm ghost" onClick={() => void send(CONTINUE_WORD, [])}>{CONTINUE_WORD}</button>}
        </div>
      )}
      {native && !native.blocking && (
        <div className="notice sp-lost-note" role="status">
          <span>{native.message}</span>
        </div>
      )}
      {status?.stale && !staleSeen && (
        <div className="notice sp-lost-note" role="status" data-tone="caution">
          <b>{tr("快到 30 天了", "Nearly 30 days old")}</b>
          <span>{tr(`这个会话 ${status.stale.days} 天没有活动。Claude Code 默认 30 天后删除会话记录；要保留，在 ~/.claude/settings.json 里设 cleanupPeriodDays。Agora 已为它保存轨迹快照，记录删了也能看、能带着摘要接着聊。`, `This session has been idle for ${status.stale.days} days. Claude Code deletes session logs after 30 days by default; to keep them, set cleanupPeriodDays in ~/.claude/settings.json. Agora has saved a trajectory snapshot, so even if the log is deleted you can still view it and continue with a summary.`)}</span>
          <button className="btn sm ghost" onClick={() => (rememberStale(sessionId), setStaleSeen(true))}>{tr("知道了", "Got it")}</button>
        </div>
      )}
      {fork && !copyOf && (
        <div className="notice sp-lost-note" role="status">
          <b>{tr("分叉", "Fork")}</b>
          <span>{!forkHeadless(binding.agent) ? tr(`${nameOf(binding.agent)} 只能在终端里分叉：点「在终端打开」，在终端里接着说；新的原生会话会自动接到这里。`, `${nameOf(binding.agent)} can only fork in the terminal: click “Open in terminal” and continue there; the new native session links back here automatically.`) : tr(`下一条消息会从原来的会话（${fork.from.slice(0, 8)}）分出一个新的原生会话继续，之前的对话都在。`, `The next message forks a new native session from the original one (${fork.from.slice(0, 8)}); the earlier conversation is kept.`)}</span>
        </div>
      )}
      {copyOf ? (
        <CopyCard sessionId={sessionId} copy={copyOf} agent={binding.agent} />
      ) : stuck && native ? (
        <NativeMissing sessionId={sessionId} canvasId={session.canvasId} problem={native} agent={binding.agent} model={binding.model} effort={binding.effort} snapshot={!!status?.snapshot || items.length > 0} />
      ) : (
        <>
        <RequestCards sessionId={sessionId} />
        {working && <LiveBar text={liveText} since={liveTurn ? liveTurn.startedAt : null} waiting={!!status?.waiting} onStop={status?.running ? () => void agents.interrupt(sessionId) : undefined} />}
        <InputRight sessionId={sessionId} />
        <Composer
          key={binding.nativeId ?? "new"}
          initial={takeDraft(sessionId)}
          canvasId={session.canvasId}
          canvasTitle={canvasTitle}
          agentName={nameOf(binding.agent)}
          onSend={send}
          working={working}
          plan={plan}
          onStop={status?.running ? () => void agents.interrupt(sessionId) : undefined}
        />
        </>
      )}
    </div>
  );
}

/** Brought along by `cp -r`: the original copy still resumes this native session. Fork it here, or leave it to the original. */
function CopyCard({ sessionId, copy, agent }: { sessionId: string; copy: NonNullable<import("./agents").Status["copy"]>; agent: AgentKind }) {
  const nameOf = useAgentName();
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
      <p className="sp-lost-title"><b data-tone="caution">{tr(`来自 ${copy.from} 的副本`, `Copy from ${copy.from}`)}</b> · {tr("只读", "Read-only")}</p>
      <p>{tr(`原来那份项目还在用这个 ${nameOf(agent)} 会话。两份项目不能续接同一个原生会话：在这里分叉一份继续（新的原生会话，之前的对话都在），或者留给原来那份。`, `The original project is still using this ${nameOf(agent)} session. Two copies can't resume the same native session: fork it here and continue (a new native session with the earlier conversation), or leave it to the original.`)}</p>
      {err && <p className="sp-warn">{err}</p>}
      <div className="sp-lost-go">
        <button className="btn primary sm" disabled={busy} onClick={() => void fork()}>{tr("在这里分叉继续", "Fork here and continue")}</button>
        <button className="btn ghost sm" disabled={busy} onClick={() => ui.trashSession(sessionId)} title={tr("从这份副本里移到回收站；原来那份不受影响", "Move it to the trash in this copy; the original isn't affected")}>{tr("留给原来那份", "Leave to the original")}</button>
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
  const nameOf = useAgentName();
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
  const title = problem.state === "missing" ? tr("原生会话缺失", "Native session missing") : problem.state === "ambiguous" ? tr("找到多份原生记录", "Several native logs found") : tr("原生会话在别的目录", "Native session in another directory");
  const lost = problem.state === "missing";
  return (
    <div className="sp-lost" role="alert" data-state={problem.state}>
      <p className="sp-lost-title"><b>{title}</b> · {tr("只读", "Read-only")}</p>
      <p>{problem.message}</p>
      {problem.candidates.length > 0 && (
        <ul className="sp-lost-list">
          {problem.candidates.map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>
      )}
      <p className="sp-lost-hint">
        {snapshot ? tr("上面是 Agora 保存的轨迹快照，只读。", "Above is the trajectory snapshot Agora saved (read-only). ") : tr("Agora 这边没有这个会话的轨迹快照。", "Agora has no trajectory snapshot of this session. ")}
        {lost ? tr(`要接着讨论，可以带着摘要在这里开一个新的 ${nameOf(agent)} 原生会话（同一个 Agora 会话、同样的模型；发送前可以改摘要），或者另开一个会话。`, `To keep going, start a new ${nameOf(agent)} native session here with a summary (same Agora session, same model; you can edit the summary before sending), or start another session.`) : tr(`要接着讨论，另开一个 ${nameOf(agent)} 会话（同一块画布、同样的模型）；这个会话保持原样。`, `To keep going, start another ${nameOf(agent)} session (same canvas, same model); this one stays as it is.`)}
      </p>
      {err && <p className="sp-warn">{err}</p>}
      <div className="sp-lost-go">
        {lost && <button className="btn primary sm" disabled={busy} onClick={() => void carryOn()} data-session={sessionId}>{tr("带着摘要开新会话", "New session with summary")}</button>}
        <button className={lost ? "btn ghost sm" : "btn primary sm"} disabled={busy} onClick={() => void fresh()}>{tr("另开一个会话", "Start another session")}</button>
        <button className="btn ghost sm" disabled={busy} onClick={() => ui.trashSession(sessionId)}>{tr("移到回收站", "Move to trash")}</button>
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
function Conversation({ sessionId, canvasId, waiting, turns, changes, canvasTitles, flash, onTrajectory }: { sessionId: string; canvasId: string; waiting: boolean; turns: TrajTurn[]; changes: Turn[]; canvasTitles: Record<string, string>; flash: string | null; onTrajectory: (n: number) => void }) {
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
      {turns.map((t) => {
        // what Agora wrote into the session (a receipt, a task, a comment) is a card and its turn says what arrived
        const msg = t.user && messageCard(t.user);
        return (
        <article key={t.n} className="ds-convo-turn">
          <header className="ds-convo-head" data-card={msg ? msg.kind : undefined}>
            <button onClick={() => onTrajectory(t.n)} title={msg ? tr(`在轨迹里看这一轮（第 ${t.n} 轮）`, `View this turn in the trajectory (turn ${t.n})`) : tr("在轨迹里看这一轮", "View this turn in the trajectory")}>
              {msg ? cardTurnLabel(msg) : tr(`第 ${t.n} 轮`, `Turn ${t.n}`)} · {clock(t.startedAt)}
              {t.running ? tr(" · 进行中", " · In progress") : t.durationMs != null && t.durationMs > 20_000 ? tr(` · 用时 ${fmtDuration(t.durationMs)}`, ` · took ${fmtDuration(t.durationMs)}`) : ""}
            </button>
            {t.source === "terminal" && <span className="ds-tag">{tr("终端", "Terminal")}</span>}
            <TraceTurn sessionId={sessionId} turn={t} />
          </header>
          {t.user && msg && <CardMessage item={t.user} card={msg} />}
          {t.user && !msg && (
            <div className="ds-user" data-source={t.user.source}>
              <p>{t.user.text}</p>
            </div>
          )}
          {t.user?.selection && <SelectionAttachment sel={t.user.selection} canvasId={canvasId} />}
          <ProcessBlock sessionId={sessionId} turn={t} waiting={waiting} />
          {(byTurn.get(t.n) ?? []).map(card)}
          {t.reply?.text && <Markdown className={msg && quietReply(t) ? "ds-say quiet" : "ds-say"} text={t.reply.text} />}
          {t.error && !t.running && (t.error === "interrupted" ? <p className="sp-notice">{tr("这一轮已停止", "This turn was stopped")}</p> : <p className="ds-say" data-error>{stoppedForTime(t.error) ? stopText(t.error) : tr(`这一轮出错：${t.error}`, `This turn failed: ${t.error}`)}</p>)}
          {(t.notices ?? []).map((n) => <p key={n.id} className="sp-notice" data-tone={n.tone}>{n.text}</p>)}
        </article>
        );
      })}
    </div>
  );
}

const kindLabel = (t: Turn) => {
  const anim = t.request.startsWith("动画「") || t.request.startsWith("Animation “");
  if (t.status === "running") return anim ? tr("正在挂载动画", "Mounting animation") : tr("正在改画布", "Editing canvas");
  if (t.status === "applied") return anim ? tr("加了动画", "Added animation") : tr("改了画布", "Edited canvas");
  return anim ? tr("动画未挂载", "Animation not mounted") : tr("改图未执行", "Edit not applied");
};

/**
 * A canvas change as one line: 「改了画布 · 新建子图「API 服务」：4 个节点…」. Hovering the line
 * shows 撤销 / 标出改动 (with their words, ./StepActs.tsx) and lights the elements; ▸ opens the list of changes.
 */
function TurnCard({ t, canvasTitle, flash }: { t: Turn; canvasTitle?: string; flash: boolean }) {
  const [open, setOpen] = useState(false);
  const hover = (ids: string[] | undefined) => highlight.set(ids?.length ? { canvasId: t.canvasId, ids } : null);
  const touched = t.steps.find((x) => x.kind === "apply")?.elements ?? [];
  const api = canvases.get(t.canvasId)?.api;
  const detail = t.steps.map((s) => s.detail).filter(Boolean).join(" · ");
  const summary = t.reply?.changes?.length ? `${t.request}` : t.reply?.text ?? t.request;
  const undone = !!t.reply?.undone;
  const pin = useSyncExternalStore(highlight.subscribe, () => highlight.pinned()?.key === t.id);
  // How many of the touched elements are still on the canvas: counted when the person reaches for the buttons, not on every render (the canvas changes without this row knowing).
  const [stillThere, setStillThere] = useState<number | null>(null);
  const countStill = () => {
    if (!api) return;
    const map = byId(api.getSceneElements() as unknown as Scene);
    setStillThere(touched.filter((id) => live(map.get(id))).length);
  };
  return (
    <article className="sp-change sp-change1" data-status={t.status} data-turn={t.id} data-flash={flash} data-open={open} data-tone={t.reply?.tone} onPointerEnter={() => (countStill(), hover(touched))} onPointerLeave={() => hover(undefined)} onFocusCapture={countStill}>
      <div className="sp-line">
        <button className="sp-line-main" onClick={() => setOpen(!open)} aria-expanded={open} title={detail || summary}>
          <IconLayers size={14} />
          <b>{kindLabel(t)}</b>
          {t.origin.kind === "comment" && <span className="sp-origin-n">#{t.origin.threadN}</span>}
          <span className="sp-line-text" data-undone={undone || undefined}>{summary}</span>
        </button>
        <span className="sp-line-acts">
          {t.origin.kind === "comment" && (
            <button className="sp-line-act" onClick={() => t.origin.kind === "comment" && ui.openThread(t.canvasId, t.origin.threadId)} title={tr(`来自「${canvasTitle ?? "画布"}」的评论 #${t.origin.threadN}：${t.origin.anchor}`, `From comment #${t.origin.threadN} on “${canvasTitle ?? "canvas"}”: ${t.origin.anchor}`)} aria-label={tr(`来自评论 #${t.origin.threadN}，点开这条评论`, `From comment #${t.origin.threadN}; open the comment`)}>
              <IconCommentSolid size={12} />
            </button>
          )}
          {t.reply?.batchId && (
            <UndoButtons
              undone={undone}
              canRedo={canRedoTurn(t.id)}
              canAct={!!api}
              onUndo={() => {
                if (!api) return;
                highlight.unpin(t.id);
                undoTurn(api, t.id);
              }}
              onRedo={() => {
                if (!api) return;
                redoTurn(api, t.id);
                setStillThere(null); // the elements are back: count again when the pointer next comes
              }}
            />
          )}
          <MarkButton
            touched={touched}
            live={stillThere}
            undone={undone}
            on={pin}
            onToggle={() => {
              ui.focusPane(t.canvasId);
              highlight.toggle({ canvasId: t.canvasId, ids: touched, key: t.id });
            }}
          />
        </span>
        {t.reply?.batchId && <UndoStatus undone={undone} canRedo={canRedoTurn(t.id)} />}
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
