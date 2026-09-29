// A dispatch receipt, a task envelope and a comment hand-off are cards in the conversation: written for the person,
// without the path, the `agora dispatch status` line and the "no reply needed" that are for the agent.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { commentMessage, parseCommentMessage } from "../comments/handoff.ts";
import { AgoraCard } from "./AgoraCard";
import type { MsgCard } from "./agentMessage";

const receipt: MsgCard = { kind: "receipt", id: "7bb181c9", state: "done", agent: "Codex", session: "s-d605a5a6", answer: "改好了 server/users.py，测试过了。" };
const html = (card: MsgCard, extra: Partial<Parameters<typeof AgoraCard>[0]> = {}) => renderToStaticMarkup(<AgoraCard card={card} onOpenSession={() => {}} {...extra} />);

describe("a receipt card", () => {
  it("says who handed the task back and how it ended, with the first words of the answer", () => {
    const out = html(receipt);
    expect(out).toContain("Codex 交回了你派的任务 · 完成");
    expect(out).toContain("改好了 server/users.py，测试过了。");
  });

  it("never shows what is for the agent", () => {
    const out = html(receipt, { open: true });
    for (const inner of ["/Users/", "agora dispatch status", "不需要回复", "有下一步再做", "记录 "]) expect(out).not.toContain(inner);
  });

  it("opens the session that did the work, by its name", () => {
    expect(html(receipt)).toMatch(/<button[^>]*>打开 Codex 那个会话<\/button>/);
    expect(html(receipt, { onOpenSession: undefined })).not.toContain("打开 Codex 那个会话");
  });

  it("folds a long answer and shows all of it when opened", () => {
    const long = { ...receipt, answer: `${"前".repeat(120)}末尾的话` } as MsgCard;
    expect(html(long)).not.toContain("末尾的话");
    expect(html(long)).toContain("展开");
    expect(html(long, { open: true })).toContain("末尾的话");
  });
});

describe("the other cards", () => {
  it("a task envelope says who sent it, with the scope", () => {
    const out = html({ kind: "task", id: "1", from: "Claude 会话 s-a", session: "s-a", scope: ["server/**"] }, { summary: "把用户接口拆开" });
    expect(out).toContain("Claude 会话 s-a 派来一个任务");
    expect(out).toContain("把用户接口拆开");
    expect(out).toContain("server/**");
  });

  it("a comment hand-off is the comment, not the request sentence Agora added", () => {
    const text = commentMessage({ n: 2, messages: [{ id: "m", author: "you", text: "这个要改成蓝色", at: 1, by: { id: "u", name: "我" } } as never] }, [{ id: "o-up", name: "upload-session" }]);
    const out = html({ kind: "comment", ...parseCommentMessage(text)! });
    expect(out).toContain("画布评论 #2");
    expect(out).toContain("这个要改成蓝色");
    expect(out).not.toContain("请按这条评论处理画布");
  });
});
