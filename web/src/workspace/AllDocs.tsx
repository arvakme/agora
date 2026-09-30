// 所有画布: every canvas in the workspace (open or closed) with its sessions nested under it.
// Opening a closed one brings its tab back; deleting is confirmed here, in place, and moves the item
// to 回收站 (restorable for 30 days). Draft sessions (no agent chosen yet) are not listed: they exist
// only as their open tab until an agent is picked.
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { IconHistory, IconLayers, IconPlus, IconTrash } from "../app/icons";
import { SPRING } from "../comments/motion";
import { sessions } from "../session/store";
import { SessionMark } from "../session/AgentAvatar";
import { agents, logDirOf, useAgentName } from "../session/agents";
import { listGroups, type CanvasDoc, type Doc, type SessionDoc } from "./model";
import { useTrash } from "./trash";

type Props = {
  docs: Doc[];
  /** Display names by doc id (sessions: agent · topic, see workspace/model.ts sessionTitles). */
  titles: Record<string, string>;
  open: Set<string>;
  focused: string;
  /** Doc id whose delete is being confirmed. */
  confirm?: string;
  setConfirm: (id: string | undefined) => void;
  canvasOf: (d: SessionDoc) => string;
  commentCount: (canvasId: string) => number;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onNew: (sample: boolean) => void;
  onTrash: () => void;
  onHistory?: () => void;
  onDismiss: () => void;
  /** Nested canvases: how deep a canvas sits (0 = top level) and how many canvases are below it. */
  depth?: (canvasId: string) => number;
  childCount?: (canvasId: string) => number;
};

export function AllDocs({ docs, titles, open, focused, confirm, setConfirm, canvasOf, commentCount, onOpen, onRemove, onNew, onTrash, onHistory, onDismiss, depth = () => 0, childCount = () => 0 }: Props) {
  const inTrash = useTrash();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), confirm ? setConfirm(undefined) : onDismiss());
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [confirm, setConfirm, onDismiss]);

  const canvases = docs.filter((d): d is CanvasDoc => d.kind === "canvas");
  const sessionDocs = docs.filter((d): d is SessionDoc => d.kind === "session");
  const groups = listGroups(docs, canvasOf, new Set(inTrash.filter((m) => m.kind === "canvas").map((m) => m.id)));
  const { waiting, unlinked } = groups;

  const row = (d: Doc, sub = false) => {
    const title = titles[d.id] ?? d.title;
    if (confirm === d.id) return <Confirm key={d.id} doc={d} title={title} comments={d.kind === "canvas" ? commentCount(d.id) : 0} sessions={d.kind === "canvas" ? sessionDocs.filter((s) => canvasOf(s) === d.id).length : 0} kids={d.kind === "canvas" ? childCount(d.id) : 0} onCancel={() => setConfirm(undefined)} onConfirm={() => onRemove(d.id)} />;
    const last = d.kind === "canvas" && canvases.length === 1;
    const state = d.id === focused ? "当前" : open.has(d.id) ? "已打开" : "已关闭";
    return (
      <li key={d.id} className="ad-row" data-sub={sub} data-open={open.has(d.id)} data-current={d.id === focused} style={d.kind === "canvas" && depth(d.id) ? ({ "--ad-depth": depth(d.id) } as React.CSSProperties) : undefined} data-nested={d.kind === "canvas" && depth(d.id) > 0 ? true : undefined}>
        <button className="ad-main" onClick={() => onOpen(d.id)} title={open.has(d.id) ? "切换到这里" : "重新打开"}>
          {d.kind === "session" ? <SessionMark sessionId={d.sessionId} fallback={d.agent} /> : <span className="ad-mark" data-kind={d.kind} />}
          <span className="ad-title">{title}</span>
          <span className="ad-state">{state}</span>
        </button>
        <button
          className="icon-btn sm muted ad-del"
          disabled={last}
          onClick={() => setConfirm(d.id)}
          aria-label={`删除 ${title}`}
          title={last ? "至少保留一个画布" : "删除…"}
        >
          <IconTrash size={16} />
        </button>
      </li>
    );
  };

  return (
    <>
      <div className="ad-scrim" onPointerDown={onDismiss} />
      <motion.div className="ad" role="dialog" aria-label="所有画布" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
        <ul className="ad-list">
          {groups.canvases.map(({ canvas, sessions: linked }) => [row(canvas), ...linked.map((s) => row(s, true))])}
          {waiting.length > 0 && <li className="ad-group">未关联画布（画布在回收站）</li>}
          {waiting.map((s) => row(s, true))}
          {unlinked.length > 0 && <li className="ad-group">未关联画布</li>}
          {unlinked.map((s) => row(s, true))}
        </ul>
        <footer className="ad-foot">
          <button className="btn sm ghost" onClick={() => onNew(false)}><IconPlus size={14} />新建空白画布</button>
          <button className="btn sm ghost" onClick={() => onNew(true)}><IconLayers size={14} />从示例新建</button>
        </footer>
        <footer className="ad-foot" data-tools>
          {onHistory && <button className="btn sm ghost" onClick={onHistory} title="按时间、agent、主题、画布找会话，也能找回本机的原生会话"><IconHistory size={14} />会话历史</button>}
          <button className="btn sm ghost" onClick={onTrash} title="删除的画布和会话，30 天内可恢复"><IconTrash size={14} />回收站{inTrash.length ? <em>{inTrash.length}</em> : null}</button>
        </footer>
      </motion.div>
    </>
  );
}

function Confirm({ doc, title, comments, sessions: linked, kids, onCancel, onConfirm }: { doc: Doc; title: string; comments: number; sessions: number; kids: number; onCancel: () => void; onConfirm: () => void }) {
  const nameOf = useAgentName();
  const [shares, setShares] = useState(0);
  useEffect(() => {
    if (doc.kind !== "canvas") return;
    void fetch("/api/share")
      .then((r) => r.json())
      .then((j: { shares?: { canvasId: string; status: string }[] }) => setShares((j.shares ?? []).filter((s) => s.canvasId === doc.id && s.status === "active").length))
      .catch(() => {});
  }, [doc]);
  const turns = doc.kind === "session" ? (sessions.get().sessions[doc.sessionId]?.turnIds.length ?? 0) : 0;
  const b = doc.kind === "session" ? agents.get().bindings[doc.sessionId] : undefined;
  const agent = b ? nameOf(b.agent) : "CLI";
  const where = logDirOf(b?.agent ?? "claude");
  // What moves to the trash, what stays, what ends — the plan's wording (web/docs/workspace-model.md §1).
  const what =
    doc.kind === "canvas"
      ? `画布${comments ? `和 ${comments} 条评论` : ""}移到回收站，30 天内可恢复；关联的 ${linked} 个会话保留${shares ? `；这块画布上的 ${shares} 个分享会立即结束（恢复画布不会恢复分享）` : ""}。${kids ? `它下面的 ${kids} 张子图不删，只断开链接，留在列表里。` : ""}`
      : `会话${turns ? `（${turns} 次改图）` : ""}移到回收站，30 天内可恢复；${agent} 的原生对话不受影响（${where}）；终端里正在运行的 ${agent} 会被关闭。`;
  return (
    <li className="ad-confirm" role="alertdialog" aria-label={`删除 ${title}`}>
      <p>
        删除「{title}」？{what}
      </p>
      <div>
        <button className="btn sm ghost" autoFocus onClick={onCancel}>取消</button>
        <button className="btn sm danger" onClick={onConfirm}><IconTrash size={14} />移到回收站</button>
      </div>
    </li>
  );
}
