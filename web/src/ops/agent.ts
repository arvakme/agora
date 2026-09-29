// "交给 Agent" from a canvas comment.
// - handToSession (the UI): the comment goes to the canvas's agent session — the user's
//   own Pi / Claude Code / Codex — which edits through the agora-canvas skill and answers;
//   the answer is posted back into the thread, linked to the change it made.
// - handToAgent (the eval harness): one schema-constrained planning turn (runTurn.ts).
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { resolveAnchor } from "../canvas/anchors";
import { threadRequest } from "../canvas/context";
import { byId } from "../canvas/scene";
import { runTurn, undoTurn, type AgentOutcome } from "../session/runTurn";
import { sessions } from "../session/store";
import { agents, DISPATCH_OVER } from "../session/agents";
import { pickSession } from "../session/pickSession";
import { openSessions, ui } from "../session/ui";
import { pointerFollow } from "../pointer/follow";
import type { ThreadStore } from "../comments/threads";
import { commentMessage } from "../comments/handoff";
import { runningThreads } from "../comments/handoffState";

export { sceneIndex } from "../session/runTurn";

export async function handToAgent(api: ExcalidrawImperativeAPI, threads: ThreadStore, threadId: string): Promise<AgentOutcome & { msgId?: string }> {
  const thread = threads.thread(threadId)!;
  const session = sessions.forCanvas(threads.canvasId);
  const names = resolveAnchor(thread.anchor, byId(api.getSceneElementsIncludingDeleted())).names.map((n) => n.name);
  threads.setAgent(threadId, "running");
  try {
    const o = await runTurn({
      api,
      sessionId: session.id,
      canvasId: threads.canvasId,
      request: threadRequest(thread),
      origin: { kind: "comment", threadId, threadN: thread.n, anchor: names.length > 1 ? `${names[0]} 等 ${names.length} 个` : names[0] ?? "" },
      text: thread.messages.filter((m) => m.author === "you").at(-1)?.text ?? "",
    });
    const turn = sessions.get().turns[o.turnId];
    const msg = threads.reply(threadId, { author: turn.reply?.tone ? "system" : "agent", text: turn.reply?.text ?? "", tone: turn.reply?.tone, turnId: o.turnId });
    return { ...o, msgId: msg.id };
  } finally {
    threads.setAgent(threadId, "idle");
  }
}

/**
 * A page loaded (or reloaded) while comments are still with an agent: threads whose dispatch the server has not
 * finished show 「处理中」 again until it is over. The state is the dispatch record's, nothing is kept on the page;
 * the answer itself is posted into the thread by the server.
 */
export async function resumeRunning(threads: ThreadStore): Promise<void> {
  const ds = await agents.activeDispatches();
  const byId = new Map(ds.map((d) => [d.id, d]));
  for (const { threadId, dispatchId } of runningThreads(ds, threads.canvasId, DISPATCH_OVER)) {
    if (!threads.thread(threadId) || threads.thread(threadId)?.agent === "running") continue; // gone, or this page's own hand-off is showing it
    threads.setAgent(threadId, "running");
    void agents.waitDispatch(byId.get(dispatchId)!).then(() => threads.setAgent(threadId, "idle"));
  }
}

export function undoAgent(api: ExcalidrawImperativeAPI, threads: ThreadStore, threadId: string, msgId: string) {
  const msg = threads.thread(threadId)?.messages.find((m) => m.id === msgId);
  return msg?.turnId ? undoTurn(api, msg.turnId) : { ok: false, stale: [] };
}

/** The session a comment on this canvas would go to right now, and how many could take it (the button names the agent when several could). */
export function handTarget(canvasId: string, skip?: string[]) {
  const st = agents.get();
  return pickSession({ ids: sessions.onCanvas(canvasId).map((s) => s.id), bindings: st.bindings, status: st.status, activeAt: st.activeAt, open: openSessions.get(), focused: pointerFollow.get(), skip });
}

/**
 * `choose`: skip the automatic pick and open the chooser (a send just failed and the person said 换一个会话).
 * The comment goes to the session the person is looking at, else the most recent one that can still take a
 * message (session/pickSession.ts); none → the chooser. A failed send leaves an action in the thread that
 * opens the chooser and sends again.
 */
export async function handToSession(api: ExcalidrawImperativeAPI, threads: ThreadStore, threadId: string, opts: { choose?: boolean } = {}): Promise<void> {
  const thread = threads.thread(threadId)!;
  const canvasId = threads.canvasId;
  const anchors = resolveAnchor(thread.anchor, byId(api.getSceneElementsIncludingDeleted())).names.map((n) => ({ id: n.id, name: n.name }));
  threads.setAgent(threadId, "running");
  try {
    const sid = (opts.choose ? undefined : handTarget(canvasId).sid) ?? (await ui.chooseAgent(canvasId));
    if (!sid) {
      threads.reply(threadId, { author: "system", text: "没有选定 agent，评论没有交出去。", tone: "warn", action: "switch-session" });
      return;
    }
    const anchor = anchors.length > 1 ? `${anchors[0].name} 等 ${anchors.length} 个` : anchors[0]?.name ?? "";
    // The server keeps the dispatch and posts the answer into the thread when the turn ends, so a reload
    // of this page loses nothing; here it only starts it and shows it running.
    let sent;
    try {
      sent = await agents.dispatchComment(sid, commentMessage(thread, anchors), { canvasId, threadId, threadN: thread.n, anchor });
    } catch (e) {
      threads.reply(threadId, { author: "system", text: `没有交出去：${(e as Error).message}`, tone: "error", sessionId: sid, action: "switch-session" });
      return;
    }
    const d = await sent.done;
    // The answer arrives through the threads file; link it to the change it made (undo) once it is here.
    const turnId = d.turnIds.at(-1);
    const msgId = `m-${d.id.slice(0, 8)}`;
    if (turnId) for (let i = 0; i < 40 && !threads.thread(threadId)?.messages.some((m) => m.id === msgId); i++) await new Promise((ok) => setTimeout(ok, 250));
    if (turnId && threads.thread(threadId)?.messages.some((m) => m.id === msgId)) threads.linkTurn(threadId, msgId, turnId);
  } finally {
    threads.setAgent(threadId, "idle");
  }
}
