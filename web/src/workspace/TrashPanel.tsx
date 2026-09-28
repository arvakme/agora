// 回收站: deleted canvases and sessions (server/canvas/trash.py), newest first, each restorable
// for 30 days — after a reload or a restart too. 彻底删除 asks once more; a session's native
// conversation is never deleted by Agora (the confirmation says where it is and how to remove it).
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { IconClose, IconRetry, IconTrash } from "../app/icons";
import { SPRING } from "../comments/motion";
import { AgentAvatar } from "../session/AgentAvatar";
import { AGENT_NAMES, type AgentKind } from "../session/agents";
import { nativeRemoval, trash, useTrash, type TrashItem } from "./trash";

type Props = {
  /** Scroll to and mark this item (a link from a comment or the toast). */
  focus?: string;
  titles: Record<string, string>;
  canvasTitles: Record<string, string>;
  onRestore: (trashId: string) => void;
  onDismiss: () => void;
};

const when = (at: number) => new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function TrashPanel({ focus, canvasTitles, onRestore, onDismiss }: Props) {
  const items = useTrash();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => void trash.refresh(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), confirm ? setConfirm(null) : onDismiss());
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [confirm, onDismiss]);
  useEffect(() => {
    if (focus) document.querySelector(`[data-trash="${focus}"]`)?.scrollIntoView({ block: "center" });
  }, [focus, items.length]);

  const purge = async (m: TrashItem) => {
    setConfirm(null);
    try {
      const r = await trash.purge(m.trashId);
      const how = nativeRemoval(r.native ?? m.native);
      setNote(m.kind === "session" && how ? `「${m.title || m.id}」已彻底删除。原生对话还在，要删除它：${how}` : `「${m.title || m.id}」已彻底删除。`);
    } catch (e) {
      setNote(`没能删除：${(e as Error).message}`);
    }
  };

  return (
    <>
      <div className="lp-scrim" onPointerDown={onDismiss} />
      <motion.div className="lp" role="dialog" aria-label="回收站" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
        <header className="lp-head">
          <IconTrash size={18} />
          <h2>回收站</h2>
          <span className="lp-sub">删除的画布和会话保留 30 天，刷新、重启后都能恢复</span>
          <button className="icon-btn sm muted" aria-label="关闭" onClick={onDismiss}><IconClose size={16} /></button>
        </header>
        {note && <p className="notice lp-note" role="status"><span>{note}</span></p>}
        {items.length === 0 ? (
          <div className="lp-empty">
            <span className="dither-field" aria-hidden />
            <p>回收站是空的</p>
          </div>
        ) : (
          <ul className="lp-list">
            {items.map((m) => {
              const agent = (m.native?.agent ?? (m.entry?.kind === "session" ? m.entry.agent : undefined)) as AgentKind | undefined;
              const canvasId = m.entry?.kind === "session" ? m.entry.canvasId : undefined;
              const meta =
                m.kind === "canvas"
                  ? [m.linked?.length ? `${m.linked.length} 个会话仍在工作区` : "", m.sharesEnded?.length ? `结束了 ${m.sharesEnded.length} 个分享` : ""]
                  : [agent ? AGENT_NAMES[agent] : "会话", canvasId ? (canvasTitles[canvasId] ? `画布「${canvasTitles[canvasId]}」` : "画布不在工作区") : ""];
              return confirm === m.trashId ? (
                <li key={m.trashId} className="ad-confirm" role="alertdialog" aria-label={`彻底删除 ${m.title}`}>
                  <p>
                    彻底删除「{m.title || m.id}」？{m.kind === "canvas" ? "画布和它的评论从本机删除，不能再恢复（提交过的版本还在 git 里）。" : "Agora 里的会话记录、改图记录和轨迹快照从本机删除，不能再恢复。"}
                    {m.kind === "session" && m.native?.nativeId ? `原生对话不删，仍在 ${m.native.logPath ?? `${agent ? AGENT_NAMES[agent] : "CLI"} 自己的日志里`}。` : ""}
                  </p>
                  <div>
                    <button className="btn sm ghost" autoFocus onClick={() => setConfirm(null)}>取消</button>
                    <button className="btn sm danger" onClick={() => void purge(m)}><IconTrash size={14} />彻底删除</button>
                  </div>
                </li>
              ) : (
                <li key={m.trashId} className="lp-row" data-trash={m.trashId} data-focus={focus === m.trashId}>
                  {m.kind === "session" && agent ? <AgentAvatar kind={agent} size={20} label /> : <span className="ad-mark" data-kind={m.kind} />}
                  <div className="lp-main">
                    <span className="lp-title">{m.title || m.id}</span>
                    <span className="lp-meta">
                      {m.kind === "canvas" ? "画布" : "会话"} · 删除于 {when(m.at)} · {m.daysLeft} 天后清除{meta.filter(Boolean).map((x) => ` · ${x}`).join("")}
                    </span>
                  </div>
                  <button className="btn sm quiet" onClick={() => onRestore(m.trashId)} title="放回原来的位置"><IconRetry size={14} />恢复</button>
                  <button className="icon-btn sm muted ad-del" onClick={() => setConfirm(m.trashId)} aria-label={`彻底删除 ${m.title}`} title="彻底删除…"><IconTrash size={16} /></button>
                </li>
              );
            })}
          </ul>
        )}
      </motion.div>
    </>
  );
}
