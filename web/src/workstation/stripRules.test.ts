// The strip when nothing is at work, and a lane's name (workstation/stripRules.ts).
import { describe, expect, it } from "vitest";
import { idleStrip, laneLabel, yieldView } from "./stripRules.ts";

describe("idleStrip", () => {
  it("no agent has ever worked: says so and offers 「新建会话」", () => {
    expect(idleStrip({ runs: 0, busy: 0, waiting: 0 })).toEqual({ text: "还没有 agent 在干活", newSession: true });
  });
  it("all idle: keeps its own words (都空闲了 N 分) and offers it too", () => {
    expect(idleStrip({ runs: 2, busy: 0, waiting: 0 })).toEqual({ text: null, newSession: true });
  });
  it("someone works or waits: no button", () => {
    expect(idleStrip({ runs: 2, busy: 1, waiting: 0 }).newSession).toBe(false);
    expect(idleStrip({ runs: 2, busy: 0, waiting: 1 }).newSession).toBe(false);
  });
});

describe("laneLabel: name and one mark; the actions come with hover or focus", () => {
  it("at rest: no actions shown", () => {
    expect(laneLabel({ traced: false, hasSession: true, sub: false, hover: false, focus: false })).toMatchObject({ mark: null, showActs: false });
  });
  it("traced: one mark (追踪中), not a row of buttons", () => {
    const l = laneLabel({ traced: true, hasSession: true, sub: false, hover: false, focus: false });
    expect(l.mark).toBe("trace");
    expect(l.showActs).toBe(false);
  });
  it("hover or focus brings the actions: 打开会话 (top-level with a session), 追踪 / 退出追踪, 跟随", () => {
    expect(laneLabel({ traced: false, hasSession: true, sub: false, hover: true, focus: false })).toMatchObject({ acts: ["session", "trace", "follow"], showActs: true });
    expect(laneLabel({ traced: true, hasSession: true, sub: false, hover: false, focus: true })).toMatchObject({ acts: ["session", "untrace", "follow"], showActs: true });
    expect(laneLabel({ traced: false, hasSession: false, sub: true, hover: true, focus: false }).acts).toEqual(["trace", "follow"]);
  });
});

describe("yieldView: the opened strip takes height, the canvas lets the diagram keep clear of the bars", () => {
  const pane = { w: 900, h: 600 };
  const occupied = { top: 100, right: 0, bottom: 64, left: 0 };
  const view = { zoom: 1, scrollX: 0, scrollY: 0 };
  it("the diagram's lower part is under the bottom bars: a view that fits it, not zoomed in", () => {
    const f = yieldView({ view, pane, occupied, bounds: { x: 50, y: 120, w: 700, h: 470 } });
    expect(f).not.toBeNull();
    expect(f!.zoom).toBeLessThanOrEqual(1);
    const bottom = (120 + 470 + f!.scrollY) * f!.zoom;
    expect(bottom).toBeLessThanOrEqual(pane.h - occupied.bottom);
  });
  it("everything already clear of the bars: left alone", () => {
    expect(yieldView({ view, pane, occupied, bounds: { x: 50, y: 120, w: 700, h: 300 } })).toBeNull();
  });
});
