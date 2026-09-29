// The comment box with @: typing an @ lists a few choices (the thread's own conversation, the recommended new
// conversation, the two most recent conversations on this canvas, 「更多」); typing after it searches every agent and every
// conversation that can take a message. ↑ ↓ choose, Enter or Tab confirms, Esc closes the list. Without an @ it is a plain
// comment box. A share guest gets a plain box: they cannot reach an agent (comments/mention.ts routeMessage).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GUEST } from "../guest/mode";
import { useSessionNames } from "../multi/writes";
import { agentName, sessionKinds, useAgents } from "../session/agents";
import { sessions, useSessions } from "../session/store";
import "../session/recommend.css";
import { applyMention, MENTION_LIST_CLASS, mentionQuery, mentionRows, submitMention, type MentionRow, type MentionSources, type MentionTarget } from "./mention";
import { topicOf } from "../workspace/model";
import type { Thread } from "./threads";

/** Room for eight rows (a row is 29.4px, the list has 4px padding, comments/handoff.css); a longer list scrolls. */
const ROW_PX = 29.4;
const LIST_PAD_PX = 8;
const VISIBLE_ROWS = 8;

/** The agents and conversations an @ can name right now, and where the person is (`canvasId`, the thread's conversation). */
function useMentionSources(canvasId: string | undefined, handoff: Thread["handoff"]): MentionSources {
  const ag = useAgents();
  const names = useSessionNames();
  const ss = useSessions();
  return useMemo(() => {
    const kinds = sessionKinds();
    return {
      agents: kinds.map((kind) => ({ kind, name: agentName(kind) })),
      bindings: Object.fromEntries(Object.entries(ag.bindings).filter(([, b]) => kinds.includes(b.agent))),
      status: ag.status,
      activeAt: ag.activeAt,
      names,
      topics: Object.fromEntries(Object.keys(ag.bindings).flatMap((sid) => { const t = topicOf(ag.items[sid]?.find((it) => it.kind === "user" && it.text)?.text); return t ? [[sid, t]] : []; })),
      canvas: canvasId ? sessions.onCanvas(canvasId).map((s) => s.id) : undefined,
      handoff,
      now: Date.now(),
    };
  }, [ag.bindings, ag.status, ag.activeAt, ag.items, names, ss.sessions, canvasId, handoff]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function MentionField({ value, onValue, onSend, placeholder, rows = 1, label, textareaRef, onEscape, canvasId, handoff, pickedRef }: {
  value: string;
  onValue: (text: string) => void;
  /** Enter (without the list open): the text and the mention that is still in it. */
  onSend: (text: string, mention: MentionTarget | null) => void;
  placeholder: string;
  rows?: number;
  label?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onEscape?: () => void;
  /** The canvas the comment is on: the recent conversations are the ones working on it. Unknown = all conversations. */
  canvasId?: string;
  /** The conversation this thread is bound to: offered first. */
  handoff?: Thread["handoff"];
  /**
   * Where the pick made in the list is kept. The form around the box owns it, so its send button carries the same pick as Enter
   * does (a button that read no pick sent every @ to the thread's bound conversation, MT1).
   */
  pickedRef?: React.MutableRefObject<MentionTarget | null>;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? own;
  const src = useMentionSources(canvasId, handoff);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const ownPick = useRef<MentionTarget | null>(null);
  const picked = pickedRef ?? ownPick;
  const q = GUEST ? null : mentionQuery(value, caret);
  const [expanded, setExpanded] = useState(false);
  const options = useMemo(() => (q ? mentionRows(src, q.query, expanded) : []), [src, q?.query, expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = !!q && !closed && options.length > 0;
  useEffect(() => setActive(0), [q?.query]);
  useEffect(() => (setClosed(false), setExpanded(false)), [q?.start]);
  // The list is drawn on the body, at the box's place: the card around the box clips and scales what is inside it.
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (open) setRect(ref.current?.getBoundingClientRect() ?? null);
  }, [open, value]);
  const listId = useRef(`mention-${Math.random().toString(36).slice(2, 8)}`).current;

  const pick = (t: MentionTarget) => {
    if (!q) return;
    const next = applyMention(value, q, t);
    picked.current = t;
    onValue(next.text);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };
  // 「更多」 opens the whole list where it is; everything else is a mention.
  const choose = (r: MentionRow) => ("more" in r ? (setExpanded(true), setActive(0)) : pick(r.target));
  const send = () => {
    const s = submitMention(value, picked.current);
    if (s) (onSend(s.text, s.mention), (picked.current = null));
  };

  return (
    <div className="mention-wrap">
      {open && rect &&
        createPortal(
          <ul
            className={MENTION_LIST_CLASS}
            role="listbox"
            id={listId}
            aria-label="@ 一个 agent 或对话"
            style={{ left: rect.left, width: Math.max(rect.width, 220), maxHeight: ROW_PX * VISIBLE_ROWS + LIST_PAD_PX, ...(rect.top > 240 ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) }}
          >
            {options.map((o, i) => (
              <li
                key={"more" in o ? "more" : o.target.type === "agent" ? `a:${o.target.kind}` : `s:${o.target.sid}`}
                ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                role="option"
                aria-selected={i === active}
                data-type={"more" in o ? "more" : o.target.type}
                title={o.title}
                onPointerDown={(e) => (e.preventDefault(), e.stopPropagation(), choose(o))}
                onPointerEnter={() => setActive(i)}
              >
                <span className="mention-label">{o.title}</span>
                {"more" in o ? null : (
                  <span className="mention-kind">
                    {o.badge && <i className="rec-tag">{o.badge}</i>}
                    {o.note}
                  </span>
                )}
              </li>
            ))}
          </ul>,
          document.body,
        )}
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-label={label}
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        onChange={(e) => (onValue(e.target.value), setCaret(e.target.selectionStart ?? e.target.value.length))}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              choose(options[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setClosed(true);
            }
            return;
          }
          if (e.key === "Escape" && onEscape) return onEscape();
          if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), send());
        }}
      />
    </div>
  );
}
