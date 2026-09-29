// The comment box with @: typing an @ lists the agents (a new conversation for this thread) and the existing
// conversations; ↑ ↓ choose, Enter or Tab confirms, Esc closes the list. Without an @ it is a plain comment box.
// A share guest gets a plain box: they cannot reach an agent (comments/mention.ts routeMessage).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GUEST } from "../guest/mode";
import { useSessionNames } from "../multi/writes";
import { agentName, sessionKinds, useAgents } from "../session/agents";
import { applyMention, mentionOptions, mentionQuery, stillMentioned, type MentionTarget } from "./mention";

/** The agents and conversations an @ can name right now. */
function useMentionSources() {
  const ag = useAgents();
  const names = useSessionNames();
  const kinds = sessionKinds();
  const agents = kinds.map((kind) => ({ kind, name: agentName(kind) }));
  const sessions = Object.entries(ag.bindings)
    .filter(([, b]) => kinds.includes(b.agent))
    .map(([sid, b]) => ({ sid, agent: b.agent, name: names[sid] || `${agentName(b.agent)} 会话` }));
  return { agents, sessions };
}

export function MentionField({ value, onValue, onSend, placeholder, rows = 1, label, textareaRef, onEscape }: {
  value: string;
  onValue: (text: string) => void;
  /** Enter (without the list open): the text and the mention that is still in it. */
  onSend: (text: string, mention: MentionTarget | null) => void;
  placeholder: string;
  rows?: number;
  label?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  onEscape?: () => void;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? own;
  const src = useMentionSources();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const picked = useRef<MentionTarget | null>(null);
  const q = GUEST ? null : mentionQuery(value, caret);
  const options = useMemo(() => (q ? mentionOptions({ agents: src.agents, sessions: src.sessions }, q.query) : []), [q?.query, src.agents.length, src.sessions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = !!q && !closed && options.length > 0;
  useEffect(() => setActive(0), [q?.query]);
  useEffect(() => setClosed(false), [q?.start]);
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
  const send = () => value.trim() && onSend(value.trim(), stillMentioned(value, picked.current));

  return (
    <div className="mention-wrap">
      {open && rect &&
        createPortal(
          <ul
            className="mention-list"
            role="listbox"
            id={listId}
            aria-label="@ 一个 agent 或对话"
            style={{ left: rect.left, width: Math.max(rect.width, 220), ...(rect.top > 240 ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) }}
          >
            {options.map((o, i) => (
              <li
                key={o.type === "agent" ? `a:${o.kind}` : `s:${o.sid}`}
                role="option"
                aria-selected={i === active}
                data-type={o.type}
                onPointerDown={(e) => (e.preventDefault(), e.stopPropagation(), pick(o))}
                onPointerEnter={() => setActive(i)}
              >
                <span className="mention-label">{o.label}</span>
                <span className="mention-kind">{o.type === "agent" ? "新对话" : agentName(o.agent)}</span>
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
              pick(options[active]);
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
