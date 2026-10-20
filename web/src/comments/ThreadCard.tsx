// Thread card: one floating card (theme-following, radius 14) that morphs from a hover preview
// into the full thread (layout animation), with replies, agent results and actions.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { handOff, undoAgent } from "../ops/agent";
import type { AnchorState } from "../canvas/anchors";
import { IconCheck, IconClose, IconHint, IconPencil, IconRetry, IconSend, IconTarget, IconTrash } from "../app/icons";
import type { Message, Thread, ThreadStore } from "./threads";
import { canDelete, canEdit, identity, isGuestId } from "./threads";
import { offerUndo } from "./undo";
import { GUEST } from "../guest/mode";
import { SPRING } from "./motion";
import { useSessions, useTurn } from "../session/store";
import { useTrash } from "../workspace/trash";
import { useAgentName, useAgents } from "../session/agents";
import { AgentAvatar } from "../session/AgentAvatar";
import { ui } from "../session/ui";
import { canRedoTurn, redoTurn } from "../session/runTurn";
import { UndoButtons } from "../session/StepActs";
import { collapseSuperseded, PIN_LABEL, pinState } from "./handoffState";
import { handoffLine, routeMessage, submitMention, type MentionTarget } from "./mention";
import { MentionField } from "./MentionField";
import "./handoff.css";
import { useAuthorColors, type AuthorSlot } from "./authorColor";
import { anchorNote } from "./anchorNote";
import { MomentChip } from "./MomentChip";
import type { CardPos } from "./cardPlace";
import { tr, langTag } from "../i18n";

export function ThreadCard({ t, st, mode, api, store, pos, onHover, onRepin }: {
  t: Thread;
  st: AnchorState;
  mode: "preview" | "full";
  api: ExcalidrawImperativeAPI;
  store: ThreadStore;
  pos: CardPos;
  onHover?: (inside: boolean) => void;
  /** 「重新钉到…」: the next element picked becomes this thread's anchor. */
  onRepin?: (threadId: string) => void;
}) {
  const agentName = useAgentName();
  const colors = useAuthorColors(store);
  const full = mode === "full";
  const [first, ...rest] = t.messages;
  const running = t.agent === "running";
  const ag = useAgents();
  const { sessions: all } = useSessions();
  return (
    <motion.div
      layout
      className="tcard"
      data-mode={mode}
      data-flip={pos.flip}
      role={full ? "dialog" : "tooltip"}
      aria-label={tr(`线程 ${t.n}`, `Thread ${t.n}`)}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14 } }}
      transition={SPRING}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH, originX: pos.flip ? 1 : 0, originY: pos.up ? 1 : 0, borderRadius: 14 }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={() => onHover?.(true)}
      onPointerLeave={() => onHover?.(false)}
      onClick={() => !full && store.open(t.id)}
    >
      {full && (
        <motion.header layout="position" className="tcard-head" transition={SPRING}>
          <span className="tcard-anchor">
            <span className="tcard-n">#{t.n}</span>
            {st.status === "whole" && <span className="tcard-whole">{tr("整张图", "Whole canvas")}</span>}
            <MomentChip t={t} canvasId={store.canvasId} />
          </span>
          <span className="tcard-actions">
            {!GUEST && (
              <button className="icon-btn sm" onClick={() => store.setResolved(t.id, !t.resolved)} title={t.resolved ? tr("重新打开", "Reopen") : tr("解决", "Resolve")} aria-label={t.resolved ? tr("重新打开", "Reopen") : tr("解决", "Resolve")}>
                {t.resolved ? <IconRetry size={16} /> : <IconCheck size={16} />}
              </button>
            )}
            {!GUEST && (
              <button className="icon-btn sm muted" onClick={() => offerUndo(store.removeThread(t.id))} title={tr("删除整条线程（可撤销）", "Delete the whole thread (can be undone)")} aria-label={tr("删除线程", "Delete thread")}>
                <IconTrash size={16} />
              </button>
            )}
            <button className="icon-btn sm muted" onClick={() => store.close()} title={tr("关闭", "Close")} aria-label={tr("关闭", "Close")}><IconClose size={16} /></button>
          </span>
        </motion.header>
      )}
      {full && anchorNote(st) && (
        <div className="tcard-warn">
          <IconHint size={14} />
          <span>{anchorNote(st)}</span>
          {!GUEST && onRepin && <button className="btn sm quiet" onClick={() => onRepin(t.id)}><IconTarget size={14} />{tr("重新钉到…", "Repin to…")}</button>}
        </div>
      )}
      <div className="tcard-scroll">
        <Row m={first} first tools={full ? { store, threadId: t.id } : undefined} slot={colors.ofMessage(first)} />
        {!full && (rest.length > 0 || running) && (
          <motion.div layout="position" className="tcard-more">
            {running ? <span className="waiting"><i className="dot" data-tone="ok" />{tr("Agent 正在处理…", "Agent is working…")}</span> : repliesText(rest.length)}
          </motion.div>
        )}
        <AnimatePresence initial={false}>
          {full &&
            collapseSuperseded(rest, (sid) => (sid && ag.bindings[sid] ? agentName(ag.bindings[sid].agent) : t.handoff ? agentName(t.handoff.agent) : undefined)).map((m) => "folded" in m ? (
              <Reveal key={m.id}>
                <div className="tfolded" title={tr("这条之前没能交出去，后来已经重新交给 Agent 并有了答复", "This failed to hand off earlier; it was handed to the agent again and got a reply")}>{m.text}</div>
              </Reveal>
            ) : (
              <Reveal key={m.id}>
                <Row m={m} tools={{ store, threadId: t.id }} slot={colors.ofMessage(m)} onUndo={GUEST ? undefined : () => undoAgent(api, store, t.id, m.id)} onRedo={GUEST || !m.turnId ? undefined : () => redoTurn(api, m.turnId!)} />
              </Reveal>
            ))}
          {full && running && (
            <Reveal key="running">
              <div className="trow">
                <Avatar who="agent" />
                <div className="trow-main">
                  <div className="trow-meta"><b>Agent</b></div>
                  <span className="waiting"><i className="dot" data-tone="ok" />{tr("已交给会话里的 Agent，等它改完答复…", "Handed to the agent in the session; waiting for it to finish and reply…")}</span>
                </div>
              </div>
            </Reveal>
          )}
        </AnimatePresence>
      </div>
      {full && <div className="tstate" data-state={pinState(t)}>{PIN_LABEL[pinState(t)]}</div>}
      {full && !GUEST && t.handoff && (
        <div className="thandoff" data-gone={!all[t.handoff.sessionId]}>
          <span className="thandoff-line" title={t.handoff.name}>{handoffLine(t.handoff, agentName(t.handoff.agent), pinState(t), !all[t.handoff.sessionId])}</span>
          <button className="btn sm ghost" disabled={running} onClick={() => store.endHandoff(t.id)} title={tr("以后在这条线程里的回复是普通评论，不再发给这个对话", "Later replies in this thread become plain comments and are no longer sent to this conversation")}>{tr("结束交接", "End hand-off")}</button>
        </div>
      )}
      {full && (
        <Reply
          resolved={t.resolved}
          canvasId={store.canvasId}
          handoff={t.handoff}
          bound={!!t.handoff && !GUEST}
          onSend={(text, mention) => {
            const route = routeMessage({ guest: GUEST, mention, handoff: t.handoff });
            store.reply(t.id, { author: "you", text });
            if (route.kind === "hand") void handOff(api, store, t.id, route.to, { bound: route.bound, ...(route.bound && t.handoff ? { name: t.handoff.name } : mention?.type === "session" ? { name: mention.label } : {}), ...(mention && { mention: mention.label }) });
          }}
        />
      )}
    </motion.div>
  );
}

/** Height + fade reveal for rows that arrive while the card is open. */
function Reveal({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={SPRING}
      style={{ overflow: "hidden" }}
    >
      {children}
    </motion.div>
  );
}

function Row({ m, first, onUndo, onRedo, tools, slot }: { m: Message; first?: boolean; onUndo?: () => void; onRedo?: () => void; tools?: { store: ThreadStore; threadId: string }; /** the author's colour (./authorColor.ts) */ slot?: AuthorSlot }) {
  const [editing, setEditing] = useState(false);
  // Eval replies are the session turn itself; native-session replies carry the agent's own
  // text and point at their last canvas change (for undo) and the session.
  const turn = useTurn(GUEST ? undefined : m.turnId);
  const native = !!m.sessionId;
  const reply = native ? (turn?.reply ? { ...turn.reply, text: m.text, tone: m.tone } : undefined) : turn?.reply;
  const meta = turn && !native ? `${(((turn.endedAt ?? Date.now()) - turn.startedAt) / 1000).toFixed(1)}s${turn.costUsd != null ? ` · $${turn.costUsd.toFixed(4)}` : ""}` : ago(m.at);
  const other = m.author === "you" && !!m.by && m.by.id !== identity()?.id;
  // A native session's reply shows that session's agent (Pi / Claude Code / Codex) by its own mark.
  const agentKind = useAgents().bindings[m.sessionId ?? ""]?.agent;
  const nameOf = useAgentName();
  return (
    <div className="trow" data-first={first} data-tone={reply?.tone ?? m.tone}>
      {m.author === "agent" && agentKind ? <AgentAvatar kind={agentKind} size={26} /> : <Avatar who={m.author} name={other ? m.by!.name : undefined} author={m.author === "you" ? slot : undefined} />}
      <div className="trow-main">
        <div className="trow-meta">
          <b>{m.author === "agent" ? nameOf(agentKind) : m.author === "system" ? tr("系统", "System") : other ? m.by!.name : tr("你", "You")}</b>
          {other && isGuestId(m.by!.id) && !GUEST && <span className="tguest">{tr("访客", "Guest")}</span>}
          <time>{meta}</time>
          {m.editedAt && <span className="tedited" title={tr(`编辑于 ${new Date(m.editedAt).toLocaleString("zh-CN")}`, `Edited ${new Date(m.editedAt).toLocaleString(langTag())}`)}>{tr("已编辑", "Edited")}</span>}
          {tools && !editing && (canEdit(m) || canDelete(m)) && (
            <span className="trow-tools">
              {canEdit(m) && (
                <button className="icon-btn xs muted" onClick={() => setEditing(true)} title={tr("编辑", "Edit")} aria-label={tr("编辑这条评论", "Edit this comment")}><IconPencil size={14} /></button>
              )}
              <button className="icon-btn xs muted" onClick={() => offerUndo(tools.store.removeMessage(tools.threadId, m.id))} title={tr("删除（可撤销）", "Delete (can be undone)")} aria-label={tr("删除这条评论", "Delete this comment")}><IconTrash size={14} /></button>
            </span>
          )}
        </div>
        {editing && tools ? (
          <EditBox
            initial={m.text}
            onCancel={() => setEditing(false)}
            onSave={(text) => {
              tools.store.edit(tools.threadId, m.id, text);
              setEditing(false);
            }}
          />
        ) : (
          <p className="trow-text">{reply?.text ?? m.text}</p>
        )}
        {reply?.undoError && <p className="trow-text" data-warn>{reply.undoError}</p>}
        {reply?.changes && (
          <div className="tchanges" data-undone={!!reply.undone}>
            <ul>{reply.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            {onUndo && reply.batchId ? (
              <span className="tchanges-acts"><UndoButtons undone={!!reply.undone} canRedo={!!m.turnId && canRedoTurn(m.turnId)} canAct onUndo={onUndo} onRedo={onRedo ?? (() => {})} /></span>
            ) : (
              reply.undone && <span className="act-status">{tr("已撤销", "Undone")}</span>
            )}
          </div>
        )}
        {GUEST ? null : native ? (
          <SessionLink sessionId={m.sessionId!} turnId={m.turnId} />
        ) : turn && (
          <button className="tsession" onClick={() => ui.openSession(turn.sessionId, turn.id)}>
            {tr(`在会话中查看第 ${turn.n} 轮 · ${turn.steps.length} 步 →`, `View turn ${turn.n} in the session · ${turn.steps.length} ${turn.steps.length === 1 ? "step" : "steps"} →`)}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A native-session reply links to its session. A session in the trash links to 回收站 (restore it
 * there); one deleted for good says so — the reply's text stays either way.
 */
function SessionLink({ sessionId, turnId }: { sessionId: string; turnId?: string }) {
  const { sessions: all } = useSessions();
  const inTrash = useTrash().find((x) => x.kind === "session" && x.id === sessionId);
  if (all[sessionId])
    return (
      <button className="tsession" onClick={() => ui.openSession(sessionId, turnId)}>
        {tr("在会话中查看 →", "View in session →")}
      </button>
    );
  if (inTrash)
    return (
      <button className="tsession" onClick={() => ui.openTrash(inTrash.trashId)} title={tr("会话在回收站：恢复后这一轮照常可看", "The session is in the trash: restore it to see this turn again")}>
        {tr("会话在回收站 · 恢复 →", "Session in trash · Restore →")}
      </button>
    );
  return <span className="tsession" data-gone>{tr("会话已删除", "Session deleted")}</span>;
}

/** A person is an initial in a circle of their colour; the system note is a hint icon (an agent has its own mark). */
export function Avatar({ who, name, author }: { who: Message["author"]; name?: string; /** A person's colour (./authorColor.ts); an agent and the system have none. */ author?: AuthorSlot }) {
  return (
    <span className="avatar" data-who={who} data-other={!!name} data-author={author}>
      {who === "agent" ? "A" : who === "system" ? <IconHint size={14} /> : name ? [...name.trim()][0] ?? "?" : tr("你", "Y")}
    </span>
  );
}

/** In-place edit of one's own message: Enter saves, Esc cancels (and only that). */
function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => (text.trim() ? onSave(text.trim()) : undefined);
  return (
    <form className="treply tedit" data-esc-local onSubmit={(e) => (e.preventDefault(), save())}>
      <textarea
        ref={ref}
        value={text}
        rows={1}
        aria-label={tr("编辑评论", "Edit comment")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onCancel());
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), save());
        }}
      />
      <button type="button" className="btn sm ghost" onClick={onCancel}>{tr("取消", "Cancel")}</button>
      <button type="submit" className="btn sm primary" disabled={!text.trim() || text.trim() === initial}>{tr("保存", "Save")}</button>
    </form>
  );
}

/** Replying to a resolved thread reopens it (the store does that; the placeholder says so). `bound`: the thread is a conversation with an agent, so the reply goes to it. */
function Reply({ onSend, resolved, bound, canvasId, handoff }: { onSend: (text: string, mention: MentionTarget | null) => void; resolved?: boolean; bound?: boolean; canvasId?: string; handoff?: Thread["handoff"] }) {
  const [text, setText] = useState("");
  const picked = useRef<MentionTarget | null>(null); // the pick made in the @ list: Enter and the send button carry the same one
  const send = (t: string, mention: MentionTarget | null) => {
    onSend(t, mention);
    picked.current = null;
    setText("");
  };
  const placeholder = resolved ? tr("回复会重新打开这条评论…", "Replying reopens this comment…") : bound ? tr("回复（会发给上面的对话）…", "Reply (goes to the conversation above)…") : GUEST ? tr("回复…", "Reply…") : tr("回复，输入 @ 交给 agent…", "Reply, or type @ to hand to an agent…");
  return (
    <form className="treply" onSubmit={(e) => (e.preventDefault(), (() => { const s = submitMention(text, picked.current); if (s) send(s.text, s.mention); })())}>
      <MentionField value={text} onValue={setText} onSend={send} placeholder={placeholder} canvasId={canvasId} handoff={handoff} pickedRef={picked} />
      <button type="submit" className="send" disabled={!text.trim()} aria-label={tr("发送回复", "Send reply")}><IconSend size={14} /></button>
    </form>
  );
}

export function Composer({ pos, text, onText, onCancel, onSubmit, canvasId }: {
  canvasId?: string;
  pos: CardPos;
  text: string;
  onText: (text: string) => void;
  onCancel: () => void;
  onSubmit: (text: string, mention: MentionTarget | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const picked = useRef<MentionTarget | null>(null); // the pick made in the @ list: Enter and the send button carry the same one
  const submit = (t: string, mention: MentionTarget | null) => (onSubmit(t, mention), (picked.current = null));
  return (
    <motion.form
      className="tcard composer"
      data-flip={pos.flip}
      initial={{ opacity: 0, scale: 0.92, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
      transition={SPRING}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, originX: pos.flip ? 1 : 0, originY: pos.up ? 1 : 0, borderRadius: 14 }}
      onSubmit={(e) => (e.preventDefault(), (() => { const s = submitMention(text, picked.current); if (s) submit(s.text, s.mention); })())}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="composer-head">
        <span className="composer-anchor"><span className="tcard-n new">{tr("新评论", "New comment")}</span></span>
        <button type="button" className="icon-btn sm muted" onClick={onCancel} aria-label={tr("取消评论", "Cancel comment")} title={tr("取消（Esc）", "Cancel (Esc)")}><IconClose size={16} /></button>
      </div>
      <div className="treply bare">
        <MentionField textareaRef={ref} value={text} onValue={onText} onSend={submit} rows={2} canvasId={canvasId} pickedRef={picked} placeholder={GUEST ? tr("添加评论…", "Add a comment…") : tr("添加评论，输入 @ 交给 agent…", "Add a comment, or type @ to hand to an agent…")} />
        <button type="submit" className="send" disabled={!text.trim()} aria-label={tr("发表评论", "Post comment")}><IconSend size={14} /></button>
      </div>
    </motion.form>
  );
}

export function ago(at: number) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 45) return tr("刚刚", "just now");
  if (s < 3600) return tr(`${Math.round(s / 60)} 分钟前`, `${Math.round(s / 60)}m ago`);
  if (s < 86400) return tr(`${Math.round(s / 3600)} 小时前`, `${Math.round(s / 3600)}h ago`);
  return tr(`${Math.round(s / 86400)} 天前`, `${Math.round(s / 86400)}d ago`);
}

export const repliesText = (n: number) => tr(`${n} 条回复`, n === 1 ? "1 reply" : `${n} replies`);
