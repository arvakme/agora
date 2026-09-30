// What Agora wrote into a session (a receipt, a task envelope, a comment hand-off) is read as a card, not as words
// the person said; each says in a line what arrived.
import { describe, expect, it } from "vitest";
import { commentMessage } from "../comments/handoff.ts";
import { cardLine, cardPreview, cardTurnLabel, messageCard, quietReply } from "./agentMessage.ts";

const receipt = { kind: "receipt", id: "7bb181c9", state: "done", agent: "Codex", session: "s-d605a5a6", answer: "改好了 server/users.py。" } as const;

describe("messageCard", () => {
  it("is the server's card for a receipt or a task, and only for a message Agora sent", () => {
    expect(messageCard({ source: "agora", card: receipt, text: "" })).toEqual(receipt);
    expect(messageCard({ source: "terminal", card: receipt, text: "" })).toBeUndefined();
    expect(messageCard({ source: "agora", text: "你好" })).toBeUndefined();
  });

  it("reads a comment hand-off (the text commentMessage writes) once it came as a dispatch", () => {
    const text = commentMessage({ n: 2, messages: [{ id: "m", author: "you", text: "这个要改成蓝色", at: 1, by: { id: "u", name: "我" } } as never] }, [{ id: "o-up", name: "upload-session" }]);
    const card = messageCard({ source: "agora", dispatch: "d-1", text });
    expect(card).toMatchObject({ kind: "comment", n: 2, followUp: false, anchors: [{ id: "o-up", name: "upload-session" }], messages: [{ who: "我", text: "这个要改成蓝色" }] });
    expect(messageCard({ source: "agora", text })).toBeUndefined(); // the person typed those words themselves
  });
});

describe("what a card says", () => {
  it("names who handed the task back and how it ended", () => {
    expect(cardLine(receipt as never)).toBe("Codex 交回了你派的任务 · 完成");
    expect(cardLine({ ...receipt, state: "idle_no_reply" } as never)).toBe("Codex 交回了你派的任务 · 结束了，没有交回执");
    expect(cardTurnLabel(receipt as never)).toBe("收到回执");
    expect(cardTurnLabel({ kind: "task", id: "1", from: "Claude 会话 s-a", scope: [] })).toBe("收到任务");
  });

  it("previews the first words and says when there is more to open", () => {
    expect(cardPreview({ ...receipt, answer: "短" } as never)).toEqual({ line: "短", more: false });
    const long = cardPreview({ ...receipt, answer: "长".repeat(200) } as never);
    expect(long.more).toBe(true);
    expect(long.line.length).toBeLessThan(100);
    expect(cardPreview({ ...receipt, answer: "第一行\n第二行" } as never)).toEqual({ line: "第一行 第二行", more: true });
  });
});

describe("quietReply", () => {
  const turn = (text: string, tools = 0) => ({ reply: { text }, steps: [{ n: 1, records: Array.from({ length: tools }, () => ({ kind: "tool" })) }] });
  it("a short acknowledgement with no work behind it is quiet; an answer that did work is not", () => {
    expect(quietReply(turn("这条回执是通知，不再回复。"))).toBe(true);
    expect(quietReply(turn("这条回执是通知，不再回复。", 2))).toBe(false);
    expect(quietReply(turn("长".repeat(300)))).toBe(false);
  });
});
