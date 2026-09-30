// Prompts the page wrote for the person are marked in the footer and drawn as a card with their source; the same words typed are not.
import { describe, expect, it } from "vitest";
import { cardHeading, cardLine, cardPreview, cardTurnLabel, messageCard } from "./agentMessage.ts";
import { DRAW_CHILD_MARK, FIRST_DRAW_MARK, pageFooter, pageLead, takePageLead, withPageMark } from "./pageMessage.ts";
import { talkTarget } from "../workstation/talk.ts";

describe("the mark", () => {
  it("is one token on one line, the same shape the server reads", () => {
    expect(pageFooter(FIRST_DRAW_MARK)).toBe("agora-page[画布|画出这个项目的架构]");
    const dirty = pageFooter({ source: "画布\n", title: "画] 出|这个\n项目" });
    expect(dirty).not.toMatch(/\n/);
    expect(dirty.match(/\]/g)).toHaveLength(1);
    expect(dirty.match(/\|/g)).toHaveLength(1);
  });
  it("a leading mark is taken off the text and goes to the footer; text without one is left alone", () => {
    const lead = pageLead({ source: "小人", title: "关于你派的 T-1" });
    expect(takePageLead(`${lead}关于你派的 T-1：停一下`)).toEqual({ text: "关于你派的 T-1：停一下", mark: { source: "小人", title: "关于你派的 T-1" } });
    expect(takePageLead("停一下")).toEqual({ text: "停一下" });
    expect(takePageLead(`别的话 ${lead}`)).toEqual({ text: `别的话 ${lead}` }); // only at the very start
  });
  it("a send carries the mark in its context: from the option or from a leading one; the person's own words carry none", () => {
    expect(withPageMark("画吧", "由 X", FIRST_DRAW_MARK)).toEqual({ text: "画吧", context: "由 X agora-page[画布|画出这个项目的架构]" });
    expect(withPageMark(`${pageLead({ source: "小人", title: "t" })}话`, undefined)).toEqual({ text: "话", context: "agora-page[小人|t]" });
    expect(withPageMark("我自己敲的：画出这个项目的架构", undefined)).toEqual({ text: "我自己敲的：画出这个项目的架构", context: "" });
  });
  it("the figure's prefix for a sub-agent carries the mark (the box sends prefix + words as it always did)", () => {
    const t = talkTarget({ name: "T-ed3070", hasSession: false, rootName: "Claude Code", working: false });
    const sent = withPageMark(t.prefix + "停一下", undefined);
    expect(sent.text).toBe("关于你派的 T-ed3070：停一下");
    expect(sent.context).toBe("agora-page[小人|关于你派的 T-ed3070]");
    expect(talkTarget({ name: "Claude Code", hasSession: true, rootName: "Claude Code", working: false }).prefix).toBe("");
  });
});

describe("who sends what", () => {
  it("the first-draw button and the node menu's 「让 AI 画子图」 each say where their prompt came from", () => {
    expect(pageFooter(FIRST_DRAW_MARK)).toBe("agora-page[画布|画出这个项目的架构]");
    expect(pageFooter(DRAW_CHILD_MARK)).toBe("agora-page[画布|让 AI 画子图]");
  });
  it("sending with the mark option puts it in the request's context, and only then", async () => {
    const { vi } = await import("vitest");
    const { agents } = await import("./agents.ts");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => (bodies.push(JSON.parse(init.body)), new Response(JSON.stringify({ sendId: "m1", route: "headless", how: "steer" }), { status: 200, headers: { "content-type": "application/json" } })));
    try {
      await agents.send("s-page", "把节点展开成子图", { canvasId: "c1", page: DRAW_CHILD_MARK });
      await agents.send("s-page", "把节点展开成子图", { canvasId: "c1" });
      expect(bodies[0].context).toBe("agora-page[画布|让 AI 画子图]");
      expect(bodies[1].context).toBe("");
    } finally {
      vi.unstubAllGlobals();
      agents.forget("s-page");
    }
  });
});

describe("the card", () => {
  const item = (text: string, card?: { kind: "page" | "receipt" | "task" } & Record<string, unknown>) => ({ text, source: "agora" as const, card, dispatch: undefined });
  const page = { kind: "page" as const, from: "画布", title: "画出这个项目的架构", text: "看一下这个项目，把它的整体架构画到这张图上。" };
  it("a user message the server marked is a card with its source; the person's words are not", () => {
    expect(messageCard(item(page.text, page))).toEqual(page);
    expect(messageCard(item(page.text))).toBeUndefined(); // the same words, no mark: what the person typed in Agora
    expect(messageCard({ text: page.text, source: "terminal" })).toBeUndefined();
  });
  it("says where it came from: «来自画布 · 画出这个项目的架构»", () => {
    const c = messageCard(item(page.text, page))!;
    expect(cardHeading(c)).toBe("来自画布 · 画出这个项目的架构");
    expect(cardLine(c)).toBe("来自画布 · 画出这个项目的架构");
    expect(cardTurnLabel(c)).toBe("画布发来的提示");
    expect(cardPreview(c)).toEqual({ line: page.text, more: false });
    expect(cardPreview({ ...page, text: "长".repeat(200) } as never).more).toBe(true);
  });
});
