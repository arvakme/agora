// What a canvas comment says about its hand-off to an agent (web/docs/workstation.md §12「交给 Agent」发给谁;
// ThreadCard.tsx, CommentLayer.tsx, CommentsDrawer.tsx read it). Pure.
import type { Dispatch } from "../session/agents";
import type { Message, Thread } from "./threads";

/** The four things a pin can say about the agent: nothing from it yet, at work, answered, the person closed the thread. */
export type PinState = "pending" | "running" | "answered" | "resolved";
export const PIN_LABEL: Record<PinState, string> = { pending: "未答复", running: "处理中", answered: "已答复", resolved: "已解决" };

const live = (m: Pick<Message, "deleted">) => !m.deleted;

/**
 * Answered = an agent's reply is the last thing said in the thread and the person has not closed it (✓ = resolved):
 * it stays until they do; a follow-up from a person, or a new run, takes it back to unanswered / running.
 * A failed hand-off (a system note) and a deleted reply are not answers.
 */
export function pinState(t: Pick<Thread, "resolved" | "agent"> & { messages: Pick<Message, "author" | "deleted">[] }): PinState {
  if (t.resolved) return "resolved";
  if (t.agent === "running") return "running";
  const last = [...t.messages].reverse().find(live);
  return last?.author === "agent" ? "answered" : "pending";
}

/**
 * The 「交给 …」 button: the agent the comment would go to right now; with several sessions the session's name too;
 * none to go to → 「交给 Agent…」 (the chooser opens); while it is running 「处理中」.
 */
export function handLabel(o: { running?: boolean; name?: string; many?: boolean; sessionName?: string }): string {
  if (o.running) return "处理中";
  if (!o.name) return "交给 Agent…";
  return `交给 ${o.name}${o.many && o.sessionName ? ` · ${o.sessionName}` : ""}`;
}

/**
 * The comment threads of one canvas that still have a hand-off the server has not finished: read from the
 * dispatch records (`GET /api/agent/dispatches?active=1`, the truth, kept in `.agora/dispatch`), so a page
 * loaded mid-run shows 「处理中」 again. `over` = the states after which nothing more is expected.
 */
export function runningThreads(ds: readonly Pick<Dispatch, "id" | "state" | "source">[], canvasId: string, over: ReadonlySet<string>): { threadId: string; dispatchId: string }[] {
  return ds
    .filter((d) => d.source.kind === "comment" && d.source.canvasId === canvasId && !!d.source.threadId && !over.has(d.state))
    .map((d) => ({ threadId: d.source.threadId!, dispatchId: d.id }));
}

/** A run of hand-off failures that a later answer replaced, as one grey line. */
export type Folded = { id: string; folded: true; text: string; count: number };

const failure = (m: Message) => m.author === "system" && !!m.tone;

/**
 * A hand-off that failed (no agent chosen, would not send, did not finish) is history once an agent has answered
 * later in the thread: those system notes before the last answer fold into one line, 「之前未交出，已重新交给 X」, X being the
 * agent that replied (`to` resolves a reply's session to its name; a plain string is the fallback name).
 * A failure with no answer after it is the current state and stays (with its 换一个会话 button).
 */
export function collapseSuperseded(messages: Message[], to?: string | ((sessionId?: string) => string | undefined)): (Message | Folded)[] {
  const lastAnswer = messages.map((m, i) => (m.author === "agent" && live(m) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  // the agent that actually answered (the last live reply), by its session — not whoever the comment would go to now
  const name = typeof to === "function" ? to(messages[lastAnswer]?.sessionId) : to;
  const out: (Message | Folded)[] = [];
  messages.forEach((m, i) => {
    if (i < lastAnswer && failure(m)) {
      const prev = out.at(-1);
      if (prev && "folded" in prev) prev.count++;
      else out.push({ id: `folded-${m.id}`, folded: true, text: `之前未交出，已重新交给 ${name ?? "Agent"}`, count: 1 });
    } else out.push(m);
  });
  return out;
}
