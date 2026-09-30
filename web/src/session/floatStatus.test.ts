// What the floating panel's title bar and bottom bar say about the session: 思考 / 等你 / 空闲 · how long, and the last thing it said (one line).
import { describe, expect, it } from "vitest";
import { lastSaid, statusLine } from "./floatStatus";

const now = 1_000_000_000;
const base = { running: false, busy: false, waiting: false, held: false, lastAt: null as number | null, now };

describe("statusLine", () => {
  it("working: 思考中; waiting for the person: 等你回答 (it wins over working); queued behind another turn: 排队中", () => {
    expect(statusLine({ ...base, running: true })).toEqual({ text: "思考中", tone: "work" });
    expect(statusLine({ ...base, busy: true })).toEqual({ text: "思考中", tone: "work" });
    expect(statusLine({ ...base, running: true, waiting: true })).toEqual({ text: "等你回答", tone: "wait" });
    expect(statusLine({ ...base, held: true })).toEqual({ text: "排队中", tone: "work" });
  });
  it("idle: 空闲 and how long since it last did anything", () => {
    expect(statusLine({ ...base, lastAt: now - 10_000 }).text).toBe("空闲 · 刚刚");
    expect(statusLine({ ...base, lastAt: now - 3 * 60_000 }).text).toBe("空闲 · 3 分钟");
    expect(statusLine({ ...base, lastAt: now - 2 * 3600_000 }).text).toBe("空闲 · 2 小时");
    expect(statusLine({ ...base, lastAt: now - 3 * 86400_000 }).text).toBe("空闲 · 3 天");
    expect(statusLine({ ...base, lastAt: null })).toEqual({ text: "空闲", tone: "idle" });
    expect(statusLine({ ...base, lastAt: now - 3 * 60_000 }).tone).toBe("idle");
  });
});

describe("lastSaid", () => {
  const it_ = (kind: string, text: string, at = 1) => ({ id: `${kind}${at}${text}`, kind, text, at }) as never;
  it("the agent's last words, on one line", () => {
    expect(lastSaid([it_("assistant", "第一句"), it_("tool", "ls"), it_("assistant", "画好了。\n三个节点。")])).toBe("画好了。 三个节点。");
  });
  it("falls back to what the person said last; nothing said: empty", () => {
    expect(lastSaid([it_("user", "画一张图")])).toBe("画一张图");
    expect(lastSaid([])).toBe("");
    expect(lastSaid([it_("tool", "ls")])).toBe("");
  });
  it("cards the page wrote (a dispatch receipt) are not words", () => {
    expect(lastSaid([it_("assistant", "好的"), { ...(it_("user", "已交给 X") as object), card: { kind: "receipt" } } as never])).toBe("好的");
  });
});
