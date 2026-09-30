// 对小人说话: which view hosts the one box, where it goes, what it says while a turn runs (workstation/talk.ts).
import { takePageLead } from "../session/pageMessage.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, handleEvent } from "../session/agents.ts";
import { CLOSE_AFTER_MS, pickTalkHost, placeTalk, talk, talkDismissed, talkSent, talkTarget, type TBox } from "./talk.ts";

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
    expect(takePageLead(t.prefix).text).toBe("关于你派的 T-ed3070："); // (the page's mark rides in front of it: session/pageMessage.ts)
    expect(t.note).toBe("T-ed3070 是 Claude Code 派的，话会发给 Claude Code");
  });
  it("…and waits for the turn to end when one is running", () => expect(talkTarget({ name: "T-1", hasSession: false, rootName: "Pi", working: true }).placeholder).toBe("对 Pi 说（关于 T-1）…（这一轮结束后送达）"));
});

describe("talkSent: waiting for delivery does not depend on the box", () => {
  const binding = { agent: "claude" as const, model: "m", effort: "", nativeId: "n", createdAt: 1 };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    talkSent.clear("sub-run");
    talkDismissed.run = null;
    agents.forget("s9");
    vi.useRealTimers();
  });
  it("sent behind a running turn, the figure goes elsewhere (the box is gone): the note and the nod still come when the words show up", async () => {
    await handleEvent({ t: "status", sessionId: "s9", binding, running: true, busy: false, queued: 0, held: null, activity: null, error: null, terminal: { alive: false, attach: "", clients: 0, app: null } });
    talkSent.start({ runId: "sub-run", nodId: "top-run", sessionId: "s9", words: "顺便说一句", sentAt: 1000, agent: "Claude Code", state: "queued" });
    expect(talkSent.get("sub-run")).toEqual({ agent: "Claude Code", state: "queued" });
    // …the box unmounts here; nothing of the watch was in it…
    await handleEvent({ t: "transcript", sessionId: "s9", items: [{ id: "u1", kind: "user", text: "关于你派的 x：顺便说一句", at: 2000 }] });
    expect(talkSent.get("sub-run")).toEqual({ agent: "Claude Code", state: "delivered" });
    expect(talk.get()).toMatchObject({ runId: "top-run" }); // the nod
  });
  it("the delivered note goes away after a while and the box stays closed", async () => {
    await handleEvent({ t: "transcript", sessionId: "s9", items: [{ id: "u2", kind: "user", text: "在了", at: 5000 }] });
    talkSent.start({ runId: "sub-run", nodId: "top-run", sessionId: "s9", words: "在了", sentAt: 1000, agent: "Claude Code", state: "sent" });
    expect(talkSent.get("sub-run")?.state).toBe("delivered");
    vi.advanceTimersByTime(CLOSE_AFTER_MS + 10);
    expect(talkSent.get("sub-run")).toBeNull();
    expect(talkDismissed.run).toBe("sub-run");
  });
});

// ── FX9: the talk box is always whole inside the pane: narrower than the pane when the pane is narrow, and inside it wherever the figure is ──
import { fitEllipsis, talkWidth } from "./talk.ts";
describe("FX9 · the talk box inside the pane", () => {
  it("talkWidth: its own width, or the pane's (less the margins) when the pane is narrower — never under 120", () => {
    expect(talkWidth({ x: 8, y: 0, w: 1000, h: 500 }, 232)).toBe(232);
    expect(talkWidth({ x: 8, y: 0, w: 200, h: 500 }, 232)).toBe(200);
    expect(talkWidth({ x: 8, y: 0, w: 60, h: 500 }, 232)).toBe(120);
  });
  it("any pane width 320–1600, the figure anywhere (left, right, top edge, middle): the box, at its clamped width, is inside the area", () => {
    const h = 60;
    for (let w = 320; w <= 1600; w += 97) {
      const area = { x: 8, y: 110, w: w - 16, h: 600 };
      const bw = talkWidth(area, 232);
      for (const fx of [0, 10, 60, w / 2, w - 60, w - 5, w]) for (const fy of [area.y - 40, area.y + 10, 300, area.y + area.h - 5, area.y + area.h + 30]) {
        const r = placeTalk({ feet: { x: fx, y: fy }, size: { w: bw, h }, area, obstacles: [] });
        expect(r.x, `w${w} fx${fx} fy${fy}`).toBeGreaterThanOrEqual(area.x);
        expect(r.x + bw).toBeLessThanOrEqual(area.x + area.w + 1e-6);
        expect(r.y).toBeGreaterThanOrEqual(area.y);
        expect(r.y + h).toBeLessThanOrEqual(area.y + area.h + 1e-6);
      }
    }
  });
  it("without the width clamp a narrow pane cuts the box (the old behaviour): a 232 box in a 200 area runs out of it", () => {
    const area = { x: 8, y: 110, w: 200, h: 600 };
    const r = placeTalk({ feet: { x: 100, y: 300 }, size: { w: 232, h: 60 }, area, obstacles: [] });
    expect(r.x + 232).toBeGreaterThan(area.x + area.w);
  });
});

describe("FX9 · fitEllipsis: the placeholder is cut at a character, with …, never half of one", () => {
  const long = "对 Claude Code · 画出这个项目的架构…（回车发送）";
  const est = (s: string) => [...s].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.56) * 13 * 1.04, 0);
  it("fits: unchanged; does not fit: ends in … and is within the width", () => {
    expect(fitEllipsis("对 Pi 说…（回车发送）", 400)).toBe("对 Pi 说…（回车发送）");
    for (const px of [80, 120, 180, 208, 260]) {
      const r = fitEllipsis(long, px);
      expect(est(r), `${px}`).toBeLessThanOrEqual(px + 0.01);
      expect(r.endsWith("…")).toBe(true);
      expect(long.startsWith(r.slice(0, -1).trimEnd())).toBe(true);
    }
  });
  it("wider box shows more, never less", () => {
    let prev = 0;
    for (let px = 60; px < 400; px += 20) {
      const n = fitEllipsis(long, px).length;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
  it("nothing fits: just the ellipsis", () => expect(fitEllipsis("画出这个", 4)).toBe("…"));
});
