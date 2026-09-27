// A canvas comment handed to the session's agent, as the message it receives: the thread,
// who said what, and the anchored elements by name and id (the agent reads the canvas
// itself through the agora-canvas skill).
import type { Thread } from "./threads";

export function commentMessage(thread: Pick<Thread, "n" | "messages">, anchors: { id: string; name: string }[]): string {
  const where = anchors.length ? `锚点：${anchors.map((a) => `${a.name}（${a.id}）`).join("、")}` : "锚点：整块画布";
  const lines = thread.messages.map((m) => `- ${m.author === "you" ? (m.by?.name ?? "用户") : m.author === "agent" ? "Agent" : "系统"}：${m.text}`);
  return [`画布评论 #${thread.n}（${where}）：`, ...lines, "", "请按这条评论处理画布，完成后用一两句话答复（会贴回评论线程）。"].join("\n");
}
