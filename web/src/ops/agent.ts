// "交给 Agent" from a canvas comment: runs a turn in the canvas's session and links the
// thread's agent message to that turn, so the thread and the session show one record.
// The eval harness calls these two functions.
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { resolveAnchor } from "../canvas/anchors";
import { threadRequest } from "../canvas/context";
import { byId } from "../canvas/scene";
import { runTurn, undoTurn, type AgentOutcome } from "../session/runTurn";
import { sessions } from "../session/store";
import type { ThreadStore } from "../comments/threads";

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
