// Thread card: one floating card (theme-following, radius 14) that morphs from a hover preview
// into the full thread (layout animation), with replies, agent results and actions.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { handOff, undoAgent } from "../ops/agent";
import type { AnchorState } from "../canvas/anchors";
import { IconCheck, IconClose, IconHint, IconPencil, IconRetry, IconSend, IconTrash, IconUndo } from "../app/icons";
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
import { collapseSuperseded, PIN_LABEL, pinState } from "./handoffState";
import { handoffLine, routeMessage, type MentionTarget } from "./mention";
import { MentionField } from "./MentionField";
import "./handoff.css";
import { AnchorTag, type AnchorName } from "./AnchorTag";
import type { CardPos } from "./CommentLayer";

export function ThreadCard({ t, st, mode, api, store, pos, onHover }: {
  t: Thread;
  st: AnchorState;
  mode: "preview" | "full";
  api: ExcalidrawImperativeAPI;
  store: ThreadStore;
  pos: CardPos;
  onHover?: (inside: boolean) => void;
}) {
  const agentName = useAgentName();
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
      aria-label={`线程 ${t.n}`}
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
            <AnchorTag names={st.names} />
          </span>
          <span className="tcard-actions">
            {!GUEST && (
              <button className="icon-btn sm" onClick={() => store.setResolved(t.id, !t.resolved)} title={t.resolved ? "重新打开" : "解决"} aria-label={t.resolved ? "重新打开" : "解决"}>
                {t.resolved ? <IconRetry size={16} /> : <IconCheck size={16} />}
              </button>
            )}
            {!GUEST && (
              <button className="icon-btn sm muted" onClick={() => offerUndo(store.removeThread(t.id))} title="删除整条线程（可撤销）" aria-label="删除线程">
                <IconTrash size={16} />
              </button>
            )}
            <button className="icon-btn sm muted" onClick={() => store.close()} title="关闭" aria-label="关闭"><IconClose size={16} /></button>
          </span>
        </motion.header>
      )}
      {st.status !== "ok" && full && (
        <div className="tcard-warn"><IconHint size={14} /><b>锚点丢失</b>{st.status === "lost" ? "被评论的元素已删除；撤销删除或重新钉一条" : "有的元素已删除，其余仍在"}</div>
      )}
      <div className="tcard-scroll">
        <Row m={first} first tools={full ? { store, threadId: t.id } : undefined} />
        {!full && (rest.length > 0 || running) && (
          <motion.div layout="position" className="tcard-more">
            {running ? <span className="waiting"><i className="dot" data-tone="ok" />Agent 正在处理…</span> : `${rest.length} 条回复`}
          </motion.div>
        )}
        <AnimatePresence initial={false}>
          {full &&
            collapseSuperseded(rest, (sid) => (sid && ag.bindings[sid] ? agentName(ag.bindings[sid].agent) : t.handoff ? agentName(t.handoff.agent) : undefined)).map((m) => "folded" in m ? (
              <Reveal key={m.id}>
                <div className="tfolded" title="这条之前没能交出去，后来已经重新交给 Agent 并有了答复">{m.text}</div>
              </Reveal>
            ) : (
              <Reveal key={m.id}>
                <Row m={m} tools={{ store, threadId: t.id }} onUndo={GUEST ? undefined : () => undoAgent(api, store, t.id, m.id)} />
              </Reveal>
            ))}
          {full && running && (
            <Reveal key="running">
              <div className="trow">
                <Avatar who="agent" />
                <div className="trow-main">
                  <div className="trow-meta"><b>Agent</b></div>
                  <span className="waiting"><i className="dot" data-tone="ok" />已交给会话里的 Agent，等它改完答复…</span>
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
          <button className="btn sm ghost" disabled={running} onClick={() => store.endHandoff(t.id)} title="以后在这条线程里的回复是普通评论，不再发给这个对话">结束交接</button>
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
            if (route.kind === "hand") void handOff(api, store, t.id, route.to, { bound: route.bound, ...(route.bound && t.handoff ? { name: t.handoff.name } : mention?.type === "session" ? { name: mention.label } : {}) });
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

function Row({ m, first, onUndo, tools }: { m: Message; first?: boolean; onUndo?: () => void; tools?: { store: ThreadStore; threadId: string } }) {
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
      {m.author === "agent" && agentKind ? <AgentAvatar kind={agentKind} size={26} /> : <Avatar who={m.author} name={other ? m.by!.name : undefined} />}
      <div className="trow-main">
        <div className="trow-meta">
          <b>{m.author === "agent" ? nameOf(agentKind) : m.author === "system" ? "系统" : other ? m.by!.name : "你"}</b>
          {other && isGuestId(m.by!.id) && !GUEST && <span className="tguest">访客</span>}
          <time>{meta}</time>
          {m.editedAt && <span className="tedited" title={`编辑于 ${new Date(m.editedAt).toLocaleString("zh-CN")}`}>已编辑</span>}
          {tools && !editing && (canEdit(m) || canDelete(m)) && (
            <span className="trow-tools">
              {canEdit(m) && (
                <button className="icon-btn xs muted" onClick={() => setEditing(true)} title="编辑" aria-label="编辑这条评论"><IconPencil size={14} /></button>
              )}
              <button className="icon-btn xs muted" onClick={() => offerUndo(tools.store.removeMessage(tools.threadId, m.id))} title="删除（可撤销）" aria-label="删除这条评论"><IconTrash size={14} /></button>
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
            {reply.undone ? (
              <span className="tundone"><IconUndo size={14} />已撤销</span>
            ) : (
              onUndo && reply.batchId && <button className="btn sm ghost" onClick={onUndo}><IconUndo size={14} />撤销这次修改</button>
            )}
          </div>
        )}
        {GUEST ? null : native ? (
          <SessionLink sessionId={m.sessionId!} turnId={m.turnId} />
        ) : turn && (
          <button className="tsession" onClick={() => ui.openSession(turn.sessionId, turn.id)}>
            在会话中查看第 {turn.n} 轮 · {turn.steps.length} 步 →
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
        在会话中查看 →
      </button>
    );
  if (inTrash)
    return (
      <button className="tsession" onClick={() => ui.openTrash(inTrash.trashId)} title="会话在回收站：恢复后这一轮照常可看">
        会话在回收站 · 恢复 →
      </button>
    );
  return <span className="tsession" data-gone>会话已删除</span>;
}

/** People and agents alike are an initial in a neutral circle; the system note is a hint icon. */
export function Avatar({ who, name }: { who: Message["author"]; name?: string }) {
  return (
    <span className="avatar" data-who={who} data-other={!!name}>
      {who === "agent" ? "A" : who === "system" ? <IconHint size={14} /> : name ? [...name.trim()][0] ?? "?" : "你"}
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
        aria-label="编辑评论"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onCancel());
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), save());
        }}
      />
      <button type="button" className="btn sm ghost" onClick={onCancel}>取消</button>
      <button type="submit" className="btn sm primary" disabled={!text.trim() || text.trim() === initial}>保存</button>
    </form>
  );
}

/** Replying to a resolved thread reopens it (the store does that; the placeholder says so). `bound`: the thread is a conversation with an agent, so the reply goes to it. */
function Reply({ onSend, resolved, bound, canvasId, handoff }: { onSend: (text: string, mention: MentionTarget | null) => void; resolved?: boolean; bound?: boolean; canvasId?: string; handoff?: Thread["handoff"] }) {
  const [text, setText] = useState("");
  const send = (t: string, mention: MentionTarget | null) => {
    onSend(t, mention);
    setText("");
  };
  const placeholder = resolved ? "回复会重新打开这条评论…" : bound ? "回复（会发给上面的对话）…" : GUEST ? "回复…" : "回复，输入 @ 交给 agent…";
  return (
    <form className="treply" onSubmit={(e) => (e.preventDefault(), text.trim() && send(text.trim(), null))}>
      <MentionField value={text} onValue={setText} onSend={send} placeholder={placeholder} canvasId={canvasId} handoff={handoff} />
      <button type="submit" className="send" disabled={!text.trim()} aria-label="发送回复"><IconSend size={14} /></button>
    </form>
  );
}

export function Composer({ names, pos, text, onText, onCancel, onSubmit, canvasId }: {
  canvasId?: string;
  names: AnchorName[];
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
  const submit = (t: string, mention: MentionTarget | null) => onSubmit(t, mention);
  return (
    <motion.form
      className="tcard composer"
      data-flip={pos.flip}
      initial={{ opacity: 0, scale: 0.92, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
      transition={SPRING}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, originX: pos.flip ? 1 : 0, originY: pos.up ? 1 : 0, borderRadius: 14 }}
      onSubmit={(e) => (e.preventDefault(), text.trim() && submit(text.trim(), null))}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="composer-head">
        <span className="composer-anchor"><span className="tcard-n new">新评论</span><AnchorTag names={names} /></span>
        <button type="button" className="icon-btn sm muted" onClick={onCancel} aria-label="取消评论" title="取消（Esc）"><IconClose size={16} /></button>
      </div>
      <div className="treply bare">
        <MentionField textareaRef={ref} value={text} onValue={onText} onSend={submit} rows={2} canvasId={canvasId} placeholder={GUEST ? "添加评论…" : "添加评论，输入 @ 交给 agent…"} />
        <button type="submit" className="send" disabled={!text.trim()} aria-label="发表评论"><IconSend size={14} /></button>
      </div>
    </motion.form>
  );
}

export function ago(at: number) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
