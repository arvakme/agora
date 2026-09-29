// Resolved comments (docs/workbench-focus.md §评论): only open threads are pinned by default,
// resolved ones as quiet pins under the open ones when asked for, lost anchors never; the comment
// list groups lost anchors (open first); replying to a resolved thread reopens it.
import { describe, expect, it } from "vitest";
import type { AnchorState } from "../canvas/anchors.ts";
import { createThreadStore, setIdentity, type Thread } from "./threads.ts";
import { groupThreads, pinnable } from "./visibility.ts";

const anchor = (id: string) => ({ ids: [id], rel: { x: 0, y: 0 }, last: { x: 0, y: 0 } });
const th = (n: number, x: Partial<Thread>): Thread => ({ id: `t${n}`, n, anchor: anchor(`e${n}`), resolved: false, agent: "idle", createdAt: n, messages: [{ id: `m${n}`, author: "you", text: `#${n}`, at: n }], ...x });
// e3 and e4 are gone from the scene (lost anchors).
const resolve = (t: Thread): AnchorState => ({ point: { x: 0, y: 0 }, names: [], status: !t.anchor ? "whole" : ["e3", "e4"].includes(t.anchor.ids[0]) ? "lost" : "ok" });
const threads = [th(1, {}), th(2, { resolved: true }), th(3, { resolved: true }), th(4, {}), th(5, {})];

describe("pinnable", () => {
  it("pins open threads only by default, and never a lost anchor", () => {
    expect(pinnable(threads, resolve, false).map((t) => t.n)).toEqual([1, 5]);
  });
  it("with the toggle on, adds resolved threads — first, so the open ones sit above them", () => {
    expect(pinnable(threads, resolve, true).map((t) => t.n)).toEqual([2, 1, 5]);
  });
});

describe("groupThreads", () => {
  it("puts lost anchors in their own group, open ones first, whatever the toggle", () => {
    const g = groupThreads(threads, resolve);
    expect(g.open.map((t) => t.n)).toEqual([1, 5]);
    expect(g.resolved.map((t) => t.n)).toEqual([2]);
    expect(g.lost.map((t) => [t.n, t.resolved])).toEqual([
      [4, false],
      [3, true],
    ]);
  });
});

describe("resolving and replying", () => {
  it("records who resolved it; a person's reply reopens it; an agent's reply does not", () => {
    setIdentity({ id: "u1", name: "zhijie" });
    const st = createThreadStore("c1");
    const t = st.create(anchor("a"), "这里要改吗？");
    st.setResolved(t.id, true);
    expect(st.thread(t.id)).toMatchObject({ resolved: true, resolvedBy: { id: "u1", name: "zhijie" } });
    expect(st.thread(t.id)!.resolvedAt).toBeGreaterThan(0);
    st.reply(t.id, { author: "agent", text: "已改" });
    expect(st.thread(t.id)!.resolved).toBe(true);
    st.reply(t.id, { author: "you", text: "还有一处" });
    const after = st.thread(t.id)!;
    expect(after.resolved).toBe(false);
    expect(after.resolvedBy).toBeUndefined();
    expect(after.messages.map((m) => m.text)).toEqual(["这里要改吗？", "已改", "还有一处"]);
    setIdentity(undefined);
  });
  it("re-pins a lost thread to another element", () => {
    const st = createThreadStore("c1");
    const t = st.create(anchor("gone"), "x");
    st.reanchor(t.id, anchor("b"));
    expect(st.thread(t.id)!.anchor?.ids).toEqual(["b"]);
  });
});

describe("a comment on the whole canvas (no anchor)", () => {
  const whole = [th(6, { anchor: null }), th(7, { anchor: null, resolved: true })];
  it("is pinned to nothing, resolved toggle or not", () => {
    expect(pinnable([...threads, ...whole], resolve, true).map((t) => t.n)).toEqual([2, 1, 5]);
  });
  it("is in the comment list like any other, never among the lost", () => {
    const g = groupThreads([...threads, ...whole], resolve);
    expect(g.open.map((t) => t.n)).toEqual([1, 5, 6]);
    expect(g.resolved.map((t) => t.n)).toEqual([2, 7]);
    expect(g.lost.map((t) => t.n)).toEqual([4, 3]); // only the two whose element is gone
  });
  it("is made without an anchor, and may note the moment of the build replay it was made at", () => {
    const st = createThreadStore("c1");
    const t = st.create(null, "整体上看不错", { step: 12 });
    expect(st.thread(t.id)).toMatchObject({ anchor: null, moment: { step: 12 }, resolved: false });
    expect(st.create(null, "没有时刻").id && st.get().threads.at(-1)!.moment).toBeUndefined();
  });
});
