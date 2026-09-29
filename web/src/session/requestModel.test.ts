import { describe, expect, it } from "vitest";
import { answerBody, answered, inputRightNote, modeLabel, pick, removeRequest, terminalBanner, upsertRequest, waitLabel, type HostRequest, type Question } from "./requestModel";

const q = (over: Partial<Question> = {}): Question => ({ question: "Which fruit?", header: "Fruit", multiSelect: false, options: [{ label: "Apple", description: "" }, { label: "Banana", description: "" }], ...over });
const ask = (questions: Question[]): HostRequest => ({ id: "r1", sessionId: "s", kind: "question", tool: "AskUserQuestion", at: 1, questions });

describe("question card", () => {
  it("a single choice replaces the previous one, a multi-select toggles", () => {
    let p = pick(q(), {}, "Apple");
    p = pick(q(), p, "Banana");
    expect(p).toEqual({ "Which fruit?": ["Banana"] });
    const m = q({ multiSelect: true });
    let mp = pick(m, {}, "Apple");
    mp = pick(m, mp, "Banana");
    expect(mp["Which fruit?"]).toEqual(["Apple", "Banana"]);
    expect(pick(m, mp, "Apple")["Which fruit?"]).toEqual(["Banana"]);
  });

  it("can be sent only when every question has an answer; a multi-select goes as a list", () => {
    const r = ask([q(), q({ question: "Which?", multiSelect: true })]);
    expect(answered(r, { "Which fruit?": ["Apple"] })).toBe(false);
    const full = { "Which fruit?": ["Apple"], "Which?": ["Apple", "Banana"] };
    expect(answered(r, full)).toBe(true);
    expect(answerBody(r, full)).toEqual({ decision: "allow", answers: { "Which fruit?": "Apple", "Which?": ["Apple", "Banana"] } });
  });
});

describe("open requests", () => {
  it("are added once, replaced by id, and withdrawn", () => {
    const a = ask([q()]);
    const list = upsertRequest(upsertRequest([], a), { ...a, at: 2 });
    expect(list).toHaveLength(1);
    expect(list[0].at).toBe(2);
    expect(removeRequest(list, "r1")).toEqual([]);
    expect(removeRequest(list, "nope")).toBe(list);
  });
});

describe("how long it has waited", () => {
  it("says 等你 for the first minute, then the minutes; nothing when it is not waiting", () => {
    expect(waitLabel(null, 1_000_000)).toBeNull();
    expect(waitLabel(undefined, 1_000_000)).toBeNull();
    expect(waitLabel(1_000_000 - 59_000, 1_000_000)).toBe("等你");
    expect(waitLabel(1_000_000 - 60_000, 1_000_000)).toBe("等你 1 分钟");
    expect(waitLabel(1_000_000 - 7 * 60_000 - 30_000, 1_000_000)).toBe("等你 7 分钟");
    expect(waitLabel(1_000_000 - 130 * 60_000, 1_000_000)).toBe("等你 130 分钟");
  });
});

describe("mode", () => {
  it("says auto, or that the model has no auto", () => {
    expect(modeLabel(null)).toBeNull();
    expect(modeLabel({ actual: "auto", asked: "auto" })).toEqual({ text: "auto", tone: "ok" });
    expect(modeLabel({ actual: "default", asked: "auto" })).toEqual({ text: "default（这个模型不支持 auto）", tone: "caution" });
  });
});

const term = (o: Partial<{ alive: boolean; clients: number; inputRight: "host" | "human"; paused: boolean; writers: number }> = {}) => ({ alive: true, attach: "", app: "tmux" as const, clients: 0, inputRight: "host" as const, paused: false, writers: 0, ...o });

describe("who has the input", () => {
  it("names the window when one is attached and the queue waits, with the send-now and takeover buttons", () => {
    const n = inputRightNote({ queued: 1, held: "终端里有可写的窗口连着，关掉它或改成只读后再投递", terminal: term({ clients: 1, writers: 1 }) });
    expect(n).toEqual({ text: "终端窗口开着 · 你的话在排队", by: "window", canSendNow: true, canTakeOver: true, takenOver: false });
  });
  it("a takeover the person made reads differently and offers to give it back", () => {
    const n = inputRightNote({ queued: 2, held: "终端已被人接管，归还输入权后再投递", terminal: term({ clients: 1, inputRight: "human", paused: true }) });
    expect(n).toMatchObject({ by: "takeover", takenOver: true, canSendNow: true });
    expect(n?.text).toContain("接管");
  });
  it("nothing to say when nothing waits, or nobody holds the input", () => {
    expect(inputRightNote({ queued: 0, held: null, terminal: term({ clients: 1, writers: 1 }) })).toBeNull();
    expect(inputRightNote({ queued: 1, held: null, terminal: term() })).toBeNull();
    expect(inputRightNote({ queued: 1, held: "agent 正在回复，回复完再投递", terminal: term({ clients: 0 }) })).toBeNull();
  });
  it("shows the takeover banner only while a window is really attached", () => {
    expect(terminalBanner(term({ clients: 1 }))).toBe("attached");
    expect(terminalBanner(term({ clients: 0, inputRight: "human" }))).toBe("attached"); // an explicit takeover holds (B1)
    expect(terminalBanner(term({ clients: 0 }))).toBe("background");
    expect(terminalBanner(term({ alive: false }))).toBeNull();
  });
});
