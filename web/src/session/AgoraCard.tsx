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
  const Icon = card.kind === "receipt" ? IconMessage : card.kind === "task" ? IconSend : IconComment;
  const first = summary || line || (card.kind === "receipt" ? "（对方没有写答复）" : "");
  return (
    <div className="ds-card" data-kind={card.kind} data-state={card.kind === "receipt" ? card.state : undefined}>
      <div className="ds-card-head">
        <Icon size={14} />
        <b>{cardHeading(card)}</b>
      </div>
      {!opened && first && <p className="ds-card-line">{first}</p>}
      {!opened && card.kind === "task" && summary && card.scope.length > 0 && <p className="ds-card-scope">范围：{card.scope.join("、")}</p>}
      {opened && (
        <div className="ds-card-body">
          {card.kind === "receipt" && (card.answer ? <Markdown text={card.answer} /> : <p>（对方没有写答复）</p>)}
          {card.kind === "task" && (
            <>
              {summary && <p>{summary}</p>}
              {card.scope.length > 0 && <p className="ds-card-scope">范围：{card.scope.join("、")}</p>}
            </>
          )}
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
            {opened ? "收起" : "展开"}
            <IconChevron open={opened} />
          </button>
        )}
        {onOpenSession && card.kind !== "comment" && (
          <button className="ds-card-act" onClick={onOpenSession}>
            打开 {card.kind === "receipt" ? (card.agent ?? "对方") : (card.from.split(" ")[0] || "对方")} 那个会话
          </button>
        )}
        {onOpenComment && (
          <button className="ds-card-act" onClick={onOpenComment}>
            在画布上看这条评论
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
  const session = card.kind === "comment" ? undefined : card.session;
  const canOpen = !!session && !!bound[session];
  const c = d?.source.kind === "comment" && d.source.canvasId && d.source.threadId ? { canvasId: d.source.canvasId, threadId: d.source.threadId } : null;
  const task = d?.task?.summary;
  return <AgoraCard card={card} summary={card.kind === "task" ? task : undefined} onOpenSession={canOpen ? () => ui.openSession(session!) : undefined} onOpenComment={c ? () => ui.openThread(c.canvasId, c.threadId) : undefined} />;
}
