// Transcript items → turns / steps / records, the process title, usage and the timeline.
import { describe, expect, it } from "vitest";
import type { Item } from "./agents.ts";
import { buildTurns, deriveTimeline, filesOf, processTitle, sumUsage } from "./trajectoryModel.ts";

const u = (id: string, at: number, inputTokens: number, outputTokens: number, costUsd: number | null = null, model = "claude-opus-5-5"): Item => ({
  id,
  kind: "usage",
  at,
  usage: { model, inputTokens, outputTokens, cacheReadTokens: 100, cacheWriteTokens: null, costUsd },
});

const ITEMS: Item[] = [
  { id: "u1", kind: "user", text: "改 server", at: 1000, source: "agora" },
  { id: "a1", kind: "assistant", text: "先看看", at: 2000, msg: "m1" },
  { id: "t1", kind: "tool", at: 2100, endAt: 2600, msg: "m1", tool: { name: "Read", input: "server/app.py", args: "{}", output: "…" } },
  u("u-m1", 2000, 10, 20),
  { id: "t2", kind: "tool", at: 3000, endAt: 3100, msg: "m2", tool: { name: "Edit", input: "server/app.py", output: "ok", files: [{ path: "server/app.py", op: "edit" }] } },
  { id: "t3", kind: "tool", at: 3050, endAt: 3150, msg: "m2", tool: { name: "Write", input: "x", output: "denied", isError: true, files: [{ path: "x.md", op: "write" }] } },
  u("u-m2", 3000, 5, 7),
  { id: "a2", kind: "assistant", text: "改好了", at: 4000, msg: "m3" },
  { id: "end-u1", kind: "end", at: 4100, durationMs: 3100, turn: "u1" },
  { id: "run-1", kind: "run", at: 4200, usage: { model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25, durationMs: 3300 } },
  { id: "c1", kind: "context", at: 9000, model: "sonnet", effort: "low" },
  { id: "u2", kind: "user", text: "终端里问", at: 10_000, source: "terminal" },
  { id: "t4", kind: "tool", at: 10_500, tool: { name: "Bash", input: "npm test" } },
];

describe("buildTurns", () => {
  const turns = buildTurns(ITEMS, { model: "opus", effort: "high" }, true);
  it("turns, steps by model message, records numbered across the session", () => {
    expect(turns.map((t) => t.n)).toEqual([1, 2]);
    const [t1] = turns;
    expect(t1.steps.map((s) => s.n)).toEqual([0, 1, 2, 3]);
    expect(t1.steps[1].records.map((r) => r.id)).toEqual(["a1", "t1"]);
    expect(t1.steps[2].records.map((r) => r.kind)).toEqual(["tool", "tool"]);
    expect(t1.steps[2].description).toMatch(/Edit Write$/);
    expect(turns[1].steps[1].records[0].index).toBe(8);
  });
  it("usage from the log, cost from the runner, durations as recorded", () => {
    const [t1, t2] = turns;
    expect(t1.usage.input).toBe(15);
    expect(t1.usage.output).toBe(27);
    expect(t1.usage.cost).toBe(0.25); // the log has no cost; the runner's result does
    expect(t1.durationMs).toBe(3100);
    expect(t1.model).toBe("claude-opus-5-5");
    expect(t1.effort).toBe("high");
    expect(t2.model).toBe("sonnet");
    expect(t2.effort).toBe("low");
    expect(t2.usage.input).toBeNull(); // nothing recorded, nothing made up
    expect(t2.running).toBe(true);
    expect(t2.durationMs).toBeNull();
    expect(sumUsage(turns).cost).toBe(0.25);
  });
  it("reply, activity and files (failed writes do not count)", () => {
    const [t1, t2] = turns;
    expect(t1.reply?.id).toBe("a2");
    expect(t2.reply).toBeUndefined();
    expect(processTitle(t1.activity)).toBe("已读取文件，修改了文件，已写入文件");
    expect(filesOf(turns)).toEqual([{ path: "server/app.py", op: "edit", at: 3000, toolId: "t2", turn: 1 }]);
    expect(t2.steps[1].records[0].running).toBe(true);
  });
});

describe("processTitle", () => {
  it("one, two (shared 已), more", () => {
    expect(processTitle([])).toBe("已完成分析");
    expect(processTitle([{ kind: "read", count: 2 }, { kind: "search", count: 1 }])).toBe("已读取文件并搜索代码");
    expect(processTitle([{ kind: "edit", count: 3 }, { kind: "commands", count: 2 }, { kind: "read", count: 1 }, { kind: "tools", count: 1 }])).toBe("修改了文件，执行了命令，已读取文件等");
  });
});

describe("deriveTimeline", () => {
  const turns = buildTurns(ITEMS, {}, false);
  it("sequence: one slot per record, turn boundaries", () => {
    const m = deriveTimeline(turns, "sequence")!;
    expect(m.spans.length).toBe(8);
    expect(m.turnBoundaries).toEqual([{ turn: 1, at: 0 }, { turn: 2, at: 6 }]);
  });
  it("duration: idle gaps between records removed", () => {
    const m = deriveTimeline(turns, "duration")!;
    const u2 = m.spans.find((s) => s.turn === 2 && s.kind === "user")!;
    expect(u2.start - m.start).toBeLessThan(10_000 - 1000);
    expect(m.spans.find((s) => s.index === 3)!.end - m.spans.find((s) => s.index === 3)!.start).toBe(500);
  });
});
