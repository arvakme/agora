// What Agora wrote into a session (a dispatch receipt, a task envelope, a comment hand-off) as a card in the
// conversation: a line saying what arrived, the first words of it, the rest on demand, and a way to the place it
// came from. Not the person's bubble, and none of what is for the agent (paths, commands, "no reply needed").
import { useEffect, useState } from "react";
import { IconChevron, IconComment, IconMessage, IconSend } from "../app/icons";
import { useAgents, type Dispatch, type Item } from "./agents";
import { cardHeading, cardPreview, type MsgCard } from "./agentMessage";
import { Markdown } from "./markdown";
import { ui } from "./ui";
import "./agentCard.css";
import { tr } from "../i18n";

export function AgoraCard({ card, open, summary, onOpenSession, onOpenComment }: {
  card: MsgCard;
  /** Start opened (the state is the card's own after that). */
  open?: boolean;
  /** A task envelope only says who and where the task file is; the task's first line comes from the dispatch record. */
  summary?: string;
  onOpenSession?: () => void;
  onOpenComment?: () => void;
}) {
  const [opened, setOpened] = useState(!!open);
  const { line, more } = cardPreview(card);
  const Icon = card.kind === "receipt" ? IconMessage : card.kind === "task" || card.kind === "page" ? IconSend : IconComment;
  const first = summary || line || (card.kind === "receipt" ? tr("（对方没有写答复）", "(No answer was written)") : "");
  return (
    <div className="ds-card" data-kind={card.kind} data-state={card.kind === "receipt" ? card.state : undefined}>
      <div className="ds-card-head">
        <Icon size={14} />
        <b>{cardHeading(card)}</b>
      </div>
      {!opened && first && <p className="ds-card-line">{first}</p>}
      {!opened && card.kind === "task" && summary && card.scope.length > 0 && <p className="ds-card-scope">{tr("范围：", "Scope: ")}{card.scope.join(tr("、", ", "))}</p>}
      {opened && (
        <div className="ds-card-body">
          {card.kind === "receipt" && (card.answer ? <Markdown text={card.answer} /> : <p>{tr("（对方没有写答复）", "(No answer was written)")}</p>)}
          {card.kind === "task" && (
            <>
              {summary && <p>{summary}</p>}
              {card.scope.length > 0 && <p className="ds-card-scope">{tr("范围：", "Scope: ")}{card.scope.join(tr("、", ", "))}</p>}
            </>
          )}
          {card.kind === "page" && <Markdown text={card.text} />}
          {card.kind === "comment" && (
            <ul>
              {card.messages.map((m, i) => (
                <li key={i}>
                  <b>{m.who}</b>
                  {m.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="ds-card-acts">
        {(more || (summary && card.kind === "task")) && (
          <button className="ds-card-act" aria-expanded={opened} onClick={() => setOpened(!opened)}>
            {opened ? tr("收起", "Collapse") : tr("展开", "Expand")}
            <IconChevron open={opened} />
          </button>
        )}
        {onOpenSession && card.kind !== "comment" && card.kind !== "page" && (
          <button className="ds-card-act" onClick={onOpenSession}>
            {card.kind === "receipt" ? (card.agent ? tr(`打开 ${card.agent} 那个会话`, `Open ${card.agent}'s session`) : tr("打开 对方 那个会话", "Open their session")) : card.from.split(" ")[0] ? tr(`打开 ${card.from.split(" ")[0]} 那个会话`, `Open ${card.from.split(" ")[0]}'s session`) : tr("打开 对方 那个会话", "Open their session")}
          </button>
        )}
        {onOpenComment && (
          <button className="ds-card-act" onClick={onOpenComment}>
            {tr("在画布上看这条评论", "View this comment on the canvas")}
          </button>
        )}
      </div>
    </div>
  );
}

const dispatchCache = new Map<string, Dispatch | null>();
/** The dispatch record behind a task envelope or a comment hand-off (its first line, the comment's canvas and thread). */
function useDispatch(id: string | undefined): Dispatch | null {
  const [d, setD] = useState<Dispatch | null>(id ? (dispatchCache.get(id) ?? null) : null);
  useEffect(() => {
    if (!id || dispatchCache.has(id)) return;
    let live = true;
    void fetch(`/api/agent/dispatches/${id}`)
      .then((r) => (r.ok ? (r.json() as Promise<Dispatch>) : null))
      .catch(() => null)
      .then((got) => {
        dispatchCache.set(id, got);
        if (live) setD(got);
      });
    return () => void (live = false);
  }, [id]);
  return d;
}

/** The card for one user message of a session, wired to the app: which sessions and threads can be opened. */
export function CardMessage({ item, card }: { item: Item; card: MsgCard }) {
  const bound = useAgents().bindings;
  const d = useDispatch(card.kind === "receipt" ? undefined : item.dispatch);
  const session = card.kind === "comment" || card.kind === "page" ? undefined : card.session;
  const canOpen = !!session && !!bound[session];
  const c = d?.source.kind === "comment" && d.source.canvasId && d.source.threadId ? { canvasId: d.source.canvasId, threadId: d.source.threadId } : null;
  const task = d?.task?.summary;
  return <AgoraCard card={card} summary={card.kind === "task" ? task : undefined} onOpenSession={canOpen ? () => ui.openSession(session!) : undefined} onOpenComment={c ? () => ui.openThread(c.canvasId, c.threadId) : undefined} />;
}
