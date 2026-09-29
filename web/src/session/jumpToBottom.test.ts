// 「回到最新」 (J1; ./jumpToBottom.ts): when the pill shows, how many new things it counts, when the pane follows
// new content by itself. Pure functions of the scroll metrics and the item count.
import { describe, expect, it } from "vitest";
import { FOLLOW_PX, following, jumpLabel, observe, showJump, type Metrics, type Track } from "./jumpToBottom.ts";

// a pane 600 px high showing a 3000 px transcript
const at = (fromBottom: number, height = 3000, client = 600): Metrics => ({ top: height - client - fromBottom, height, client });

describe("showJump / following: how far from the end", () => {
  it("the pill shows once the pane is scrolled more than a third of a screen (200 px of 600) off the end", () => {
    expect(showJump(at(0))).toBe(false);
    expect(showJump(at(199))).toBe(false);
    expect(showJump(at(201))).toBe(true);
    expect(showJump(at(2400))).toBe(true);
  });
  it("it follows new content only while at the end (a few px of slack); scrolled up, it does not", () => {
    expect(following(at(0))).toBe(true);
    expect(following(at(FOLLOW_PX))).toBe(true);
    expect(following(at(FOLLOW_PX + 1))).toBe(false);
    expect(following(at(400))).toBe(false);
  });
  it("a pane whose content fits is always at the end; elastic overscroll (negative distance) counts as the end", () => {
    expect(following({ top: 0, height: 500, client: 600 })).toBe(true);
    expect(showJump({ top: 0, height: 500, client: 600 })).toBe(false);
    expect(following({ top: 2410, height: 3000, client: 600 })).toBe(true);
  });
});

describe("observe: counting what arrived while the person was away", () => {
  const start: Track = { base: null };
  it("at the end nothing is unread, however much arrives; the pane follows", () => {
    const r = observe(start, at(0), 10);
    expect(r).toMatchObject({ unread: 0, follow: true, show: false, track: { base: null } });
    expect(observe(r.track, at(0), 14)).toMatchObject({ unread: 0, follow: true });
  });
  it("scrolling up remembers the count at that moment; new things after it are counted, and the pane stops following", () => {
    const left = observe(start, at(500), 10);
    expect(left).toMatchObject({ unread: 0, follow: false, show: true, track: { base: 10 } });
    const later = observe(left.track, at(500), 13);
    expect(later).toMatchObject({ unread: 3, follow: false, show: true, track: { base: 10 } });
    expect(jumpLabel(later.unread, false)).toBe("↓ 3 条新消息");
  });
  it("just a little off the end (under a third of a screen): no auto-follow, no pill — until something new arrives, then the pill says so", () => {
    const a = observe(start, at(100), 10);
    expect(a).toMatchObject({ follow: false, show: false, unread: 0 });
    const b = observe(a.track, at(100), 11);
    expect(b).toMatchObject({ follow: false, show: true, unread: 1 });
  });
  it("back at the end (scrolled or clicked): unread clears and following resumes", () => {
    const left = observe(start, at(500), 10);
    const more = observe(left.track, at(500), 12);
    const back = observe(more.track, at(0), 12);
    expect(back).toMatchObject({ unread: 0, follow: true, show: false, track: { base: null } });
    expect(observe(back.track, at(0), 15).follow).toBe(true);
  });
  it("a count that shrinks (a replay cut, a reset) never gives a negative number", () => {
    const left = observe(start, at(500), 10);
    expect(observe(left.track, at(500), 4).unread).toBe(0);
  });
});

describe("jumpLabel", () => {
  it("回到最新 ↓ when nothing is new; ↓ N 条新消息 when something is (the dot for a turn still running is drawn beside it, not in the words)", () => {
    expect(jumpLabel(0, false)).toBe("回到最新 ↓");
    expect(jumpLabel(0, true)).toBe("回到最新 ↓");
    expect(jumpLabel(1, true)).toBe("↓ 1 条新消息");
    expect(jumpLabel(12, false)).toBe("↓ 12 条新消息");
  });
});
