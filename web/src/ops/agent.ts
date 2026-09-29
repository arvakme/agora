// A canvas comment handed to an agent.
// - handOff (the UI): an @ in the comment (comments/mention.ts) sends it to a conversation — a new one for the
//   thread, or an existing one — which edits through the agora skill and answers; the answer is posted back into
//   the thread, linked to the change it made.
// - handToAgent (the eval harness): one schema-constrained planning turn (runTurn.ts).
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { resolveAnchor } from "../canvas/anchors";
import { threadRequest } from "../canvas/context";
import { byId } from "../canvas/scene";
import { runTurn, undoTurn, type AgentOutcome } from "../session/runTurn";
import { sessions } from "../session/store";
import { agents, DISPATCH_OVER, type Binding } from "../session/agents";
import { adoptSession } from "../persist";
import type { ThreadStore } from "../comments/threads";
import { commentMessage } from "../comments/handoff";
import { runningThreads } from "../comments/handoffState";
import { threadSessionName } from "../comments/mention";
import { threadSessionTitles } from "../comments/sessionTitles";

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

/**
 * A conversation the server made (its head record is already on disk) becomes this page's, the way a session restored
 * from the trash does: the page must know the file's version, or its first save would be a conflict.
 */
async function adoptConversation(sid: string): Promise<void> {
  if (sessions.get().sessions[sid]) return;
  const snap = (await fetch("/api/project/snapshot").then((r) => (r.ok ? r.json() : null), () => null)) as { sessions?: Record<string, never>; bindings?: Record<string, Binding> } | null;
  const file = snap?.sessions?.[sid];
  if (!file) return; // it shows up when the page next loads
  const got = adoptSession(sid, file);
  const cur = sessions.get();
  sessions.hydrate({ sessions: { ...cur.sessions, ...got.sessions }, turns: { ...cur.turns, ...got.turns }, batches: { ...cur.batches, ...got.batches } });
  if (snap?.bindings?.[sid]) agents.hydrateBindings({ [sid]: snap.bindings[sid] });
}

/**
 * Hand a comment thread to an agent (comments/mention.ts decides where): an agent kind opens a new conversation
 * named after the comment, a session sid sends to that conversation. The server keeps the dispatch, binds the
 * thread to the conversation (its `handoff`) and posts the answer into the thread when the turn ends, so a reload
 * of this page loses nothing; here it starts it and shows it running.
 * `bound`: the thread was already this conversation's, so a conversation that is gone ends the hand-off.
 */
export async function handOff(api: ExcalidrawImperativeAPI, threads: ThreadStore, threadId: string, to: { sid: string } | { agent: string }, opts: { bound: boolean; name?: string }): Promise<void> {
  const thread = threads.thread(threadId)!;
  const canvasId = threads.canvasId;
  const anchors = resolveAnchor(thread.anchor, byId(api.getSceneElementsIncludingDeleted())).names.map((n) => ({ id: n.id, name: n.name }));
  const anchor = anchors.length > 1 ? `${anchors[0].name} 等 ${anchors.length} 个` : anchors[0]?.name ?? "";
  const name = opts.name ?? threadSessionName(thread.n, anchor);
  threads.setAgent(threadId, "running");
  try {
    let sent;
    try {
      sent = await agents.dispatchComment("sid" in to ? to.sid : { new: to.agent }, commentMessage(thread, anchors, { followUp: opts.bound }), { canvasId, threadId, threadN: thread.n, anchor, name });
    } catch (e) {
      const gone = opts.bound && /no agent|不在/.test((e as Error).message);
      if (gone) threads.endHandoff(threadId);
      threads.reply(threadId, { author: "system", text: gone ? "这条评论绑定的对话已经不在了，评论没有交出去。重新 @ 一个 agent 或对话。" : `没有交出去：${(e as Error).message}`, tone: "error", ...("sid" in to && { sessionId: to.sid }) });
      return;
    }
    if ("agent" in to) {
      // The server made the conversation; the page learns of it here, so its tab (named for the comment) appears now.
      const sid = sent.dispatch.target.sessionId;
      threadSessionTitles.set(sid, name);
      await adoptConversation(sid);
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
