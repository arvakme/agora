// 所有画布: every canvas in the workspace (open or closed) with its sessions nested under it.
// Opening a closed one brings its tab back; deleting is confirmed here, in place.
import { motion } from "motion/react";
import { useEffect } from "react";
import { IconLayers, IconPlus, IconTrash } from "../app/icons";
import { SPRING } from "../comments/motion";
import { sessions } from "../session/store";
import { SessionMark } from "../session/AgentAvatar";
import type { CanvasDoc, Doc, SessionDoc } from "./model";

type Props = {
  docs: Doc[];
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
  onDismiss: () => void;
};

export function AllDocs({ docs, open, focused, confirm, setConfirm, canvasOf, commentCount, onOpen, onRemove, onNew, onDismiss }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), confirm ? setConfirm(undefined) : onDismiss());
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [confirm, setConfirm, onDismiss]);

  const canvases = docs.filter((d): d is CanvasDoc => d.kind === "canvas");
  const sessionDocs = docs.filter((d): d is SessionDoc => d.kind === "session");
  const orphans = sessionDocs.filter((s) => !canvases.some((c) => c.id === canvasOf(s)));

  const row = (d: Doc, sub = false) => {
    if (confirm === d.id) return <Confirm key={d.id} doc={d} comments={d.kind === "canvas" ? commentCount(d.id) : 0} onCancel={() => setConfirm(undefined)} onConfirm={() => onRemove(d.id)} />;
    const last = d.kind === "canvas" && canvases.length === 1;
    const state = d.id === focused ? "当前" : open.has(d.id) ? "已打开" : "已关闭";
    return (
      <li key={d.id} className="ad-row" data-sub={sub} data-open={open.has(d.id)} data-current={d.id === focused}>
        <button className="ad-main" onClick={() => onOpen(d.id)} title={open.has(d.id) ? "切换到这里" : "重新打开"}>
          {d.kind === "session" ? <SessionMark sessionId={d.sessionId} /> : <span className="ad-mark" data-kind={d.kind} />}
          <span className="ad-title">{d.title}</span>
          <span className="ad-state">{state}</span>
        </button>
        <button
          className="icon-btn sm muted ad-del"
          disabled={last}
          onClick={() => setConfirm(d.id)}
          aria-label={`删除 ${d.title}`}
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
          {canvases.map((c) => [row(c), ...sessionDocs.filter((s) => canvasOf(s) === c.id).map((s) => row(s, true))])}
          {orphans.length > 0 && <li className="ad-group">未关联画布</li>}
          {orphans.map((s) => row(s, true))}
        </ul>
        <footer className="ad-foot">
          <button className="btn sm ghost" onClick={() => onNew(false)}><IconPlus size={14} />新建空白画布</button>
          <button className="btn sm ghost" onClick={() => onNew(true)}><IconLayers size={14} />从示例新建</button>
        </footer>
      </motion.div>
    </>
  );
}

function Confirm({ doc, comments, onCancel, onConfirm }: { doc: Doc; comments: number; onCancel: () => void; onConfirm: () => void }) {
  const turns = doc.kind === "session" ? (sessions.get().sessions[doc.sessionId]?.turnIds.length ?? 0) : 0;
  const what = doc.kind === "canvas" ? `画布内容${comments ? `和 ${comments} 条评论` : ""}会一起删除，关联会话保留。` : turns ? `${turns} 轮对话记录会一起删除。` : "它还没有对话记录。";
  return (
    <li className="ad-confirm" role="alertdialog" aria-label={`删除 ${doc.title}`}>
      <p>
        删除「{doc.title}」？{what}删除后可以立即撤销。
      </p>
      <div>
        <button className="btn sm ghost" autoFocus onClick={onCancel}>取消</button>
        <button className="btn sm danger" onClick={onConfirm}><IconTrash size={14} />删除</button>
      </div>
    </li>
  );
}
