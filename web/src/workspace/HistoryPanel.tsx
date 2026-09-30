// 会话历史 (web/docs/agent-sessions.md §8): every session of this project wherever it is now —
// open, closed, in the trash, known only to this machine's registry — and native sessions found on
// this machine that belong to the project but are not in it (matched by Agora's hidden footer, or
// only by having run in its directory). Search by name, topic and first message here; the full text
// of the conversations on request (the server reads the native logs). Found sessions can be imported.
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconClose, IconHistory, IconRetry, IconSearch } from "../app/icons";
import { SPRING } from "../comments/motion";
import { AgentAvatar } from "../session/AgentAvatar";
import { AGENT_KINDS, agents, useAgentName, useAgents, type AgentKind } from "../session/agents";
import { sessions } from "../session/store";
import { sessionDocId, type Doc, type SessionDoc } from "./model";

export type HistoryRow = {
  sessionId?: string | null;
  state: "listed" | "trash" | "registry" | "found";
  docId?: string;
  title?: string;
  topic?: string;
  canvasId?: string;
  agent?: AgentKind;
  model?: string;
  effort?: string;
  nativeId?: string;
  started?: boolean;
  createdAt?: number;
  lastActiveAt?: number;
  /** When the native log's first record was written. */
  logCreatedAt?: number;
  deletedAt?: number;
  daysLeft?: number;
  trashId?: string;
  turns?: number;
  firstMessage?: string;
  logPath?: string;
  root?: string;
  origin?: string;
  /** found rows: how it was matched to this project. */
  source?: "footer" | "agora" | "cwd";
};

type Props = {
  docs: Doc[];
  titles: Record<string, string>;
  canvasTitles: Record<string, string>;
  open: Set<string>;
  /** The canvas an imported session goes to when its footer names none. */
  currentCanvas: string;
  onOpen: (docId: string) => void;
  onRestore: (trashId: string) => void;
  onImported: (docId: string, doc: SessionDoc) => void;
  onDismiss: () => void;
};

const DAY = 86400000;
const RANGES = { all: "全部时间", day: "24 小时内", week: "7 天内", month: "30 天内" } as const;
const STATES = { all: "全部状态", open: "打开的", closed: "已关闭", trash: "回收站", problem: "要处理的", import: "可以导入的" } as const;
const when = (at?: number) => (at ? new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

export function HistoryPanel({ docs, titles, canvasTitles, open, currentCanvas, onOpen, onRestore, onImported, onDismiss }: Props) {
  const agentLabel = useAgentName();
  const [data, setData] = useState<{ rows: HistoryRow[]; found: HistoryRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<AgentKind | "all">("all");
  const [canvas, setCanvas] = useState("all");
  const [state, setState] = useState<keyof typeof STATES>("all");
  const [range, setRange] = useState<keyof typeof RANGES>("all");
  const [full, setFull] = useState(false);
  const [hits, setHits] = useState<Map<string, string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [showCwd, setShowCwd] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const status = useAgents().status;
  const input = useRef<HTMLInputElement>(null);
  const load = () =>
    fetch("/api/project/history")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(setData, (e) => setErr(`读不到会话历史：${(e as Error).message}`));
  useEffect(() => {
    void load();
    input.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onDismiss());
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [onDismiss]);
  // Full text: the server reads the native logs (or Agora's snapshots when a log is gone).
  useEffect(() => {
    if (!full || q.trim().length < 2) return setHits(null);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setSearching(true);
      fetch(`/api/project/history/search?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal })
        .then((r) => r.json())
        .then((j: { matches: { key: string; snippet: string }[] }) => setHits(new Map(j.matches.filter((m) => m.key).map((m) => [m.key, m.snippet]))))
        .catch(() => {})
        .finally(() => setSearching(false));
    }, 300);
    return () => (clearTimeout(t), ctl.abort());
  }, [full, q]);

  const docOf = (r: HistoryRow) => docs.find((d): d is SessionDoc => d.kind === "session" && d.sessionId === r.sessionId);
  const nameOf = (r: HistoryRow) => {
    const d = docOf(r);
    if (d) return titles[d.id] ?? d.title;
    const agentName = r.agent ? agentLabel(r.agent) : "会话";
    return r.title || (r.topic ? `${agentName} · ${r.topic}` : r.firstMessage ? `${agentName} · ${r.firstMessage.slice(0, 24)}` : agentName);
  };
  const label = (r: HistoryRow): { text: string; tone?: "caution" | "error" } => {
    if (r.state === "trash") return { text: `在回收站 · ${r.daysLeft ?? "?"} 天后清除` };
    if (r.state === "registry") return { text: "不在项目里 · 本机有记录", tone: "caution" };
    if (r.state === "found") return { text: r.source === "cwd" ? "在项目目录里 · 不是 Agora 建的" : "在本机找到 · 不在项目里", tone: "caution" };
    if (r.origin === "foreign") return { text: "来自另一台机器", tone: "caution" };
    if (r.origin === "copy") return { text: "副本 · 只读", tone: "caution" };
    if (r.origin === "recoverable" || r.origin === "other-copy") return { text: r.origin === "other-copy" ? "属于另一份副本" : "绑定可恢复", tone: "caution" };
    if (r.state === "listed" && !r.agent) return { text: "还没选 agent" }; // a session nobody started: nothing to resume
    const st = r.sessionId ? status[r.sessionId] : undefined;
    if (st?.native?.blocking) return { text: "原生记录缺失", tone: "error" };
    if (st?.terminal.alive) return { text: "在终端里运行" };
    const d = docOf(r);
    return { text: d && open.has(d.id) ? "已打开" : "已关闭 · 可续接" };
  };
  const problem = (r: HistoryRow) => !!label(r).tone;

  const matches = (r: HistoryRow) => {
    if (agent !== "all" && r.agent !== agent) return false;
    if (canvas !== "all" && (r.canvasId ?? "") !== canvas) return false;
    const at = r.lastActiveAt ?? r.deletedAt ?? r.createdAt ?? 0;
    if (range !== "all" && Date.now() - at > { day: DAY, week: 7 * DAY, month: 30 * DAY }[range]) return false;
    const d = docOf(r);
    if (state === "open" && !(d && open.has(d.id))) return false;
    if (state === "closed" && !(r.state === "listed" && !(d && open.has(d.id)))) return false;
    if (state === "trash" && r.state !== "trash") return false;
    if (state === "import" && !(r.state === "registry" || r.state === "found")) return false;
    if (state === "problem" && !problem(r)) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    if (full && hits) return hits.has(r.sessionId ?? "") || hits.has(r.nativeId ?? "");
    return [nameOf(r), r.topic, r.firstMessage, r.canvasId && canvasTitles[r.canvasId], r.nativeId].some((x) => x?.toLowerCase().includes(needle));
  };
  const rows = useMemo(() => (data?.rows ?? []).filter(matches), [data, q, agent, canvas, state, range, full, hits, status, open, docs]);
  const found = useMemo(() => (data?.found ?? []).filter(matches), [data, q, agent, canvas, state, range, full, hits]);
  const agoraFound = found.filter((r) => r.source !== "cwd");
  const cwdFound = found.filter((r) => r.source === "cwd");

  /** Bring a session into the workspace: bound to its native session (started), on its canvas. */
  const importRow = async (r: HistoryRow) => {
    if (!r.agent || !r.nativeId) return;
    setBusy(r.nativeId);
    setErr(null);
    const reuse = r.sessionId && !sessions.get().sessions[r.sessionId] ? r.sessionId : undefined;
    const canvasId = r.canvasId && canvasTitles[r.canvasId] ? r.canvasId : currentCanvas;
    const s = reuse ? sessions.create(canvasId, reuse) : sessions.create(canvasId);
    try {
      await agents.bind(s.id, r.agent, r.model ?? "", r.effort ?? "", r.nativeId, true);
      const doc: SessionDoc = { id: sessionDocId(s.id), kind: "session", sessionId: s.id, title: "", ...(r.topic ? { topic: r.topic } : {}) };
      onImported(doc.id, doc);
    } catch (e) {
      const { [s.id]: _, ...rest } = sessions.get().sessions;
      sessions.hydrate({ ...sessions.get(), sessions: rest });
      setErr(`没能导入：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const row = (r: HistoryRow) => {
    const key = r.sessionId ?? r.nativeId ?? r.trashId ?? "";
    const l = label(r);
    const d = docOf(r);
    const snippet = full && hits ? (hits.get(r.sessionId ?? "") ?? hits.get(r.nativeId ?? "")) : undefined;
    const meta = [
      r.canvasId ? (canvasTitles[r.canvasId] ? `「${canvasTitles[r.canvasId]}」` : "画布不在工作区") : "",
      r.model ?? "",
      r.turns ? `${r.turns} 轮` : "",
      r.createdAt || r.logCreatedAt ? `建于 ${when(r.createdAt ?? r.logCreatedAt)}` : "",
      r.lastActiveAt ? `最后活动 ${when(r.lastActiveAt)}` : "",
    ].filter(Boolean);
    return (
      <li key={key} className="lp-row" data-state={r.state}>
        {r.agent ? <AgentAvatar kind={r.agent} size={20} label /> : <span className="ad-mark" data-kind="session" />}
        <div className="lp-main">
          <span className="lp-title">{nameOf(r)}</span>
          <span className="lp-meta">
            <em className="hs-state" data-tone={l.tone}>{l.text}</em>
            {meta.map((m) => ` · ${m}`).join("")}
          </span>
          {snippet && <span className="hs-snippet">…{snippet}…</span>}
          {!snippet && r.firstMessage && !d?.topic && r.state !== "listed" && <span className="hs-snippet">{r.firstMessage}</span>}
        </div>
        {r.state === "listed" && d && <button className="btn sm quiet" onClick={() => onOpen(d.id)}>打开</button>}
        {r.state === "trash" && r.trashId && <button className="btn sm quiet" onClick={() => onRestore(r.trashId!)}><IconRetry size={14} />恢复</button>}
        {(r.state === "registry" || r.state === "found") && r.nativeId && (
          <button className="btn sm quiet" disabled={busy === r.nativeId || !r.agent} onClick={() => void importRow(r)} title={r.logPath ? `原生日志：${r.logPath}` : undefined}>
            导入{r.canvasId && canvasTitles[r.canvasId] ? "" : "到当前画布"}
          </button>
        )}
      </li>
    );
  };

  const canvasIds = Object.keys(canvasTitles);
  return (
    <>
      <div className="lp-scrim" onPointerDown={onDismiss} />
      <motion.div className="lp hs" role="dialog" aria-label="会话历史" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
        <header className="lp-head">
          <IconHistory size={18} />
          <h2>会话历史</h2>
          <label className="hs-search">
            <IconSearch size={16} />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={full ? "搜索对话全文（至少 2 个字）" : "搜索名字、主题、首条消息"} aria-label="搜索会话" />
          </label>
          <button className="icon-btn sm muted" aria-label="关闭" onClick={onDismiss}><IconClose size={16} /></button>
        </header>
        <div className="hs-filters">
          <div className="seg" data-static role="radiogroup" aria-label="Agent">
            {(["all", ...AGENT_KINDS] as const).map((k) => (
              <button key={k} role="radio" aria-checked={agent === k} data-on={agent === k} onClick={() => setAgent(k)}>
                {k === "all" ? "全部" : agentLabel(k)}
              </button>
            ))}
          </div>
          <select value={canvas} onChange={(e) => setCanvas(e.target.value)} aria-label="画布">
            <option value="all">全部画布</option>
            {canvasIds.map((id) => <option key={id} value={id}>{canvasTitles[id]}</option>)}
          </select>
          <select value={state} onChange={(e) => setState(e.target.value as keyof typeof STATES)} aria-label="状态">
            {Object.entries(STATES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={range} onChange={(e) => setRange(e.target.value as keyof typeof RANGES)} aria-label="时间">
            {Object.entries(RANGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label className="hs-full" title="在各会话的原生日志里搜（原生日志没了就搜 Agora 的快照）">
            <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} />
            搜索对话全文{searching ? "…" : ""}
          </label>
        </div>
        {err && <p className="notice lp-note" role="alert" data-tone="error"><span>{err}</span></p>}
        {!data && !err && <p className="hs-loading">正在读取…</p>}
        {data && (
          <ul className="lp-list">
            {rows.length > 0 && <li className="ad-group">这个项目的会话 · {rows.length}</li>}
            {rows.map(row)}
            {agoraFound.length > 0 && <li className="ad-group">在本机找到、不在项目里的会话 · {agoraFound.length}</li>}
            {agoraFound.map(row)}
            {cwdFound.length > 0 && (
              <li className="ad-group">
                <button className="hs-toggle" aria-expanded={showCwd} onClick={() => setShowCwd((v) => !v)}>
                  {showCwd ? "▾" : "▸"} 在项目目录里、不是 Agora 建的会话 · {cwdFound.length}
                </button>
              </li>
            )}
            {showCwd && cwdFound.map(row)}
            {!rows.length && !found.length && (
              <li className="lp-empty">
                <span className="dither-field" aria-hidden />
                <p>{q || agent !== "all" || canvas !== "all" || state !== "all" || range !== "all" ? "没有符合条件的会话" : "这个项目还没有会话"}</p>
              </li>
            )}
          </ul>
        )}
      </motion.div>
    </>
  );
}
