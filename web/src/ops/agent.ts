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
import { agents } from "../session/agents";
import { pickSession } from "../session/pickSession";
import { openSessions, ui } from "../session/ui";
import { pointerFollow } from "../pointer/follow";
import type { ThreadStore } from "../comments/threads";
import { commentMessage } from "../comments/handoff";

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
    let r;
    try {
      r = await agents.send(sid, commentMessage(thread, anchors), { canvasId, context: `这条消息来自画布评论 #${thread.n}。`, thread: { threadId, threadN: thread.n, anchor } });
    } catch (e) {
      threads.reply(threadId, { author: "system", text: `没有交出去：${(e as Error).message}`, tone: "error", sessionId: sid, action: "switch-session" });
      return;
    }
    const d = await r.done;
    const turnId = d.turnIds.at(-1);
    if (d.error) threads.reply(threadId, { author: "system", text: `Agent 没有完成：${d.error}`, tone: "error", sessionId: sid, turnId });
    else threads.reply(threadId, { author: "agent", text: d.text.trim() || "（Agent 没有文字答复）", sessionId: sid, turnId });
  } finally {
    threads.setAgent(threadId, "idle");
  }
}
