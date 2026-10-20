// 回收站: deleted canvases and sessions (server/canvas/trash.py), newest first, each restorable
// for 30 days — after a reload or a restart too. 彻底删除 asks once more; a session's native
// conversation is never deleted by Agora (the confirmation says where it is and how to remove it).
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { IconClose, IconRetry, IconTrash } from "../app/icons";
import { SPRING } from "../comments/motion";
import { AgentAvatar } from "../session/AgentAvatar";
import { useAgentName, type AgentKind } from "../session/agents";
import { nativeRemoval, trash, useTrash, type TrashItem } from "./trash";
import { langTag, tr } from "../i18n";

type Props = {
  /** Scroll to and mark this item (a link from a comment or the toast). */
  focus?: string;
  titles: Record<string, string>;
  canvasTitles: Record<string, string>;
  onRestore: (trashId: string) => void;
  onDismiss: () => void;
};

const when = (at: number) => new Date(at).toLocaleString(langTag(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function TrashPanel({ focus, canvasTitles, onRestore, onDismiss }: Props) {
  const nameOf = useAgentName();
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
      setNote(m.kind === "session" && how ? tr(`「${m.title || m.id}」已彻底删除。原生对话还在，要删除它：${how}`, `“${m.title || m.id}” deleted for good. The native conversation is still there; to delete it: ${how}`) : tr(`「${m.title || m.id}」已彻底删除。`, `“${m.title || m.id}” deleted for good.`));
    } catch (e) {
      setNote(tr(`没能删除：${(e as Error).message}`, `Couldn't delete: ${(e as Error).message}`));
    }
  };

  return (
    <>
      <div className="lp-scrim" onPointerDown={onDismiss} />
      <motion.div className="lp" role="dialog" aria-label={tr("回收站", "Trash")} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
        <header className="lp-head">
          <IconTrash size={18} />
          <h2>{tr("回收站", "Trash")}</h2>
          <span className="lp-sub">{tr("删除的画布和会话保留 30 天，刷新、重启后都能恢复", "Kept for 30 days, through reloads and restarts")}</span>
          <button className="icon-btn sm muted" aria-label={tr("关闭", "Close")} onClick={onDismiss}><IconClose size={16} /></button>
        </header>
        {note && <p className="notice lp-note" role="status"><span>{note}</span></p>}
        {items.length === 0 ? (
          <div className="lp-empty">
            <span className="dither-field" aria-hidden />
            <p>{tr("回收站是空的", "Trash is empty")}</p>
          </div>
        ) : (
          <ul className="lp-list">
            {items.map((m) => {
              const agent = (m.native?.agent ?? (m.entry?.kind === "session" ? m.entry.agent : undefined)) as AgentKind | undefined;
              const canvasId = m.entry?.kind === "session" ? m.entry.canvasId : undefined;
              const meta =
                m.kind === "canvas"
                  ? [m.linked?.length ? tr(`${m.linked.length} 个会话仍在工作区`, m.linked.length === 1 ? "1 session still in workspace" : `${m.linked.length} sessions still in workspace`) : "", m.sharesEnded?.length ? tr(`结束了 ${m.sharesEnded.length} 个分享`, m.sharesEnded.length === 1 ? "ended 1 share" : `ended ${m.sharesEnded.length} shares`) : ""]
                  : [agent ? nameOf(agent) : tr("会话", "Session"), canvasId ? (canvasTitles[canvasId] ? tr(`画布「${canvasTitles[canvasId]}」`, `canvas “${canvasTitles[canvasId]}”`) : tr("画布不在工作区", "canvas not in workspace")) : ""];
              return confirm === m.trashId ? (
                <li key={m.trashId} className="ad-confirm" role="alertdialog" aria-label={tr(`彻底删除 ${m.title}`, `Delete ${m.title} for good`)}>
                  <p>
                    {tr(`彻底删除「${m.title || m.id}」？`, `Delete “${m.title || m.id}” for good? `)}
                    {m.kind === "canvas"
                      ? tr("画布和它的评论从本机删除，不能再恢复（提交过的版本还在 git 里）。", "The canvas and its comments are deleted from this machine and can't be restored (committed versions stay in git).")
                      : tr("Agora 里的会话记录、改图记录和轨迹快照从本机删除，不能再恢复。", "Agora's session record, canvas edits and trajectory snapshots are deleted from this machine and can't be restored.")}
                    {m.kind === "session" && m.native?.nativeId
                      ? tr(
                          `原生对话不删，仍在 ${m.native.logPath ?? `${agent ? nameOf(agent) : "CLI"} 自己的日志里`}。`,
                          ` The native conversation is kept, still in ${m.native.logPath ?? `${agent ? nameOf(agent) : "the CLI"}'s own log`}.`,
                        )
                      : ""}
                  </p>
                  <div>
                    <button className="btn sm ghost" autoFocus onClick={() => setConfirm(null)}>{tr("取消", "Cancel")}</button>
                    <button className="btn sm danger" onClick={() => void purge(m)}><IconTrash size={14} />{tr("彻底删除", "Delete for good")}</button>
                  </div>
                </li>
              ) : (
                <li key={m.trashId} className="lp-row" data-trash={m.trashId} data-focus={focus === m.trashId}>
                  {m.kind === "session" && agent ? <AgentAvatar kind={agent} size={20} label /> : <span className="ad-mark" data-kind={m.kind} />}
                  <div className="lp-main">
                    <span className="lp-title">{m.title || m.id}</span>
                    <span className="lp-meta">
                      {m.kind === "canvas" ? tr("画布", "Canvas") : tr("会话", "Session")} · {tr(`删除于 ${when(m.at)} · ${m.daysLeft} 天后清除`, `deleted ${when(m.at)} · purged in ${m.daysLeft} ${m.daysLeft === 1 ? "day" : "days"}`)}{meta.filter(Boolean).map((x) => ` · ${x}`).join("")}
                    </span>
                  </div>
                  <button className="btn sm quiet" onClick={() => onRestore(m.trashId)} title={tr("放回原来的位置", "Put it back where it was")}><IconRetry size={14} />{tr("恢复", "Restore")}</button>
                  <button className="icon-btn sm muted ad-del" onClick={() => setConfirm(m.trashId)} aria-label={tr(`彻底删除 ${m.title}`, `Delete ${m.title} for good`)} title={tr("彻底删除…", "Delete for good…")}><IconTrash size={16} /></button>
                </li>
              );
            })}
          </ul>
        )}
      </motion.div>
    </>
  );
}
