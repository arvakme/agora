// A prompt the page wrote for the person — 「画出这个项目的架构」, 「让 AI 画子图」, the figure's 「关于你派的 X」 — is not something the person typed, but it
// goes into the session as a user message. The server reads a one-token mark at the end of the message's footer (server/canvas/agora_msg.py `page_mark`)
// and the session draws a card with its source («来自画布 · 画出这个项目的架构») instead of the person's bubble. Pure: the mark's builders live here.
export type PageMark = { source: string; title: string };

const clean = (t: string, n: number) => t.replace(/[|\][\r\n]+/g, " ").trim().slice(0, n);

/** The footer token the server reads: who wrote the prompt (画布, 小人 …) and what it is — one token on one line. */
export const pageFooter = (m: PageMark): string => `agora-page[${clean(m.source, 20)}|${clean(m.title, 80)}]`;

const LEAD = /^⟦agora-page:([^|⟧\n]{1,20})\|([^⟧\n]{1,80})⟧/;
/** A leading mark for text that is put together elsewhere (the figure's prefix): `agents.send` takes it off the text and puts it in the footer. */
export const pageLead = (m: PageMark): string => `⟦agora-page:${clean(m.source, 20)}|${clean(m.title, 80)}⟧`;

/** The text without a leading mark, and the mark (none: the text is the person's, or already plain). */
export function takePageLead(text: string): { text: string; mark?: PageMark } {
  const m = LEAD.exec(text);
  return m ? { text: text.slice(m[0].length), mark: { source: m[1], title: m[2] } } : { text };
}

/** The footer context a send carries: the mark (from the option or a leading one) after whatever context it already had. */
export function withPageMark(text: string, context: string | undefined, page?: PageMark): { text: string; context: string } {
  const lead = takePageLead(text);
  const mark = page ?? lead.mark;
  return { text: lead.text, context: [context, mark && pageFooter(mark)].filter(Boolean).join(" ") };
}

/** The first draw: the architecture button's prompt (./firstDraw.ts). */
export const FIRST_DRAW_MARK: PageMark = { source: "画布", title: "画出这个项目的架构" };

/** 「让 AI 画子图」 / 「更新子图」 on a node (../nested/NestedLayer.tsx). */
export const DRAW_CHILD_MARK: PageMark = { source: "画布", title: "让 AI 画子图" };
