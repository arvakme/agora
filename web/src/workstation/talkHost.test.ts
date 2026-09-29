// 对小人说话: which view hosts the one box, where it goes, what it says while a turn runs (workstation/talk.ts).
import { describe, expect, it } from "vitest";
import { pickTalkHost, placeTalk, talkTarget, type TBox } from "./talk.ts";

describe("pickTalkHost: the view that really draws the figure hosts the one box", () => {
  const main = { id: "c1", drawn: false };
  const pane = { id: "follow:c-api", drawn: true };
  it("a figure drawn only in the follow tab: the follow tab", () => {
    expect(pickTalkHost([main, pane], null)).toBe("follow:c-api");
  });
  it("drawn in both: the main canvas", () => {
    expect(pickTalkHost([{ ...main, drawn: true }, pane], null)).toBe("c1");
  });
  it("the one that has it keeps it (the box does not jump while typing)", () => {
    expect(pickTalkHost([{ ...main, drawn: true }, pane], "follow:c-api")).toBe("follow:c-api");
  });
  it("drawn nowhere: no box at all (no hidden input holding the focus)", () => {
    expect(pickTalkHost([main, { ...pane, drawn: false }], "c1")).toBeNull();
    expect(pickTalkHost([], null)).toBeNull();
  });
  it("the previous host that no longer draws it gives it up", () => {
    expect(pickTalkHost([{ ...main, drawn: true }, { ...pane, drawn: false }], "follow:c-api")).toBe("c1");
  });
});

describe("placeTalk: under the feet, else where it covers no node", () => {
  const area: TBox = { x: 0, y: 60, w: 800, h: 500 };
  const size = { w: 232, h: 34 };
  const feet = { x: 300, y: 300 };
  it("under the feet when that is free", () => {
    expect(placeTalk({ feet, size, area, obstacles: [] })).toEqual({ x: 282, y: 309, side: "below" });
  });
  it("above the bubble when a node is under the feet", () => {
    const r = placeTalk({ feet, size, area, obstacles: [{ x: 250, y: 305, w: 300, h: 80 }] });
    expect(r.side).toBe("above");
    expect(r.y + size.h).toBeLessThan(feet.y);
  });
  it("to the right or left when above and below are taken", () => {
    const r = placeTalk({ feet, size, area, obstacles: [{ x: 250, y: 305, w: 300, h: 80 }, { x: 150, y: 120, w: 500, h: 60 }] });
    expect(["right", "left"]).toContain(r.side);
  });
  it("keeps its side while the figure walks, as long as that side is free", () => {
    const wall = [{ x: 250, y: 305, w: 300, h: 80 }];
    const first = placeTalk({ feet, size, area, obstacles: wall });
    const next = placeTalk({ feet: { x: 305, y: 300 }, size, area, obstacles: [], prev: first.side });
    expect(next.side).toBe(first.side);
  });
  it("stays inside the visible area", () => {
    const r = placeTalk({ feet: { x: 790, y: 555 }, size, area, obstacles: [] });
    expect(r.x + size.w).toBeLessThanOrEqual(area.x + area.w);
    expect(r.y + size.h).toBeLessThanOrEqual(area.y + area.h);
    const top = placeTalk({ feet: { x: 20, y: 70 }, size, area, obstacles: [{ x: 0, y: 70, w: 800, h: 400 }] });
    expect(top.y).toBeGreaterThanOrEqual(area.y);
    expect(top.x).toBeGreaterThanOrEqual(area.x);
  });
  it("everything covered: the side that covers least", () => {
    const r = placeTalk({ feet, size, area, obstacles: [{ x: 0, y: 60, w: 800, h: 500 }] });
    expect(r.side).toBeDefined();
  });
});

describe("talkTarget: whom the words go to, said from the start", () => {
  const base = { name: "Claude Code", hasSession: true, rootName: "Claude Code" };
  it("a session of its own: 「对 X 说…」, sent as is", () => {
    const t = talkTarget({ ...base, working: false });
    expect(t).toEqual({ direct: true, placeholder: "对 Claude Code 说…（回车发送）", prefix: "", note: null });
  });
  it("while a turn runs it says when the words arrive", () => expect(talkTarget({ ...base, working: true }).placeholder).toBe("对 Claude Code 说…（这一轮结束后送达）"));
  it("a worker that cannot be talked to: the box names the session it goes to and what it is about", () => {
    const t = talkTarget({ name: "T-ed3070", hasSession: false, rootName: "Claude Code", working: false });
    expect(t.direct).toBe(false);
    expect(t.placeholder).toBe("对 Claude Code 说（关于 T-ed3070）…");
    expect(t.prefix).toBe("关于你派的 T-ed3070：");
    expect(t.note).toBe("T-ed3070 是 Claude Code 派的，话会发给 Claude Code");
  });
  it("…and waits for the turn to end when one is running", () => expect(talkTarget({ name: "T-1", hasSession: false, rootName: "Pi", working: true }).placeholder).toBe("对 Pi 说（关于 T-1）…（这一轮结束后送达）"));
});
