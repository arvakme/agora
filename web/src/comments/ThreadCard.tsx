// komo-style thread card: one element that morphs from a hover preview into the
// full thread (layout animation), with replies, agent results and actions.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { handToAgent, undoAgent } from "../ops/agent";
import type { AnchorState } from "../canvas/anchors";
import { IconAlert, IconCheck, IconClose, IconReopen, IconSend, IconSpark, IconUndo } from "../app/icons";
import type { Message, Thread, ThreadStore } from "./threads";
import { identity } from "./threads";
import { SPRING } from "./motion";
import { useTurn } from "../session/store";
import { ui } from "../session/ui";
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
  const full = mode === "full";
  const [first, ...rest] = t.messages;
  const running = t.agent === "running";
  return (
    <motion.div
      layout
      className="tcard"
      data-mode={mode}
      data-flip={pos.flip}
      role={full ? "dialog" : "tooltip"}
      aria-label={`线程 ${t.n}`}
      initial={{ opacity: 0, scale: 0.94, filter: "blur(3px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.96, filter: "blur(2px)", transition: { duration: 0.14 } }}
      transition={SPRING}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH, originX: pos.flip ? 1 : 0, originY: pos.up ? 1 : 0, borderRadius: 16 }}
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
            {!t.resolved && (
              <button className="tagent" disabled={running || st.status === "lost"} onClick={() => void handToAgent(api, store, t.id)}>
                <IconSpark size={13} /> {running ? "处理中" : "交给 Agent"}
              </button>
            )}
            <button className="tbtn" onClick={() => store.setResolved(t.id, !t.resolved)} title={t.resolved ? "重新打开" : "解决"} aria-label={t.resolved ? "重新打开" : "解决"}>
              {t.resolved ? <IconReopen size={15} /> : <IconCheck size={15} />}
            </button>
            <button className="tbtn" onClick={() => store.close()} title="关闭" aria-label="关闭"><IconClose size={15} /></button>
          </span>
        </motion.header>
      )}
      {st.status !== "ok" && full && (
        <div className="tcard-warn"><IconAlert size={13} />{st.status === "lost" ? "锚点已失效：被评论的元素已删除" : "部分锚点已失效"}</div>
      )}
      <div className="tcard-scroll">
        <Row m={first} first />
        {!full && (rest.length > 0 || running) && (
          <motion.div layout="position" className="tcard-more">
            {running ? <span className="shimmer">Agent 正在处理…</span> : `${rest.length} 条回复`}
          </motion.div>
        )}
        <AnimatePresence initial={false}>
          {full &&
            rest.map((m) => (
              <Reveal key={m.id}>
                <Row m={m} onUndo={() => undoAgent(api, store, t.id, m.id)} />
              </Reveal>
            ))}
          {full && running && (
            <Reveal key="running">
              <div className="trow">
                <Avatar who="agent" spinning />
                <div className="trow-main">
                  <div className="trow-meta"><b>Agent</b></div>
                  <span className="shimmer">正在读取画布并规划修改…</span>
                </div>
              </div>
            </Reveal>
          )}
        </AnimatePresence>
      </div>
      {full && !t.resolved && <Reply onSend={(text) => store.reply(t.id, { author: "you", text })} />}
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

function Row({ m, first, onUndo }: { m: Message; first?: boolean; onUndo?: () => void }) {
  // Agent replies are the session turn itself (one record in both places).
  const turn = useTurn(m.turnId);
  const reply = turn?.reply;
  const meta = turn ? `${(((turn.endedAt ?? Date.now()) - turn.startedAt) / 1000).toFixed(1)}s${turn.costUsd != null ? ` · $${turn.costUsd.toFixed(4)}` : ""}` : ago(m.at);
  return (
    <div className="trow" data-first={first} data-tone={reply?.tone ?? m.tone}>
      <Avatar who={m.author} />
      <div className="trow-main">
        <div className="trow-meta">
          <b>{m.author === "agent" ? "Agent" : m.author === "system" ? "系统" : m.by && m.by.id !== identity()?.id ? m.by.name : "你"}</b>
          <time>{meta}</time>
        </div>
        <p className="trow-text">{reply?.text ?? m.text}</p>
        {reply?.undoError && <p className="trow-text" data-warn>{reply.undoError}</p>}
        {reply?.changes && (
          <div className="tchanges" data-undone={!!reply.undone}>
            <ul>{reply.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            {reply.undone ? (
              <span className="tundone"><IconUndo size={12} /> 已撤销</span>
            ) : (
              onUndo && reply.batchId && <button className="tundo" onClick={onUndo}><IconUndo size={12} /> 撤销这次修改</button>
            )}
          </div>
        )}
        {turn && (
          <button className="tsession" onClick={() => ui.openSession(turn.sessionId, turn.id)}>
            在会话中查看第 {turn.n} 轮 · {turn.steps.length} 步 →
          </button>
        )}
      </div>
    </div>
  );
}

export function Avatar({ who, spinning }: { who: Message["author"]; spinning?: boolean }) {
  return (
    <span className="avatar" data-who={who} data-spinning={spinning}>
      {who === "agent" ? <IconSpark size={12} /> : who === "system" ? "!" : "你"}
    </span>
  );
}

function Reply({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <form className="treply" onSubmit={(e) => (e.preventDefault(), send())}>
      <textarea
        value={text}
        rows={1}
        placeholder="回复…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), send())}
      />
      <button type="submit" className="tsend" disabled={!text.trim()} aria-label="发送回复"><IconSend size={13} /></button>
    </form>
  );
}

export function Composer({ names, pos, text, onText, onCancel, onSubmit }: {
  names: AnchorName[];
  pos: CardPos;
  text: string;
  onText: (text: string) => void;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => text.trim() && onSubmit(text.trim());
  return (
    <motion.form
      className="tcard composer"
      data-flip={pos.flip}
      initial={{ opacity: 0, scale: 0.92, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
      transition={SPRING}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, originX: pos.flip ? 1 : 0, originY: pos.up ? 1 : 0, borderRadius: 16 }}
      onSubmit={(e) => (e.preventDefault(), submit())}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="composer-head">
        <span className="composer-anchor"><span className="tcard-n new">新评论</span><AnchorTag names={names} /></span>
        <button type="button" className="tbtn" onClick={onCancel} aria-label="取消评论" title="取消（Esc）"><IconClose size={14} /></button>
      </div>
      <div className="treply bare">
        <textarea
          ref={ref}
          value={text}
          rows={2}
          placeholder="添加评论…"
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), submit());
          }}
        />
        <button type="submit" className="tsend" disabled={!text.trim()} aria-label="发表评论"><IconSend size={13} /></button>
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
