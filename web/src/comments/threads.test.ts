import { describe, expect, it } from "vitest";
import { createThreadStore, setIdentity, type Person, type Thread } from "./threads";

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

describe("editing and deleting comments", () => {
  const owner = { id: "mailto:o@example.com", name: "O" };
  const guestA = { id: "guest:a", name: "甲" };
  const guestB = { id: "guest:b", name: "乙" };
  const withMe = (p: Person) => (setIdentity(p), p);

  it("lets people edit and delete only their own messages; deleting can be undone once", () => {
    withMe(guestA);
    const sent: string[] = [];
    const st = createThreadStore("c1", undefined, {
      edit: (_t, m) => sent.push(`edit:${m.id}:${m.text}`),
      remove: (_t, id) => sent.push(`remove:${id}`),
      restore: (_t, m) => sent.push(`restore:${m.id}:${m.text}`),
    });
    const t = st.create(anchor, "写错了");
    const mine = t.messages[0];
    // someone else's reply arrives
    st.merge({ seq: 1, threads: [{ ...t, messages: [mine, { id: "b1", author: "you", text: "乙说", at: mine.at + 1, by: guestB }] }] });
    expect(st.edit(t.id, "b1", "冒充")).toBe(false);
    expect(st.removeMessage(t.id, "b1")).toBeNull();

    expect(st.edit(t.id, mine.id, "改好了")).toBe(true);
    const edited = st.get().threads[0].messages[0];
    expect(edited.text).toBe("改好了");
    expect(edited.editedAt).toBeGreaterThan(0);

    const undo = st.removeMessage(t.id, mine.id)!;
    expect(st.get().threads[0].messages.map((m) => m.id)).toEqual(["b1"]);
    const tomb = st.snapshot().threads[0].messages[0];
    expect(tomb).toMatchObject({ id: mine.id, deleted: true, text: "" });
    undo.run();
    expect(st.get().threads[0].messages.map((m) => m.text)).toEqual(["改好了", "乙说"]);
    expect(sent).toEqual([`edit:${mine.id}:改好了`, `remove:${mine.id}`, `restore:${mine.id}:改好了`]);
  });

  it("the owner deletes anyone's message and whole threads (orphaned ones too), with undo", () => {
    withMe(owner);
    const st = createThreadStore("c1", {
      seq: 1,
      threads: [{ id: "t1", n: 1, anchor, resolved: false, agent: "idle", createdAt: 1, messages: [{ id: "g", author: "you", text: "访客", at: 1, by: guestA }] }],
    });
    expect(st.edit("t1", "g", "x")).toBe(false); // edit stays with the author
    st.open("t1");
    const undoMsg = st.removeMessage("t1", "g")!;
    expect(st.get().threads).toEqual([]); // no visible message left: the thread disappears
    expect(st.get().activeId).toBeNull();
    undoMsg.run();
    const undo = st.removeThread("t1")!;
    expect(undo.label).toBe("已删除线程 #1");
    expect(st.get().threads).toEqual([]);
    expect(st.snapshot().threads[0]).toMatchObject({ id: "t1", n: 1, deleted: true, messages: [] });
    undo.run();
    expect(st.get().threads[0].messages[0].text).toBe("访客");
    expect(st.create(anchor, "新的").n).toBe(2); // numbers are not reused
  });

  it("a guest cannot delete whole threads", () => {
    withMe(guestA);
    const st = createThreadStore("c1");
    const t = st.create(anchor, "hi");
    expect(st.removeThread(t.id)).toBeNull();
  });

  it("merge takes later edits and deletions from the server, keeps later local ones", () => {
    withMe(owner);
    const st = createThreadStore("c1", {
      seq: 1,
      threads: [{ id: "t1", n: 1, anchor, resolved: false, agent: "idle", createdAt: 1, messages: [
        { id: "g", author: "you", text: "访客原文", at: 1, by: guestA },
        { id: "o", author: "you", text: "我改过", at: 2, by: owner, editedAt: 90, updatedAt: 90 },
      ] }],
    });
    const server = { seq: 1, threads: [{ id: "t1", n: 1, anchor, resolved: false, agent: "idle" as const, createdAt: 1, messages: [
      { id: "g", author: "you" as const, text: "访客改过", at: 1, by: guestA, editedAt: 50, updatedAt: 50 },
      { id: "o", author: "you" as const, text: "旧", at: 2, by: owner },
    ] }] };
    expect(st.merge(server)).toBe(true);
    expect(st.get().threads[0].messages.map((m) => m.text)).toEqual(["访客改过", "我改过"]);
    expect(st.merge({ seq: 1, threads: [{ ...server.threads[0], deleted: true, updatedAt: 99, messages: [] }] })).toBe(true);
    expect(st.get().threads).toEqual([]);
    expect(st.merge({ seq: 1, threads: [server.threads[0]] })).toBe(false); // an older copy doesn't bring it back
  });
});
