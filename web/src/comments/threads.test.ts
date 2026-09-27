import { describe, expect, it } from "vitest";
import { createThreadStore, type Thread } from "./threads";

const anchor = { ids: ["a"], rel: { x: 0, y: 0 }, last: { x: 0, y: 0 } };

describe("thread store merge (share guests write the same file)", () => {
  it("adds others' threads and messages, keeps this page's, takes the server's numbering", () => {
    const st = createThreadStore("c1");
    const mine = st.create(anchor, "我的评论");
    const guestThread: Thread = { id: "g1", n: 1, anchor, resolved: false, agent: "idle", createdAt: 1, messages: [{ id: "gm", author: "you", text: "访客", at: 1, by: { id: "guest:x", name: "甲" } }] };
    const changed = st.merge({
      seq: 2,
      threads: [guestThread, { ...mine, n: 2, messages: [...mine.messages, { id: "r1", author: "you", text: "访客回复", at: Date.now() + 1, by: { id: "guest:x", name: "甲" } }] }],
    });
    expect(changed).toBe(true);
    const got = st.get().threads;
    expect(got.map((t) => [t.id, t.n])).toEqual([[mine.id, 2], ["g1", 1]]);
    expect(got[0].messages.map((m) => m.text)).toEqual(["我的评论", "访客回复"]);
    expect(st.merge({ seq: 2, threads: [guestThread] })).toBe(false); // nothing new: no re-render, no echo save
  });

  it("posts human comments to the remote sink, not agent or system messages", () => {
    const sent: string[] = [];
    const st = createThreadStore("c1", undefined, { create: (t) => sent.push(`create:${t.messages[0].text}`), reply: (_id, m) => sent.push(`reply:${m.text}`) });
    const t = st.create(anchor, "hi");
    st.reply(t.id, { author: "you", text: "again" });
    st.reply(t.id, { author: "system", text: "note" });
    expect(sent).toEqual(["create:hi", "reply:again"]);
  });
});
