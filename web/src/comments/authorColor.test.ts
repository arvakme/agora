// Who wrote a comment is a colour that does not change: yours is Agora's purple, everyone else's is one of a small
// set picked from their id (so it is the same after a reload and on every page). The pin, the avatar ring and the
// comment list all use it.
import { describe, expect, it } from "vitest";
import { AUTHOR_SLOTS, authorSlot, authorSlots } from "./authorColor.ts";

const me = { id: "user:zhijie" };
const slot = (id: string | undefined, viewer = me, owner = true) => authorSlot(id === undefined ? undefined : { id }, viewer, owner);

describe("authorSlot", () => {
  it("is purple for yourself, whatever your id hashes to", () => {
    expect(slot("user:zhijie")).toBe("self");
    expect(slot(undefined)).toBe("self"); // an old comment without an author is the owner's own
    expect(slot("guest:x1", { id: "guest:x1" }, false)).toBe("self"); // a guest looking at their own comment
  });

  it("is the same colour for the same author every time", () => {
    expect(slot("guest:小高")).toBe(slot("guest:小高"));
    expect(slot("guest:a3f9")).toBe(slot("guest:a3f9", { id: "guest:other" }, false)); // and for whoever is looking
  });

  it("gives different people different colours, none of them purple", () => {
    const ids = ["guest:小高", "guest:小王", "guest:a3f9", "guest:77bc", "guest:zz01", "user:lin", "user:ma", "guest:k"];
    const slots = ids.map((id) => slot(id));
    expect(slots.every((s) => typeof s === "number" && s >= 1 && s <= AUTHOR_SLOTS)).toBe(true);
    expect(new Set(slots).size).toBeGreaterThanOrEqual(4); // the spread is real: not one colour for all
    expect(slot("guest:小高")).not.toBe(slot("guest:小王"));
  });

  it("shows the owner's old comments to a guest as somebody else's, not as the guest's own", () => {
    expect(slot(undefined, { id: "guest:x1" }, false)).not.toBe("self");
  });
});

// Two guests whose ids pick the same colour by themselves (checked below: they do).
const A = "guest:g-4f2a";
const B = "guest:g-91bc";
const th = (...by: ({ id: string; name: string } | undefined)[]) => ({ messages: by.map((b, i) => ({ id: `m${i}`, author: "you" as const, text: "x", at: 100 + i, by: b })) as never });

describe("authorSlots (everyone on one canvas)", () => {
  it("keeps two people apart even when their ids alone would pick the same colour", () => {
    expect(slot(A)).toBe(slot(B));
    const m = authorSlots([th({ id: A, name: "小高" }, { id: B, name: "小王" })], me, true);
    expect(m.get(A)).not.toBe(m.get(B));
  });

  it("gives the same colours on every load, and a newcomer changes nobody's", () => {
    const before = authorSlots([th({ id: A, name: "小高" }, { id: B, name: "小王" })], me, true);
    const again = authorSlots([th({ id: A, name: "小高" }, { id: B, name: "小王" })], me, true);
    expect([...again]).toEqual([...before]);
    const later = authorSlots([th({ id: A, name: "小高" }, { id: B, name: "小王" }, { id: "guest:late", name: "晚来的" })], me, true);
    expect(later.get(A)).toBe(before.get(A));
    expect(later.get(B)).toBe(before.get(B));
  });

  it("keeps you purple and counts your old comments (no author) as yours on your own page", () => {
    const m = authorSlots([th(me as never, undefined, { id: A, name: "小高" })], { id: me.id }, true);
    expect(m.get(me.id)).toBe("self");
    expect(m.get("owner")).toBe("self");
    expect(m.get(A)).not.toBe("self");
  });

  it("ignores what an agent or the system said and what was deleted", () => {
    const t = { messages: [{ id: "a", author: "agent", text: "x", at: 1 }, { id: "b", author: "you", text: "x", at: 2, deleted: true, by: { id: A, name: "小高" } }] as never };
    expect(authorSlots([t], me, true).size).toBe(0);
  });
});
